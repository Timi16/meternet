// The web MVP's HTTP side against the mocked FNN: sessions, invoices, the
// metered gateway, limits and the dashboard.

import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Dashboard } from "../src/dashboard";
import { FnnRpcClient } from "../src/fnn";
import { HttpGate } from "../src/http-gate";
import { MemoryLog, TeeLog } from "../src/log";
import { CHUNK_BYTES } from "../src/meter";
import { MemoryFeedbackLog } from "../src/feedback";
import { createMeterServer } from "../src/server";
import { DEFAULT_LIMITS, SessionManager, type WebLimits } from "../src/sessions";
import { MockFnn } from "./mock-fnn";

const PUBKEY = "02" + "ab".repeat(32);
const PUBKEY_B = "03" + "cd".repeat(32);
const FAST = 512 * 1024 * 1024; // bytes/s: effectively unthrottled

let mock: MockFnn;
let gate: HttpGate;
let log: MemoryLog;
let dashboard: Dashboard;
let sessions: SessionManager;
let server: Server;
let base: string;
let nowMs: number;
let contentDir: string;
let feedback: MemoryFeedbackLog;
// Timers meterd arms (the cut deadline), fired by the test instead of waiting.
let timers: { fn: () => void; live: boolean }[];

async function fireTimers() {
  for (const t of timers.splice(0)) if (t.live) t.fn();
  await new Promise((r) => setTimeout(r, 20));
}

