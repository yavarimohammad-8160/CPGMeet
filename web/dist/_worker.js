/**
 * Cloudflare Pages advanced-mode worker for meet.cpg-pars.ir.
 *
 * Pishgaman / Irancell / Zitel and many office networks block Render's
 * 216.24.57.0/24, while meet.cpg-pars.ir (Cloudflare) loads fine. So the
 * browser only ever talks to this host: /api/* (incl. signed file downloads
 * /api/files/:id?t=...) and /socket.io/* are proxied from the Cloudflare edge
 * to the Render origin — same pattern as CPGChat's chat.cpg-pars.ir worker.
 * Everything else is static assets with SPA fallback to /index.html.
 */
const ORIGIN_HOST = "meet-api.cpg-pars.ir"; // DNS-only custom domain of Render service cpgmeet-server

function isProxied(pathname) {
  return (
    pathname === "/api" ||
    pathname.startsWith("/api/") ||
    pathname === "/socket.io" ||
    pathname.startsWith("/socket.io/")
  );
}

async function proxy(request, url) {
  const target = new URL(url.toString());
  target.hostname = ORIGIN_HOST;
  target.protocol = "https:";
  target.port = "";

  const upgrade = (request.headers.get("Upgrade") || "").toLowerCase();
  if (upgrade === "websocket") return fetch(target.toString(), request);

  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("content-length");
  headers.set("X-Forwarded-Host", url.host);
  headers.set("X-Forwarded-Proto", "https");
  const ip = request.headers.get("CF-Connecting-IP");
  if (ip) headers.set("X-Forwarded-For", ip);

  const method = request.method;
  const init = { method, headers, redirect: "manual" };
  if (method !== "GET" && method !== "HEAD") init.body = await request.arrayBuffer();

  try {
    // Response body is streamed back as-is (Content-Disposition, Set-Cookie,
    // Content-Type etc. preserved).
    return await fetch(target.toString(), init);
  } catch (err) {
    return new Response(JSON.stringify({ error: "origin_unreachable", message: String(err && err.message || err) }), {
      status: 502,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
    });
  }
}

/** Opportunistically wake the Render free-tier dyno when someone opens the app. */
function prewarm(ctx) {
  if (!ctx || typeof ctx.waitUntil !== "function") return;
  ctx.waitUntil(
    fetch(`https://${ORIGIN_HOST}/api/health`, { headers: { Accept: "application/json", "User-Agent": "cpgmeet-pages-prewarm/1" } })
      .then((r) => r.arrayBuffer())
      .catch(() => {})
  );
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (isProxied(url.pathname)) return proxy(request, url);

    if (!env.ASSETS) return new Response("assets binding missing", { status: 500 });
    const accept = request.headers.get("accept") || "";
    const isNavigation = request.method === "GET" && accept.includes("text/html");
    if (isNavigation) prewarm(ctx);

    const asset = await env.ASSETS.fetch(request);
    if (asset.status !== 404 || request.method !== "GET") return asset;
    if (!accept.includes("text/html") || url.pathname.includes(".")) return asset;
    const indexUrl = new URL("/index.html", url.origin);
    return env.ASSETS.fetch(new Request(indexUrl, request));
  }
};
