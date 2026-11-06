// Shared helpers for the testnet scripts (not used by meterd itself).

import { join } from "node:path";
import { FnnRpcClient, fromHex, type Hex } from "../src/fnn";

export const env = (k: string, d?: string) => {
  const v = process.env[k] ?? d;
  if (v === undefined) throw new Error(`missing env ${k}`);
  return v;
};

export const box = new FnnRpcClient(env("BOX_RPC", "http://127.0.0.1:8227"));
export const payer = new FnnRpcClient(env("PAYER_RPC", "http://127.0.0.1:8237"));
export const LOG_DIR = env("LOG_DIR", join(import.meta.dirname, "..", "..", "logs"));
export const PRICE_SHANNONS = BigInt(env("CHUNK_PRICE_SHANNONS", "10000000"));

export interface NodeInfo {
  pubkey: string;
  version: string;
}

export interface Channel {
  channel_id: Hex;
  pubkey: string;
  is_one_way: boolean;
  is_public: boolean;
  channel_outpoint: unknown;
  state: { state_name: string };
  local_balance: Hex;
  remote_balance: Hex;
}

export interface Payment {
  payment_hash: Hex;
  payment_preimage?: Hex | null;
  status: "Created" | "Inflight" | "Success" | "Failed";
  failed_error?: string | null;
  fee: Hex;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const ckb = (h: Hex) => Number(fromHex(h)) / 1e8;

export async function waitFor<T>(
  what: string,
  timeoutMs: number,
  everyMs: number,
  f: () => Promise<T | undefined>,
): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await f();
    if (v !== undefined) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(everyMs);
  }
}

export async function readyOneWayChannel(node: FnnRpcClient, peerPubkey: string): Promise<Channel | undefined> {
  const { channels } = await node.call<{ channels: Channel[] }>("list_channels", { pubkey: peerPubkey });
  return channels.find((c) => c.state.state_name === "ChannelReady" && c.is_one_way);
}
