// The hotspot box's portal API. The box's Caddy serves the portal page over
// HTTPS and proxies /api here (localhost only). A device is known by its
// address on the hotspot (X-Forwarded-For, as Caddy adds it), so a phone can
// only ever see and pay for its own session.
//
//   GET  /api/hotspot/info     the box's Fiber node (wss address, pubkey) and price
//   GET  /api/hotspot/status   this device's session
//   POST /api/hotspot/chunk    the invoice this device should pay next
//   POST /api/feedback         optional visitor feedback (see feedback.ts)
//   GET  /api/health

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { parseFeedback, type FeedbackSink } from "./feedback";
import type { Hotspot } from "./hotspot";

export interface HotspotInfo {
  box_wss: string;
  box_pubkey: string;
  // Relative URL the page uses as its CKB RPC; the box proxies it, so phones
  // that haven't paid never need to reach anything but the box.
  ckb_rpc: string;
  price_shannons: string;
  chunk_bytes: number;
}

export interface HotspotServerDeps {
  hotspot: Hotspot;
  info: HotspotInfo;
  feedback: FeedbackSink;
  now: () => number;
}

const MAX_BODY_BYTES = 4 * 1024;

export function createHotspotServer(deps: HotspotServerDeps): Server {
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };

  return createServer(async (req, res) => {
    try {
      const path = new URL(req.url ?? "/", "http://box").pathname;
      const route = `${req.method ?? "GET"} ${path}`;
      const ip = clientIp(req);
      switch (route) {
        case "GET /api/health":
          return json(res, 200, { ok: true, sessions: deps.hotspot.size });
        case "GET /api/hotspot/info":
          return json(res, 200, deps.info);
        case "GET /api/hotspot/status": {
          const r = await deps.hotspot.status(ip);
          return r.ok ? json(res, 200, r.view) : json(res, r.status, { error: r.error });
        }
        case "POST /api/hotspot/chunk": {
          const r = await deps.hotspot.nextInvoice(ip);
          return r.ok ? json(res, 200, r.view) : json(res, r.status, { error: r.error });
        }
        case "POST /api/feedback": {
          const entry = parseFeedback(await readJson(req), new Date(deps.now()).toISOString());
          if (typeof entry === "string") return json(res, 400, { error: entry });
          deps.feedback.write(entry);
          return json(res, 201, { ok: true });
        }
        default:
          return json(res, 404, { error: "not found" });
      }
    } catch (e) {
      console.error("meterd hotspot: request failed:", e);
      if (!res.headersSent) json(res, 502, { error: "meter unavailable" });
    }
  });
}

function clientIp(req: IncomingMessage): string {
  const xff = req.headers["x-forwarded-for"];
  const last = (Array.isArray(xff) ? xff.at(-1) : xff)?.split(",").at(-1)?.trim();
  return last || req.socket.remoteAddress || "";
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let body = "";
  for await (const chunk of req as AsyncIterable<Buffer>) {
    body += chunk.toString("utf8");
    if (body.length > MAX_BODY_BYTES) return null;
  }
  try {
    return body ? JSON.parse(body) : null;
  } catch {
    return null;
  }
}
