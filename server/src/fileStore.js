/**
 * Durable attachment storage for CPGMeet.
 *
 * Render free instances have an ephemeral disk that is wiped on every restart /
 * spin-down (many times per day), so bytes are stored in the DB as base64
 * chunks (table meeting_file_chunks). In production that DB is Cloudflare D1
 * (free tier), queried here with async fetch so big transfers never block the
 * event loop. Locally (sql.js) the sync db is used.
 */
import { db, d1Config } from "./db.js";

export const CHUNK_BYTES = 1024 * 1024; // 1 MiB raw -> ~1.4 MB base64 (D1 row limit 2 MB)
const CONCURRENCY = 4;
export const DB_STORAGE_PREFIX = "db:";

async function d1Query(sql, params = []) {
  const { accountId, apiToken, databaseId } = d1Config;
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`;
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ sql, params })
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) {
        const msg = data?.errors?.[0]?.message || `HTTP ${res.status}`;
        throw new Error(`D1 file query failed: ${msg}`);
      }
      const block = Array.isArray(data.result) ? data.result[0] : data.result;
      return block?.results || [];
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  throw lastErr;
}

async function query(sql, params = []) {
  if (d1Config) return d1Query(sql, params);
  if (/^\s*select/i.test(sql)) return db.prepare(sql).all(...params);
  db.prepare(sql).run(...params);
  return [];
}

async function runPool(count, worker) {
  let next = 0;
  const runners = Array.from({ length: Math.min(CONCURRENCY, count) }, async () => {
    while (next < count) {
      const i = next++;
      await worker(i);
    }
  });
  await Promise.all(runners);
}

export function chunkCount(size) {
  return Math.max(1, Math.ceil(Number(size || 0) / CHUNK_BYTES));
}

/** Store a Buffer as chunks for fileId. Throws on failure (caller cleans up). */
export async function putFileBytes(fileId, buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const n = chunkCount(buf.length);
  await query("DELETE FROM meeting_file_chunks WHERE file_id = ?", [Number(fileId)]);
  await runPool(n, async (seq) => {
    const part = buf.subarray(seq * CHUNK_BYTES, (seq + 1) * CHUNK_BYTES);
    await query("INSERT INTO meeting_file_chunks (file_id, seq, data) VALUES (?, ?, ?)", [
      Number(fileId),
      seq,
      part.toString("base64")
    ]);
  });
  const rows = await query("SELECT COUNT(*) AS n FROM meeting_file_chunks WHERE file_id = ?", [Number(fileId)]);
  if (Number(rows?.[0]?.n || 0) !== n) throw new Error("chunk_count_mismatch");
  return n;
}

export async function countFileChunks(fileId) {
  const rows = await query("SELECT COUNT(*) AS n FROM meeting_file_chunks WHERE file_id = ?", [Number(fileId)]);
  return Number(rows?.[0]?.n || 0);
}

async function readChunk(fileId, seq) {
  const rows = await query("SELECT data FROM meeting_file_chunks WHERE file_id = ? AND seq = ?", [
    Number(fileId),
    Number(seq)
  ]);
  if (!rows.length) throw new Error(`chunk_missing:${seq}`);
  return Buffer.from(String(rows[0].data || ""), "base64");
}

/**
 * Stream chunks in order to a writable (express res). Prefetches up to
 * CONCURRENCY chunks ahead. Returns total bytes written.
 */
export async function streamFileBytes(fileId, n, writable) {
  const pending = new Map();
  let nextToFetch = 0;
  const kick = () => {
    while (nextToFetch < n && pending.size < CONCURRENCY) {
      const seq = nextToFetch++;
      const p = readChunk(fileId, seq);
      p.catch(() => {});
      pending.set(seq, p);
    }
  };
  let total = 0;
  for (let seq = 0; seq < n; seq++) {
    kick();
    const buf = await pending.get(seq);
    pending.delete(seq);
    total += buf.length;
    if (writable.destroyed) return total;
    const ok = writable.write(buf);
    if (!ok) await new Promise((r) => writable.once("drain", r));
  }
  return total;
}

export async function deleteFileBytes(fileId) {
  await query("DELETE FROM meeting_file_chunks WHERE file_id = ?", [Number(fileId)]);
}
