// meterd on the hotspot box: meters each device on the Wi-Fi through the
// firewall (openNDS on Linux, pf on macOS). Configured from the environment.
//
//   FIREWALL=opennds DEVICE_SALT=... LOG_DIR=... STATE_DIR=... BOX_WSS=... npx tsx src/main-hotspot.ts
//
// BOX_WSS is the box's Fiber node as browsers dial it, with its peer id:
//   /dns4/<name>.duckdns.org/tcp/8443/wss/p2p/<peer id>
// If unset, the first wss address the node announces (node_info) is used.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DailyFeedbackLog } from "./feedback";
import type { Firewall } from "./firewall";
import { OpenNdsFirewall } from "./firewall";
import { FnnRpcClient } from "./fnn";
import { createHotspotServer } from "./hotspot-server";
import { FileCreditStore, Hotspot } from "./hotspot";
import { DailyJsonlLog } from "./log";
import { CHUNK_BYTES } from "./meter";
import { PfFirewall } from "./pf";

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === "") throw new Error(`missing env ${name}`);
  return v;
}

const salt = env("DEVICE_SALT");
if (salt.length < 32) throw new Error("DEVICE_SALT must be at least 32 characters (openssl rand -hex 16)");
const logDir = env("LOG_DIR");
const stateDir = env("STATE_DIR");
const price = BigInt(env("CHUNK_PRICE_SHANNONS", "10000000"));
const host = env("LISTEN_HOST", "127.0.0.1");
const port = Number(env("LISTEN_PORT", "8400"));
const kind = env("FIREWALL", process.platform === "darwin" ? "pf" : "opennds");

mkdirSync(logDir, { recursive: true });
mkdirSync(stateDir, { recursive: true, mode: 0o700 });

const firewall: Firewall =
  kind === "pf" ? new PfFirewall({ iface: env("PF_IFACE", "bridge100") }) : new OpenNdsFirewall();
const fnn = new FnnRpcClient(env("BOX_RPC", "http://127.0.0.1:8227"));

const node = await fnn.call<{ pubkey: string; addresses: string[] }>("node_info");
const boxWss = process.env.BOX_WSS || node.addresses.find((a) => a.includes("/wss/"));
if (!boxWss) throw new Error("set BOX_WSS (or announce a wss address in the box's FNN config)");

const hotspot = new Hotspot({
  meter: {
    fnn,
    log: new DailyJsonlLog(logDir, "box"),
    now: Date.now,
    chunkPriceShannons: price,
    deviceSalt: salt,
  },
  firewall,
  credits: new FileCreditStore(join(stateDir, "credits.json")),
  now: Date.now,
});
await hotspot.start();

const server = createHotspotServer({
  hotspot,
  info: {
    box_wss: boxWss,
    box_pubkey: node.pubkey,
    ckb_rpc: "/ckb-rpc",
    price_shannons: price.toString(),
    chunk_bytes: CHUNK_BYTES,
  },
  feedback: new DailyFeedbackLog(logDir),
  now: Date.now,
});

const loops = [
  setInterval(() => void hotspot.pollInvoices(), 250),
  setInterval(() => void hotspot.pollUsage().catch((e) => console.error("meterd: usage:", e)), 1_000),
  setInterval(() => void hotspot.tickAll().catch((e) => console.error("meterd: tick:", e)), 1_000),
  setInterval(() => void hotspot.reap().catch((e) => console.error("meterd: reap:", e)), 10_000),
];

server.listen(port, host, () => {
  console.log(`meterd hotspot (${kind}) on http://${host}:${port}; box node ${node.pubkey}; wss ${boxWss}`);
});

// Paid credit is already saved; on a stop we just leave. Devices keep their
// credit and are let back in when meterd and the firewall come back.
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    loops.forEach(clearInterval);
    server.close();
    process.exit(0);
  });
}
