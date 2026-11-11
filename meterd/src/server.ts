// meterd's HTTP side for the public web MVP. Caddy proxies /api/* and /gw/*
// here; meterd listens on localhost only.
//
//   POST /api/sessions                {pubkey}  -> new session + token
//   GET  /api/sessions/:token                   -> session status
//   POST /api/sessions/:token/chunk             -> the invoice to pay next
//                                                  (and its payment_hash)
//   POST /api/feedback  {clear, smooth, would_use, comment?, session_id?}
//   GET  /api/content                           -> what the gateway serves
//   GET  /api/dashboard                         -> public session summaries
//   GET  /api/dashboard/events                  -> the same, live (SSE)
//   GET  /api/health
//   GET  /gw/:token/(files|video)/:name         -> metered content
//
// The gateway serves only files in CONTENT_DIR/files and CONTENT_DIR/video
// (MeterNet's own test files and HLS video). It is not a proxy. It never
// sends a byte past the paid allowance: at the limit a response waits for the
// next payment, and the meter's grace deadline cuts it if none lands. (The
// hotspot gate can't hold traffic like this, so it can overshoot a little.)

import { createReadStream, readdirSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join } from "node:path";
import type { Dashboard } from "./dashboard";
import { parseFeedback, type FeedbackSink } from "./feedback";
import type { HttpGate } from "./http-gate";
import { CHUNK_BYTES, cutDueAtMs } from "./meter";
import type { SessionManager, WebSession } from "./sessions";

export interface ServerDeps {
  sessions: SessionManager;
  gate: HttpGate;
  dashboard: Dashboard;
  feedback: FeedbackSink;
  contentDir: string;
  priceShannons: bigint;
  maxSseClients?: number;
}

const CONTENT_DIRS = new Set(["files", "video"]);
const CONTENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/;
const MIME: Record<string, string> = {
  ".m3u8": "application/vnd.apple.mpegurl",
  ".ts": "video/mp2t",
  ".mp4": "video/mp4",
  ".bin": "application/octet-stream",
};
const READ_CHUNK_BYTES = 64 * 1024;
// How often a response held at the paid allowance checks for a new payment.
const HOLD_POLL_MS = 100;
const MAX_BODY_BYTES = 4 * 1024;
const FEEDBACK_PER_IP_PER_MIN = 5;

