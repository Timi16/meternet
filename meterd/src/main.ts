// meterd for the public web MVP: the meter loop behind the metered HTTP
// gateway. Configured from the environment (see ../.env.example).
//
//   DEVICE_SALT=... LOG_DIR=... CONTENT_DIR=... npx tsx src/main.ts

import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Dashboard } from "./dashboard";
import { DailyFeedbackLog } from "./feedback";
import { FnnRpcClient } from "./fnn";
import { HttpGate } from "./http-gate";
import { DailyJsonlLog, TeeLog, type LogLine } from "./log";
import { createMeterServer } from "./server";
import { DEFAULT_LIMITS, SessionManager, type WebLimits } from "./sessions";

const POLL_MS = 250;
const TICK_MS = 1_000;
const REAP_MS = 10_000;
const LOG_PREFIX = "web";

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === "") throw new Error(`missing env ${name}`);
  return v;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer`);
  return n;
}

const salt = env("DEVICE_SALT");
if (salt.length < 32) throw new Error("DEVICE_SALT must be at least 32 characters (openssl rand -hex 16)");
const logDir = env("LOG_DIR");
const contentDir = env("CONTENT_DIR");
const price = BigInt(env("CHUNK_PRICE_SHANNONS", "10000000"));
const host = env("LISTEN_HOST", "127.0.0.1");
const port = envInt("LISTEN_PORT", 8300);
const limits: WebLimits = {
  maxSessions: envInt("MAX_SESSIONS", DEFAULT_LIMITS.maxSessions),
  maxSessionsPerIp: envInt("MAX_SESSIONS_PER_IP", DEFAULT_LIMITS.maxSessionsPerIp),
  newSessionsPerIpPerMin: envInt("NEW_SESSIONS_PER_IP_PER_MIN", DEFAULT_LIMITS.newSessionsPerIpPerMin),
  sessionMaxBytes: envInt("SESSION_MAX_BYTES", DEFAULT_LIMITS.sessionMaxBytes),
  sessionBytesPerSec: envInt("SESSION_BYTES_PER_SEC", DEFAULT_LIMITS.sessionBytesPerSec),
  idleEndMs: envInt("IDLE_END_MS", DEFAULT_LIMITS.idleEndMs),
  cutRetainMs: envInt("CUT_RETAIN_MS", DEFAULT_LIMITS.cutRetainMs),
};

mkdirSync(logDir, { recursive: true });
const dashboard = new Dashboard();
// Rebuild the dashboard from earlier days' logs, so a restart keeps history.
for (const f of readdirSync(logDir).filter((n) => n.startsWith(`${LOG_PREFIX}-`) && n.endsWith(".jsonl")).sort()) {
  for (const line of readFileSync(join(logDir, f), "utf8").split("\n")) {
    if (line.trim()) dashboard.write(JSON.parse(line) as LogLine);
  }
}

const gate = new HttpGate();
const sessions = new SessionManager({
  meter: {
    fnn: new FnnRpcClient(env("BOX_RPC", "http://127.0.0.1:8227")),
    log: new TeeLog(new DailyJsonlLog(logDir, LOG_PREFIX), dashboard),
    now: Date.now,
    chunkPriceShannons: price,
    deviceSalt: salt,
  },
  gate,
  limits,
  now: Date.now,
});
dashboard.live = (id) => {
  const s = sessions.bySession(id);
  return s && { bytes_used: s.meter.snapshot.usedBytes, allowance_bytes: s.meter.snapshot.allowanceBytes };
};

const feedback = new DailyFeedbackLog(logDir);
const server = createMeterServer({ sessions, gate, dashboard, feedback, contentDir, priceShannons: price });
const loops = [
  setInterval(() => void sessions.pollAll(), POLL_MS),
  setInterval(() => void sessions.tickAll().catch((e) => console.error("meterd: tick:", e)), TICK_MS),
  setInterval(() => void sessions.reap().catch((e) => console.error("meterd: reap:", e)), REAP_MS),
];

server.listen(port, host, () => {
  console.log(`meterd listening on http://${host}:${port}; logs ${logDir}; content ${contentDir}`);
  console.log(`limits ${JSON.stringify(limits)}; price ${price} shannons per 2 MB`);
});

let stopping = false;
async function stop(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`meterd: ${signal}, ending sessions`);
  loops.forEach(clearInterval);
  server.close();
  await sessions.shutdown();
  process.exit(0);
}
process.on("SIGTERM", () => void stop("SIGTERM"));
process.on("SIGINT", () => void stop("SIGINT"));
