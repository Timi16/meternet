// Web MVP sessions: one DeviceMeter per browser session, with the abuse
// limits from the proposal (per-session byte cap, rate limits). A session is
// identified to the API by a random token the browser keeps; the token is the
// gate key and is never logged. device_id is hashed from the browser node's
// pubkey, so one browser's sessions can be counted across visits (H4).

import { randomBytes } from "node:crypto";
import { DeviceMeter, type MeterDeps } from "./device";
import type { HttpGate } from "./http-gate";
import { CHUNK_BYTES } from "./meter";
import { TokenBucket } from "./token-bucket";

export interface WebLimits {
  maxSessions: number;
  maxSessionsPerIp: number;
  newSessionsPerIpPerMin: number;
  // No invoices past this paid allowance; the session then runs out and is cut.
  sessionMaxBytes: number;
  sessionBytesPerSec: number;
  idleEndMs: number;
  // How long a cut session stays queryable, so the page can show why.
  cutRetainMs: number;
}

export const DEFAULT_LIMITS: WebLimits = {
  maxSessions: 50,
  maxSessionsPerIp: 3,
  newSessionsPerIpPerMin: 10,
  sessionMaxBytes: 100 * 1024 * 1024,
  // ~2 Mbit/s. Pacing must stay below the visitor's link: anything faster
  // piles up in Caddy and kernel buffers (~10 MiB measured on a
  // 0.31 MiB/s link), and those bytes, already counted and paid, keep
  // arriving long after the visitor stops paying.
  sessionBytesPerSec: 256 * 1024,
  idleEndMs: 10 * 60_000,
  cutRetainMs: 2 * 60_000,
};

// Ask for the next invoice when about this much data time is left. Covers the
// payment round trip (1.0-2.3 s measured from Lagos) without prepaying more
// than needed, since prepaid data keeps flowing after the visitor stops.
export const PREFETCH_SECONDS = 3;

export function prefetchBytes(bytesPerSec: number): number {
  return Math.min(CHUNK_BYTES, Math.max(512 * 1024, Math.round(bytesPerSec * PREFETCH_SECONDS)));
}

const PUBKEY = /^0[23][0-9a-f]{64}$/;

export interface WebSession {
  readonly token: string;
  readonly meter: DeviceMeter;
  readonly ip: string;
  readonly createdAtMs: number;
  lastActivityMs: number;
  bytesServed: number;
  readonly bucket: TokenBucket;
}

export type CreateResult =
  | { ok: true; session: WebSession }
  | { ok: false; status: 400 | 429 | 503; error: string };

export interface SessionManagerDeps {
  meter: Omit<MeterDeps, "gate">;
  gate: HttpGate;
  limits: WebLimits;
  now: () => number;
}

export class SessionManager {
  private readonly byToken = new Map<string, WebSession>();
  private readonly bySessionId = new Map<string, WebSession>();
  private readonly recentCreates = new Map<string, number[]>();
  private polling = false;

  constructor(private readonly deps: SessionManagerDeps) {}

  get limits(): WebLimits {
    return this.deps.limits;
  }

  now(): number {
    return this.deps.now();
  }

  create(pubkey: unknown, ip: string): CreateResult {
    if (typeof pubkey !== "string" || !PUBKEY.test(pubkey)) {
      return { ok: false, status: 400, error: "pubkey must be a 33-byte compressed secp256k1 key in hex" };
    }
    const now = this.deps.now();
    const { limits } = this.deps;
    const recent = (this.recentCreates.get(ip) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= limits.newSessionsPerIpPerMin) {
      return { ok: false, status: 429, error: "too many new sessions from this address; wait a minute" };
    }
    const live = [...this.byToken.values()].filter((s) => s.meter.state !== "cut");
    if (live.filter((s) => s.ip === ip).length >= limits.maxSessionsPerIp) {
      return { ok: false, status: 429, error: "too many open sessions from this address" };
    }
    if (live.length >= limits.maxSessions) {
      return { ok: false, status: 503, error: "the demo is full; try again in a few minutes" };
    }
    recent.push(now);
    this.recentCreates.set(ip, recent);

    const token = randomBytes(24).toString("base64url");
    // Prefetch is set from the pacing rate: the gateway holds at the paid
    // allowance, so an invoice issued too late stalls a paying visitor.
    const meter = new DeviceMeter(
      { prefetchRemainingBytes: prefetchBytes(limits.sessionBytesPerSec), ...this.deps.meter, gate: this.deps.gate },
      `web:${pubkey}`,
      token,
    );
    const session: WebSession = {
      token,
      meter,
      ip,
      createdAtMs: now,
      lastActivityMs: now,
      bytesServed: 0,
      bucket: new TokenBucket(limits.sessionBytesPerSec, Math.min(limits.sessionBytesPerSec, 256 * 1024)),
    };
    this.byToken.set(token, session);
    this.bySessionId.set(meter.sessionId, session);
    return { ok: true, session };
  }

  // Looks up a session and counts the request as activity.
  get(token: string): WebSession | undefined {
    const s = this.byToken.get(token);
    if (s) s.lastActivityMs = this.deps.now();
    return s;
  }

  bySession(sessionId: string): WebSession | undefined {
    return this.bySessionId.get(sessionId);
  }

  capped(s: WebSession): boolean {
    return s.meter.snapshot.allowanceBytes >= this.deps.limits.sessionMaxBytes;
  }

  // The invoice to pay next, or null if none is due or the session is capped.
  async nextInvoice(s: WebSession): Promise<{ invoice: string | null; capped: boolean }> {
    if (this.capped(s)) return { invoice: null, capped: true };
    return { invoice: await s.meter.requestChunk(), capped: false };
  }

  // Bytes the gateway has written for this session.
  served(s: WebSession, bytes: number): void {
    s.bytesServed += bytes;
    s.lastActivityMs = this.deps.now();
    s.meter.usage(s.bytesServed);
  }

  // Checks every outstanding invoice once. Skips a round if the last one is
  // still running (a slow FNN must not pile up requests).
  async pollAll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const due = [...this.byToken.values()].filter((s) => s.meter.snapshot.pendingInvoices.length > 0);
      await Promise.all(
        due.map((s) => s.meter.poll().catch((e) => console.error(`meterd: poll ${s.meter.sessionId}:`, e))),
      );
    } finally {
      this.polling = false;
    }
  }

  // Backstop for the per-session deadline timers.
  async tickAll(): Promise<void> {
    await Promise.all([...this.byToken.values()].map((s) => s.meter.tick()));
  }

  // Ends idle sessions and forgets cut ones after they have been shown.
  async reap(): Promise<void> {
    const now = this.deps.now();
    const { idleEndMs, cutRetainMs } = this.deps.limits;
    for (const s of [...this.byToken.values()]) {
      const idle = now - s.lastActivityMs;
      if (s.meter.state === "cut") {
        if (idle >= cutRetainMs) this.forget(s);
      } else if (idle >= idleEndMs) {
        await s.meter.end("idle");
        this.forget(s);
      }
    }
    for (const [ip, ts] of this.recentCreates) {
      if (ts.every((t) => now - t >= 60_000)) this.recentCreates.delete(ip);
    }
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.byToken.values()].map((s) => s.meter.end("shutdown")));
    for (const s of [...this.byToken.values()]) this.forget(s);
  }

  get size(): number {
    return this.byToken.size;
  }

  private forget(s: WebSession): void {
    this.byToken.delete(s.token);
    this.bySessionId.delete(s.meter.sessionId);
  }
}
