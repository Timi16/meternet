// One real testnet chunk payment, end to end, against two local FNN nodes:
//   box   = the MeterNet node meterd talks to (issues invoices)
//   payer = stands in for the browser node until week 2
// payer connects to box, opens a private one-way channel (reused if one is
// ready), then pays one meterd invoice. Writes the usual JSONL log.
//
// Usage: BOX_P2P_ADDR=/ip4/127.0.0.1/tcp/8228/p2p/<peer id> npm run e2e

import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DeviceMeter } from "../src/device";
import { FnnRpcClient, fromHex, toHex, type Hex } from "../src/fnn";
import type { Gate } from "../src/gate";
import { JsonlLog } from "../src/log";

const env = (k: string, d?: string) => {
  const v = process.env[k] ?? d;
  if (v === undefined) throw new Error(`missing env ${k}`);
  return v;
};

const box = new FnnRpcClient(env("BOX_RPC", "http://127.0.0.1:8227"));
const payer = new FnnRpcClient(env("PAYER_RPC", "http://127.0.0.1:8237"));
const BOX_P2P_ADDR = env("BOX_P2P_ADDR");
const FUNDING_SHANNONS = BigInt(env("FUNDING_CKB", "200")) * 100_000_000n;
const PRICE_SHANNONS = BigInt(env("CHUNK_PRICE_SHANNONS", "10000000"));
const LOG_DIR = env("LOG_DIR", join(import.meta.dirname, "..", "..", "logs"));

interface NodeInfo {
  pubkey: string;
  version: string;
}
interface Channel {
  channel_id: Hex;
  pubkey: string;
  is_one_way: boolean;
  is_public: boolean;
  channel_outpoint: unknown;
  state: { state_name: string };
  local_balance: Hex;
  remote_balance: Hex;
}
interface Payment {
  payment_hash: Hex;
  status: "Created" | "Inflight" | "Success" | "Failed";
  failed_error?: string | null;
  fee: Hex;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ckb = (h: Hex) => Number(fromHex(h)) / 1e8;

async function waitFor<T>(what: string, timeoutMs: number, everyMs: number, f: () => Promise<T | undefined>): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await f();
    if (v !== undefined) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(everyMs);
  }
}

async function readyChannel(boxPubkey: string): Promise<Channel> {
  const list = async () =>
    (await payer.call<{ channels: Channel[] }>("list_channels", { pubkey: boxPubkey })).channels;

  const existing = (await list()).find((c) => c.state.state_name === "ChannelReady" && c.is_one_way);
  if (existing) {
    console.log(`reusing channel ${existing.channel_id}`);
    return existing;
  }

  console.log(`open_channel: ${ckb(toHex(FUNDING_SHANNONS))} CKB, public=false, one_way=true`);
  const { temporary_channel_id } = await payer.call<{ temporary_channel_id: Hex }>("open_channel", {
    pubkey: boxPubkey,
    funding_amount: toHex(FUNDING_SHANNONS),
    public: false,
    one_way: true,
  });
  console.log(`temporary_channel_id ${temporary_channel_id}; waiting for ChannelReady (funding tx must confirm)`);
  let last = "";
  return waitFor("ChannelReady", 15 * 60_000, 3_000, async () => {
    const chans = await list();
    const states = chans.map((c) => c.state.state_name).join(",");
    if (states !== last) console.log(`  channel states: ${states || "(none)"}`), (last = states);
    return chans.find((c) => c.state.state_name === "ChannelReady" && c.is_one_way);
  });
}

async function main() {
  const boxInfo = await box.call<NodeInfo>("node_info");
  const payerInfo = await payer.call<NodeInfo>("node_info");
  console.log(`box   ${boxInfo.version} ${boxInfo.pubkey}`);
  console.log(`payer ${payerInfo.version} ${payerInfo.pubkey}`);

  await payer.call("connect_peer", { address: BOX_P2P_ADDR });
  const channel = await readyChannel(boxInfo.pubkey);
  console.log(`channel ${channel.channel_id} outpoint ${JSON.stringify(channel.channel_outpoint)}`);
  console.log(`payer side: local ${ckb(channel.local_balance)} CKB, remote ${ckb(channel.remote_balance)} CKB`);

  mkdirSync(LOG_DIR, { recursive: true });
  const logPath = join(LOG_DIR, `e2e-${new Date().toISOString().slice(0, 10)}.jsonl`);
  const gate: Gate = {
    open: async (k) => console.log(`gate: open ${k}`),
    close: async (k) => console.log(`gate: close ${k}`),
  };
  const meter = new DeviceMeter(
    {
      fnn: box,
      gate,
      log: new JsonlLog(logPath),
      now: Date.now,
      chunkPriceShannons: PRICE_SHANNONS,
      deviceSalt: env("DEVICE_SALT", randomBytes(16).toString("hex")),
    },
    `payer:${payerInfo.pubkey}`,
  );

  const invoice = (await meter.requestChunk())!;
  const t0 = Date.now();
  console.log(`invoice ${invoice}`);
  const sent = await payer.call<Payment>("send_payment", { invoice });
  console.log(`send_payment -> ${sent.status} ${sent.payment_hash}`);

  await waitFor("invoice Paid", 60_000, 250, async () => {
    await meter.poll();
    return meter.state === "paid" ? true : undefined;
  });
  const paidMs = Date.now() - t0;
  const pay = await payer.call<Payment>("get_payment", { payment_hash: sent.payment_hash });
  console.log(`PAID in ${paidMs} ms (seen by meterd); payer status ${pay.status}, fee ${fromHex(pay.fee)} shannons`);
  console.log(`payment_hash ${sent.payment_hash}`);
  console.log(`log ${logPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