async function start(limits: Partial<WebLimits> = {}) {
  timers = [];
  feedback = new MemoryFeedbackLog();
  gate = new HttpGate();
  log = new MemoryLog();
  dashboard = new Dashboard();
  sessions = new SessionManager({
    meter: {
      fnn: new FnnRpcClient(mock.url),
      log: new TeeLog(log, dashboard),
      now: () => nowMs,
      chunkPriceShannons: 10_000_000n,
      deviceSalt: "test-salt",
      schedule: (_ms, fn) => {
        const t = { fn, live: true };
        timers.push(t);
        return () => void (t.live = false);
      },
    },
    gate,
    limits: { ...DEFAULT_LIMITS, sessionBytesPerSec: FAST, ...limits },
    now: () => nowMs,
  });
  dashboard.live = (id) => {
    const s = sessions.bySession(id);
    return s && { bytes_used: s.meter.snapshot.usedBytes, allowance_bytes: s.meter.snapshot.allowanceBytes };
  };
  server = createMeterServer({ sessions, gate, dashboard, feedback, contentDir, priceShannons: 10_000_000n });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeEach(async () => {
  mock = await new MockFnn().start();
  nowMs = 1_000;
  contentDir = mkdtempSync(join(tmpdir(), "meterd-content-"));
  mkdirSync(join(contentDir, "files"));
  mkdirSync(join(contentDir, "video"));
  writeFileSync(join(contentDir, "files", "test-1MB.bin"), randomBytes(1024 * 1024));
  writeFileSync(join(contentDir, "files", "test-3MB.bin"), randomBytes(3 * 1024 * 1024));
  writeFileSync(join(contentDir, "video", "index.m3u8"), "#EXTM3U\n#EXTINF:4,\nseg000.ts\n");
  writeFileSync(join(contentDir, "video", "seg000.ts"), randomBytes(2000));
  writeFileSync(join(contentDir, "secret.txt"), "not served");
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await mock.stop();
});

const post = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function newSession(ip = "198.51.100.7", pubkey = PUBKEY) {
  const res = await post("/api/sessions", { pubkey }, { "x-forwarded-for": ip });
  expect(res.status).toBe(201);
  return (await res.json()) as { token: string; session_id: string; device_id: string; state: string };
}

async function payChunk(token: string) {
  const r = (await (await post(`/api/sessions/${token}/chunk`)).json()) as { invoice: string | null };
  for (const [hash, inv] of mock.invoices) if (inv.status === "Open") mock.setStatus(hash, "Paid");
  await sessions.pollAll();
  return r.invoice;
}

describe("web MVP server", () => {
  it("rejects a session without a valid browser-node pubkey", async () => {
    await start();
    for (const body of [{}, { pubkey: "02abc" }, { pubkey: "04" + "ab".repeat(32) }, { pubkey: 7 }]) {
      expect((await post("/api/sessions", body)).status).toBe(400);
    }
    expect((await fetch(base + "/api/sessions", { method: "POST", body: "{not json" })).status).toBe(400);
  });

  it("creates a session and hands out one invoice at a time", async () => {
    await start();
    const s = await newSession();
    expect(s.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(s.state).toBe("idle");

    const a = (await (await post(`/api/sessions/${s.token}/chunk`)).json()) as { invoice: string; state: string };
    const b = (await (await post(`/api/sessions/${s.token}/chunk`)).json()) as { invoice: string };
    expect(a.invoice).toMatch(/^fibtmock/);
    expect(b.invoice).toBe(a.invoice);
    expect(a.state).toBe("awaiting_payment");
    expect(mock.invoices.size).toBe(1);
  });

  it("returns each invoice with its payment hash", async () => {
    await start();
    const s = await newSession();
    const a = (await (await post(`/api/sessions/${s.token}/chunk`)).json()) as { invoice: string; payment_hash: string };
    expect(a.payment_hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(mock.invoices.get(a.payment_hash)!.invoice_address).toBe(a.invoice);
  });

  it("reports the grace countdown, then how fast the cut came", async () => {
    await start();
    const s = await newSession();
    await payChunk(s.token);
    sessions.served(sessions.get(s.token)!, CHUNK_BYTES); // allowance used up: grace
    nowMs += 2_000;
    const g = (await (await fetch(`${base}/api/sessions/${s.token}`)).json()) as Record<string, unknown>;
    expect(g).toMatchObject({ state: "grace", cut_due_in_ms: 10_000, cut: null });

    nowMs += 10_000;
    await fireTimers();
    const c = (await (await fetch(`${base}/api/sessions/${s.token}`)).json()) as Record<string, unknown>;
    expect(c).toMatchObject({ state: "cut", cut_due_in_ms: null, cut: { cutoff_ms: 12_000, within_deadline: true } });
  });

  it("stores feedback answers, validated, with no personal data", async () => {
    await start();
    const ok = await post(
      "/api/feedback",
      { session_id: "8f1c2a4e-1d2b-4c3d-9e8f-0a1b2c3d4e5f", clear: 4, smooth: 5, would_use: "maybe", comment: " fast enough " },
      { "x-forwarded-for": "203.0.113.20" },
    );
    expect(ok.status).toBe(201);
    expect(feedback.entries).toEqual([
      expect.objectContaining({
        session_id: "8f1c2a4e-1d2b-4c3d-9e8f-0a1b2c3d4e5f",
        clear: 4,
        smooth: 5,
        would_use: "maybe",
        comment: "fast enough",
      }),
    ]);
    expect(JSON.stringify(feedback.entries)).not.toContain("203.0.113.20");

    for (const bad of [
      {},
      { clear: 6, smooth: 3, would_use: "yes" },
      { clear: 3, smooth: 3, would_use: "sure" },
      { clear: 3, smooth: 3, would_use: "yes", comment: "x".repeat(501) },
      { clear: 3, smooth: 3, would_use: "yes", session_id: "not-a-uuid" },
    ]) {
      expect((await post("/api/feedback", bad)).status, JSON.stringify(bad).slice(0, 60)).toBe(400);
    }
  });

  it("limits feedback per address", async () => {
    await start();
    const answer = { clear: 3, smooth: 3, would_use: "yes" };
    for (let i = 0; i < 5; i++) expect((await post("/api/feedback", answer, { "x-forwarded-for": "203.0.113.30" })).status).toBe(201);
    expect((await post("/api/feedback", answer, { "x-forwarded-for": "203.0.113.30" })).status).toBe(429);
  });

  it("serves nothing before the first payment (402), then serves and meters every byte", async () => {
    await start();
    const s = await newSession();
    expect((await fetch(`${base}/gw/${s.token}/files/test-1MB.bin`)).status).toBe(402);

    await payChunk(s.token);
    const res = await fetch(`${base}/gw/${s.token}/files/test-1MB.bin`);
    expect(res.status).toBe(200);
    expect((await res.arrayBuffer()).byteLength).toBe(1024 * 1024);

    const st = (await (await fetch(`${base}/api/sessions/${s.token}`)).json()) as Record<string, unknown>;
    expect(st).toMatchObject({ state: "paid", used_bytes: 1024 * 1024, allowance_bytes: CHUNK_BYTES, gate_open: true });
  });

  it("serves the HLS playlist and segments through the meter", async () => {
    await start();
    const s = await newSession();
    await payChunk(s.token);
    const playlist = await fetch(`${base}/gw/${s.token}/video/index.m3u8`);
    expect(playlist.headers.get("content-type")).toBe("application/vnd.apple.mpegurl");
    expect(await playlist.text()).toContain("seg000.ts");
    const seg = await fetch(`${base}/gw/${s.token}/video/seg000.ts`);
    expect(seg.headers.get("content-type")).toBe("video/mp2t");
    expect((await seg.arrayBuffer()).byteLength).toBe(2000);
  });

  it("serves only the content folders: no traversal, no other files", async () => {
    await start();
    const s = await newSession();
    await payChunk(s.token);
    for (const path of [
      "files/..%2Fsecret.txt",
      "files/%2E%2E%2Fsecret.txt",
      "other/secret.txt",
      "files/.hidden",
      "files/missing.bin",
    ]) {
      expect((await fetch(`${base}/gw/${s.token}/${path}`)).status, path).toBe(404);
    }
    expect((await fetch(`${base}/gw/${s.token}/../secret.txt`)).status).toBe(404);
    expect((await fetch(`${base}/gw/not-a-token/files/test-1MB.bin`)).status).toBe(404);
  });

  it("lists what the gateway serves", async () => {
    await start();
    const c = (await (await fetch(`${base}/api/content`)).json()) as { files: unknown[]; video: unknown };
    expect(c.files).toEqual(
      expect.arrayContaining([
        { path: "files/test-1MB.bin", bytes: 1024 * 1024 },
        { path: "files/test-3MB.bin", bytes: 3 * 1024 * 1024 },
      ]),
    );
    expect(c.video).toMatchObject({ playlist: "video/index.m3u8", segments: 1 });
  });

  it("never serves past the paid allowance, and resumes when the next payment lands", async () => {
    await start();
    const s = await newSession();
    await payChunk(s.token); // 2 MiB allowance; the file is 3 MiB
    const res = await fetch(`${base}/gw/${s.token}/files/test-3MB.bin`);
    const reader = res.body!.getReader();
    let got = 0;
    let finished = false;
    const read = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return void (finished = true);
        got += value.byteLength;
      }
    })();
    await new Promise((r) => setTimeout(r, 500));
    expect(got).toBe(CHUNK_BYTES); // held exactly at the allowance
    expect(finished).toBe(false);
    const st = (await (await fetch(`${base}/api/sessions/${s.token}`)).json()) as { state: string };
    expect(st.state).toBe("grace");

    await payChunk(s.token);
    await read;
    expect(got).toBe(3 * 1024 * 1024);
  });

  it("stops a download mid-file when the session is cut", async () => {
    await start({ sessionBytesPerSec: 1024 * 1024 }); // 3 MB takes ~3 s
    const s = await newSession();
    await payChunk(s.token);
    const res = await fetch(`${base}/gw/${s.token}/files/test-3MB.bin`);
    const reader = res.body!.getReader();
    let got = 0;
    const read = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return "ended";
        got += value.byteLength;
      }
    })().catch(() => "aborted");
    await new Promise((r) => setTimeout(r, 400));
    await gate.close(s.token); // what the meter does on a cut
    expect(await read).toBe("aborted");
    expect(got).toBeGreaterThan(0);
    expect(got).toBeLessThan(3 * 1024 * 1024);
  });

  it("throttles each session, across parallel requests", async () => {
    await start({ sessionBytesPerSec: 2 * 1024 * 1024 });
    const s = await newSession();
    await payChunk(s.token);
    const t0 = Date.now();
    await Promise.all(
      [1, 2].map(async () => (await fetch(`${base}/gw/${s.token}/files/test-1MB.bin`)).arrayBuffer()),
    );
    // 2 MiB at 2 MiB/s, minus the 256 KiB burst: at least ~0.85 s.
    expect(Date.now() - t0).toBeGreaterThanOrEqual(800);
  });

  it("stops issuing invoices at the per-session byte cap", async () => {
    await start({ sessionMaxBytes: CHUNK_BYTES });
    const s = await newSession();
    await payChunk(s.token);
    const r = (await (await post(`/api/sessions/${s.token}/chunk`)).json()) as Record<string, unknown>;
    expect(r).toMatchObject({ invoice: null, capped: true });
  });

  it("limits open sessions per address, new sessions per minute, and in total", async () => {
    await start({ maxSessionsPerIp: 2, newSessionsPerIpPerMin: 3, maxSessions: 3 });
    await newSession("203.0.113.1");
    await newSession("203.0.113.1");
    expect((await post("/api/sessions", { pubkey: PUBKEY }, { "x-forwarded-for": "203.0.113.1" })).status).toBe(429);

    await newSession("203.0.113.2");
    expect((await post("/api/sessions", { pubkey: PUBKEY }, { "x-forwarded-for": "203.0.113.3" })).status).toBe(503);
  });

  it("limits how fast one address opens sessions", async () => {
    await start({ maxSessionsPerIp: 10, newSessionsPerIpPerMin: 2 });
    await newSession("203.0.113.9");
    await newSession("203.0.113.9");
    expect((await post("/api/sessions", { pubkey: PUBKEY }, { "x-forwarded-for": "203.0.113.9" })).status).toBe(429);
    nowMs += 60_000;
    await newSession("203.0.113.9");
  });

  it("uses the address Caddy appended, not one the client sent", async () => {
    await start({ maxSessionsPerIp: 1 });
    await newSession("203.0.113.5");
    // A client-supplied X-Forwarded-For comes first; Caddy appends the real one.
    const spoofed = await post("/api/sessions", { pubkey: PUBKEY }, { "x-forwarded-for": "10.0.0.1, 203.0.113.5" });
    expect(spoofed.status).toBe(429);
  });

  it("ends idle sessions, closing access, and forgets cut ones later", async () => {
    await start();
    const s = await newSession();
    await payChunk(s.token);
    nowMs += DEFAULT_LIMITS.idleEndMs;
    await sessions.reap();
    expect(gate.isOpen(s.token)).toBe(false);
    expect(log.lines.at(-1)).toMatchObject({ event: "session_ended", cutoff_reason: "idle" });
    expect((await fetch(`${base}/api/sessions/${s.token}`)).status).toBe(404);
  });

  it("gives a browser the same device ID across sessions", async () => {
    await start();
    const a = await newSession("203.0.113.1", PUBKEY);
    const b = await newSession("203.0.113.1", PUBKEY);
    const c = await newSession("203.0.113.1", PUBKEY_B);
    expect(a.device_id).toBe(b.device_id);
    expect(a.session_id).not.toBe(b.session_id);
    expect(c.device_id).not.toBe(a.device_id);
  });

  it("shows payments on the dashboard without tokens, addresses or preimages", async () => {
    await start();
    const s = await newSession("203.0.113.77");
    await payChunk(s.token);
    await (await fetch(`${base}/gw/${s.token}/files/test-1MB.bin`)).arrayBuffer();

    const raw = await (await fetch(`${base}/api/dashboard`)).text();
    const d = JSON.parse(raw) as { totals: Record<string, number>; sessions: Record<string, unknown>[] };
    const paid = log.lines.find((l) => l.event === "invoice_paid")!;
    expect(d.totals).toMatchObject({ sessions: 1, payments: 1 });
    expect(d.sessions[0]).toMatchObject({
      session_id: s.session_id,
      status: "paid",
      bytes_used: 1024 * 1024,
      payments: [expect.objectContaining({ payment_hash: paid.payment_hash })],
    });
    expect(raw).not.toContain(s.token);
    expect(raw).not.toContain("203.0.113.77");
    expect(raw).not.toContain(paid.preimage!);
    expect(raw).not.toContain(PUBKEY);
  });

  it("streams dashboard events live", async () => {
    await start();
    const res = await fetch(`${base}/api/dashboard/events`);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const reader = res.body!.getReader();
    const s = await newSession();
    await payChunk(s.token);
    let text = "";
    while (!text.includes('"invoice_paid"')) text += new TextDecoder().decode((await reader.read()).value);
    expect(text).toContain(s.session_id);
    expect(text).not.toContain(s.token);
    await reader.cancel();
  });
});

describe("prefetchBytes", () => {
  it("asks ~3 s of data early, within 512 KiB and one chunk", async () => {
    const { prefetchBytes } = await import("../src/sessions");
    expect(prefetchBytes(256 * 1024)).toBe(768 * 1024);
    expect(prefetchBytes(64 * 1024)).toBe(512 * 1024);
    expect(prefetchBytes(4 * 1024 * 1024)).toBe(CHUNK_BYTES);
  });
});
