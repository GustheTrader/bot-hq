#!/usr/bin/env bun
// Public HTTPS front door for the Zen Macro desktop frontend.
//
// Zo terminates TLS and routes the public service URL to $PORT. We forward every
// request to the Macro dev server, which reaches us over the Zen reverse SSH
// tunnel on 127.0.0.1:3020 (Zen 127.0.0.1:3018 -> modal 127.0.0.1:3020).
//
// The Macro dev server is a Vite dev server that rejects unknown Host headers
// ("Blocked request. This host is not allowed."), so we rewrite Host to
// localhost:3018 upstream and strip hop-by-hop headers. We also must NOT
// decompress/recompress bodies, and must pass through the Vite HMR websocket.

const UPSTREAM = process.env.MACRO_UPSTREAM ?? "http://127.0.0.1:3020";
const UPSTREAM_HOST = process.env.MACRO_UPSTREAM_HOST ?? "localhost:3018";
const PORT = Number(process.env.PORT ?? 8801);

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
]);

function filterHeaders(headers: Headers, response = false): Headers {
  const out = new Headers();
  headers.forEach((value, key) => {
    const k = key.toLowerCase();
    if (HOP_BY_HOP.has(k)) return;
    // On responses we re-frame the body, so drop framing/encoding headers that no
    // longer describe it (Vite's identity body has no content-encoding).
    if (response && (k === "content-encoding" || k === "content-length")) return;
    out.set(key, value);
  });
  return out;
}

const server = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  idleTimeout: 120,
  async fetch(req) {
    const url = new URL(req.url);
    const target = UPSTREAM + url.pathname + url.search;

    const headers = filterHeaders(req.headers);
    headers.set("host", UPSTREAM_HOST);
    headers.set("x-forwarded-host", url.host);
    headers.set("x-forwarded-proto", "https");
    // Ask the Vite dev server for identity encoding: some bundled assets ship a
    // gzip/deflate body Caddy then tries to re-inflate, aborting with "gzip:
    // invalid header". Identity sidesteps double-decoding entirely.
    headers.set("accept-encoding", "identity");

    // WebSocket upgrade (Vite HMR) — proxy bidirectionally.
    if ((req.headers.get("upgrade") ?? "").toLowerCase() === "websocket") {
      const ok = server.upgrade(req, {
        data: { url: target, headers },
      });
      if (ok) return undefined as unknown as Response;
      return new Response("websocket upgrade failed", { status: 502 });
    }

    const init: RequestInit & { duplex?: string } = {
      method: req.method,
      headers,
      redirect: "manual",
    };
    if (req.method !== "GET" && req.method !== "HEAD") {
      init.body = req.body;
      init.duplex = "half";
    }

    let upstream: Response;
    try {
      upstream = await fetch(target, init as RequestInit);
    } catch (err) {
      return new Response(
        `Macro frontend unreachable at ${UPSTREAM}: ${(err as Error).message}\n` +
          `Check the Zen reverse tunnel (macro-sshtun scheduled task).\n`,
        { status: 502, headers: { "content-type": "text/plain; charset=utf-8" } },
      );
    }

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: filterHeaders(upstream.headers, true),
    });
  },
  websocket: {
    async open(ws) {
      const { url, headers } = ws.data as { url: string; headers: Headers };
      const upstream = new WebSocket(url.replace(/^http/, "ws"), headers as unknown as string[]);
      (ws.data as Record<string, unknown>).upstream = upstream;
      upstream.addEventListener("open", () => {});
      upstream.addEventListener("message", (ev) => ws.send(ev.data));
      upstream.addEventListener("close", () => ws.close());
      upstream.addEventListener("error", () => ws.close());
      ws.data.upstream = upstream;
    },
    message(ws, message) {
      const upstream = (ws.data as Record<string, unknown>).upstream as WebSocket | undefined;
      if (upstream && upstream.readyState === WebSocket.OPEN) upstream.send(message);
    },
    close(ws) {
      const upstream = (ws.data as Record<string, unknown>).upstream as WebSocket | undefined;
      upstream?.close();
    },
  },
});

console.log(`macro-gateway listening on 0.0.0.0:${PORT} -> ${UPSTREAM} (host ${UPSTREAM_HOST})`);