export function createMeterServer(deps: ServerDeps): Server {
  let sseClients = 0;
  const feedbackTimes = new Map<string, number[]>();
  const maxSse = deps.maxSseClients ?? 100;

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };

  const status = (s: WebSession) => {
    const snap = s.meter.snapshot;
    const due = cutDueAtMs(snap);
    const cut = snap.state === "cut" ? deps.dashboard.session(s.meter.sessionId)?.cut : undefined;
    return {
      session_id: s.meter.sessionId,
      device_id: s.meter.deviceId,
      state: snap.state,
      allowance_bytes: snap.allowanceBytes,
      used_bytes: snap.usedBytes,
      chunk_bytes: CHUNK_BYTES,
      price_shannons: deps.priceShannons.toString(),
      max_bytes: deps.sessions.limits.sessionMaxBytes,
      capped: deps.sessions.capped(s),
      gate_open: deps.gate.isOpen(s.token),
      // In grace: how long a payment still has before the cut.
      cut_due_in_ms: due === null ? null : Math.max(0, due - deps.sessions.now()),
      // Once cut: how long after the allowance ran out access closed.
      cut: cut ? { cutoff_ms: cut.cutoff_ms, within_deadline: cut.within_deadline } : null,
    };
  };

  // The invoice to pay now (null when nothing is due or the session is capped).
  const pending = (s: WebSession) => {
    const p = deps.sessions.capped(s) ? null : s.meter.pendingInvoice;
    return { invoice: p?.invoice ?? null, payment_hash: p?.payment_hash ?? null };
  };

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://meterd");
      const parts = url.pathname.split("/").filter(Boolean);
      const method = req.method ?? "GET";

      if (parts[0] === "gw" && method === "GET" && parts.length === 4) {
        return await serveContent(req, res, parts[1]!, parts[2]!, parts[3]!);
      }
      if (parts[0] !== "api") return json(res, 404, { error: "not found" });

      const route = `${method} /${parts.slice(1, 2).join("/")}`;
      if (route === "GET /health") return json(res, 200, { ok: true, sessions: deps.sessions.size });
      if (route === "GET /content" && parts.length === 2) return json(res, 200, listContent(deps.contentDir));
      if (route === "GET /dashboard" && parts.length === 2) return json(res, 200, deps.dashboard.view());
      if (route === "GET /dashboard" && parts[2] === "events" && parts.length === 3) return sse(req, res);
      if (route === "POST /feedback" && parts.length === 2) {
        const ip = clientIp(req);
        const now = deps.sessions.now();
        const recent = (feedbackTimes.get(ip) ?? []).filter((t) => now - t < 60_000);
        if (recent.length >= FEEDBACK_PER_IP_PER_MIN) return json(res, 429, { error: "thanks, that's enough for now" });
        const entry = parseFeedback(await readJson(req), new Date(now).toISOString());
        if (typeof entry === "string") return json(res, 400, { error: entry });
        feedbackTimes.set(ip, [...recent, now]);
        deps.feedback.write(entry);
        return json(res, 201, { ok: true });
      }

      if (parts[1] === "sessions") {
        if (method === "POST" && parts.length === 2) {
          const body = await readJson(req);
          const r = deps.sessions.create((body as { pubkey?: unknown } | null)?.pubkey, clientIp(req));
          if (!r.ok) return json(res, r.status, { error: r.error });
          return json(res, 201, { token: r.session.token, ...status(r.session) });
        }
        const s = parts[2] ? deps.sessions.get(parts[2]) : undefined;
        if (!s) return json(res, 404, { error: "no such session" });
        if (method === "GET" && parts.length === 3) return json(res, 200, status(s));
        if (method === "POST" && parts[3] === "chunk" && parts.length === 4) {
          await deps.sessions.nextInvoice(s);
          return json(res, 200, { ...status(s), ...pending(s) });
        }
      }
      return json(res, 404, { error: "not found" });
    } catch (e) {
      if (e instanceof HttpError) return json(res, e.status, { error: e.message });
      console.error("meterd: request failed:", e);
      if (!res.headersSent) json(res, 502, { error: "meter unavailable" });
      else res.destroy();
    }
  });

  async function serveContent(_req: IncomingMessage, res: ServerResponse, token: string, dir: string, name: string) {
    const s = deps.sessions.get(token);
    if (!s) return json(res, 404, { error: "no such session" });
    if (!CONTENT_DIRS.has(dir) || !CONTENT_NAME.test(name)) return json(res, 404, { error: "not found" });
    const path = join(deps.contentDir, dir, name);
    let size: number;
    try {
      const st = statSync(path);
      if (!st.isFile()) throw new Error("not a file");
      size = st.size;
    } catch {
      return json(res, 404, { error: "not found" });
    }
    if (!deps.gate.isOpen(s.token) || s.meter.state === "cut") {
      return json(res, 402, { error: "payment required", ...status(s) });
    }

    res.writeHead(200, {
      "content-type": MIME[extname(name)] ?? "application/octet-stream",
      "content-length": String(size),
      "cache-control": "no-store",
    });
    deps.gate.track(s.token, res);
    const stream = createReadStream(path, { highWaterMark: READ_CHUNK_BYTES });
    try {
      reading: for await (const chunk of stream as AsyncIterable<Buffer>) {
        let rest = chunk;
        while (rest.length > 0) {
          // Never send past what has been paid. At the allowance the meter is
          // in grace: hold until the next payment lands or the cut closes us.
          const room = await paidRoom(s, res);
          if (room === 0) break reading;
          const part = rest.subarray(0, Math.min(room, rest.length));
          await s.bucket.take(part.length);
          // Checked after the wait: a cut may have landed meanwhile.
          if (res.destroyed || !deps.gate.isOpen(s.token)) break reading;
          const flushed = res.write(part);
          deps.sessions.served(s, part.length);
          rest = rest.subarray(part.length);
          if (!flushed) await drained(res);
        }
      }
    } finally {
      stream.destroy();
    }
    if (res.destroyed) return;
    if (!deps.gate.isOpen(s.token)) res.destroy();
    else res.end();
  }

  // Paid bytes this session may still receive; waits while that is zero.
  // Returns 0 only once the response or the session's gate is closed.
  async function paidRoom(s: WebSession, res: ServerResponse): Promise<number> {
    for (;;) {
      if (res.destroyed || !deps.gate.isOpen(s.token)) return 0;
      const room = s.meter.snapshot.allowanceBytes - s.bytesServed;
      if (room > 0) return room;
      await new Promise((r) => setTimeout(r, HOLD_POLL_MS));
    }
  }

  function sse(req: IncomingMessage, res: ServerResponse) {
    if (sseClients >= maxSse) return json(res, 503, { error: "too many dashboard viewers" });
    sseClients++;
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    res.write("retry: 5000\n\n");
    const unsubscribe = deps.dashboard.subscribe((e) => res.write(`data: ${JSON.stringify(e)}\n\n`));
    const ping = setInterval(() => res.write(": ping\n\n"), 20_000);
    ping.unref();
    req.on("close", () => {
      sseClients--;
      unsubscribe();
      clearInterval(ping);
    });
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let body = "";
  for await (const chunk of req as AsyncIterable<Buffer>) {
    body += chunk.toString("utf8");
    if (body.length > MAX_BODY_BYTES) throw new HttpError(413, "body too large");
  }
  try {
    return body ? JSON.parse(body) : null;
  } catch {
    throw new HttpError(400, "body must be JSON");
  }
}

// meterd listens on localhost behind Caddy, which sets X-Forwarded-For to the
// client address it saw; the last entry is the one Caddy added.
function clientIp(req: IncomingMessage): string {
  const xff = req.headers["x-forwarded-for"];
  const last = (Array.isArray(xff) ? xff.at(-1) : xff)?.split(",").at(-1)?.trim();
  return last || req.socket.remoteAddress || "unknown";
}

function drained(res: ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      res.off("drain", done);
      res.off("close", done);
      resolve();
    };
    res.on("drain", done);
    res.on("close", done);
  });
}

function listContent(contentDir: string) {
  const files = (dir: string) => {
    try {
      return readdirSync(join(contentDir, dir))
        .filter((n) => CONTENT_NAME.test(n))
        .map((n) => ({ path: `${dir}/${n}`, bytes: statSync(join(contentDir, dir, n)).size }));
    } catch {
      return [];
    }
  };
  const video = files("video");
  return {
    files: files("files"),
    video: video.some((f) => f.path === "video/index.m3u8")
      ? { playlist: "video/index.m3u8", bytes: video.reduce((n, f) => n + f.bytes, 0), segments: video.length - 1 }
      : null,
  };
}
