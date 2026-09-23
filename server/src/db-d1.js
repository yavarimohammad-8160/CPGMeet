/**
 * Sync Cloudflare D1 client for CPGMeet.
 * Uses child_process.spawnSync + curl so callers keep db.prepare().get/all/run sync.
 * Env (set on Render): CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, D1_DATABASE_ID
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_D1_DATABASE_ID = "8beb7478-736d-4246-848e-47575e41ff6b";

function sanitizeBindValue(v) {
  if (v === undefined) return null;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "boolean") return v ? 1 : 0;
  return v;
}

function normalizeArgs(args) {
  if (!args.length) return null;
  if (args.length === 1 && Array.isArray(args[0])) {
    return args[0].map(sanitizeBindValue);
  }
  const first = args[0];
  if (
    first &&
    typeof first === "object" &&
    !Array.isArray(first) &&
    !(first instanceof Date) &&
    !Buffer.isBuffer(first)
  ) {
    const mapped = {};
    for (const [k, v] of Object.entries(first)) {
      const key = /^[@:$]/.test(k) ? k.slice(1) : k;
      mapped[key] = sanitizeBindValue(v);
    }
    return mapped;
  }
  return args.map(sanitizeBindValue);
}

/**
 * Convert named placeholders (@name / :name / $name) + object params to positional ?.
 * Leaves ? placeholders alone when params is already an array.
 */
export function toPositional(sql, params) {
  if (params == null) return { sql, params: [] };
  if (Array.isArray(params)) return { sql, params: params.map(sanitizeBindValue) };

  const values = [];
  const outSql = sql.replace(/[@:$]([a-zA-Z_][a-zA-Z0-9_]*)/g, (_m, name) => {
    if (!Object.prototype.hasOwnProperty.call(params, name)) {
      throw new Error(`D1 named param missing: ${name}`);
    }
    values.push(sanitizeBindValue(params[name]));
    return "?";
  });
  return { sql: outSql, params: values };
}

/** Split SQL on semicolons outside single quotes (for db.exec multi-statement). */
export function splitStatements(sql) {
  const stmts = [];
  let cur = "";
  let inSingle = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === "'") {
      if (inSingle && sql[i + 1] === "'") {
        cur += "''";
        i++;
        continue;
      }
      inSingle = !inSingle;
      cur += c;
      continue;
    }
    if (c === ";" && !inSingle) {
      const t = cur.trim();
      if (t) stmts.push(t);
      cur = "";
      continue;
    }
    cur += c;
  }
  const t = cur.trim();
  if (t) stmts.push(t);
  return stmts;
}

function coerceValue(v) {
  if (typeof v === "bigint") return Number(v);
  return v;
}

function coerceRow(row) {
  if (!row) return undefined;
  const out = {};
  for (const [k, v] of Object.entries(row)) out[k] = coerceValue(v);
  return out;
}

function tmpName(prefix) {
  return path.join(os.tmpdir(), `${prefix}-${crypto.randomBytes(8).toString("hex")}.json`);
}

/**
 * POST one SQL statement to D1 HTTP API via curl (body in temp file — no shell escaping).
 */
function d1HttpQuery({ accountId, apiToken, databaseId, sql, params }) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`;
  const bodyPath = tmpName("d1-body");
  const outPath = tmpName("d1-out");
  try {
    fs.writeFileSync(bodyPath, JSON.stringify({ sql, params }), "utf8");
    const proc = spawnSync(
      "curl",
      [
        "-sS",
        "-X",
        "POST",
        url,
        "-H",
        `Authorization: Bearer ${apiToken}`,
        "-H",
        "Content-Type: application/json",
        "--data-binary",
        `@${bodyPath}`,
        "-o",
        outPath,
        "-w",
        "%{http_code}"
      ],
      { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 }
    );
    if (proc.error) {
      throw new Error(`D1 curl failed to start: ${proc.error.message}`);
    }
    if (proc.status !== 0) {
      const errTail = (proc.stderr || "").trim().slice(0, 500);
      throw new Error(`D1 curl exit ${proc.status}${errTail ? `: ${errTail}` : ""}`);
    }
    const httpCode = String(proc.stdout || "").trim();
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(outPath, "utf8"));
    } catch (e) {
      throw new Error(`D1 invalid JSON response (HTTP ${httpCode}): ${e.message}`);
    }
    if (httpCode && httpCode !== "200") {
      const msg =
        parsed?.errors?.[0]?.message ||
        parsed?.error ||
        JSON.stringify(parsed).slice(0, 400);
      throw new Error(`D1 HTTP ${httpCode}: ${msg}`);
    }
    if (!parsed?.success) {
      const msg =
        parsed?.errors?.[0]?.message ||
        JSON.stringify(parsed?.errors || parsed).slice(0, 400);
      throw new Error(`D1 query failed: ${msg}`);
    }
    const block = Array.isArray(parsed.result) ? parsed.result[0] : parsed.result;
    return {
      results: Array.isArray(block?.results) ? block.results.map(coerceRow) : [],
      meta: block?.meta || {}
    };
  } finally {
    try {
      fs.unlinkSync(bodyPath);
    } catch {
      /* ignore */
    }
    try {
      fs.unlinkSync(outPath);
    } catch {
      /* ignore */
    }
  }
}

export function createD1Db({
  accountId = process.env.CLOUDFLARE_ACCOUNT_ID,
  apiToken = process.env.CLOUDFLARE_API_TOKEN,
  databaseId = process.env.D1_DATABASE_ID || DEFAULT_D1_DATABASE_ID
} = {}) {
  if (!accountId || !apiToken) {
    throw new Error("createD1Db requires CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN");
  }

  const cfg = { accountId, apiToken, databaseId };

  function query(sql, args) {
    const normalized = normalizeArgs(args || []);
    const { sql: posSql, params } = toPositional(sql, normalized);
    return d1HttpQuery({ ...cfg, sql: posSql, params });
  }

  function prepare(sql) {
    return {
      get(...args) {
        const { results } = query(sql, args);
        return results[0];
      },
      all(...args) {
        const { results } = query(sql, args);
        return results;
      },
      run(...args) {
        const { meta } = query(sql, args);
        return {
          lastInsertRowid: Number(meta.last_row_id ?? 0),
          changes: Number(meta.changes ?? 0)
        };
      }
    };
  }

  function exec(sql) {
    for (const stmt of splitStatements(sql)) {
      d1HttpQuery({ ...cfg, sql: stmt, params: [] });
    }
  }

  return {
    db: {
      prepare,
      exec,
      pragma() {}
    },
    dbPath: `d1:${databaseId}`,
    flushDb() {
      return `d1:${databaseId}`;
    }
  };
}

export { DEFAULT_D1_DATABASE_ID };
