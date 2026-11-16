// The visitor's browser Fiber node (official fiber-js 0.9.1): start it, reach
// the MeterNet node over wss, check funds, find or open the one-way channel.
// Keys stay in this browser (localStorage, testnet only), so a returning
// visitor gets the same node and reuses the same channel (H4).

import type { Fiber } from "@nervosnetwork/fiber-js";
import { lockToAddress, type Script } from "./ckb-address";
import { ckbFromHex, SHANNONS_PER_CKB } from "./format";

declare const __BOX_ADDR__: string;
declare const __BOX_PUBKEY__: string;
declare const __CKB_RPC__: string;

// The MeterNet node this page pays and the CKB RPC it reads: the public
// server's, built in, or a hotspot box's, which its portal sets at runtime
// from the box's /api/hotspot/info (useNode) before starting the wallet.
export interface NodeConfig {
  addr: string;
  pubkey: string;
  ckbRpc: string;
}
let node: NodeConfig = { addr: __BOX_ADDR__, pubkey: __BOX_PUBKEY__, ckbRpc: __CKB_RPC__ };
export function useNode(c: NodeConfig): void {
  node = c;
}
export const FUNDING_CKB = 200;
// 200 CKB into the channel, plus the transaction fee and a change cell.
export const MIN_BALANCE_CKB = 300;

export interface Wallet {
  fiber: Fiber;
  pubkey: string;
  lock: Script;
  address: string;
}

// The RPC's Channel (crates/fiber-lib/src/rpc/README.md). fiber-js 0.9.1's
// types lack is_one_way, so channels are read through invokeCommand.
export interface Channel {
  channel_id: string;
  channel_outpoint: string | null;
  is_one_way?: boolean;
  state: { state_name: string };
  local_balance: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (h: string) => new Uint8Array(h.match(/../g)!.map((x) => parseInt(x, 16)));

function loadKey(name: string, fresh: () => Uint8Array): Uint8Array {
  try {
    const saved = localStorage.getItem(name);
    if (saved && /^[0-9a-f]{64}$/.test(saved)) return unhex(saved);
  } catch {
    /* storage blocked: a fresh key for this tab only */
  }
  const key = fresh();
  try {
    localStorage.setItem(name, hex(key));
  } catch {
    /* ignore */
  }
  return key;
}

// One wallet per browser: every tab shares the same keys and IndexedDB, so two
// tabs would run the same node twice and the second can't connect. The first
// tab holds this lock for as long as it is open (Web Locks API; where it's
// missing, e.g. very old browsers, there's no guard).
export function claimWallet(): Promise<boolean> {
  if (!("locks" in navigator)) return Promise.resolve(true);
  return new Promise((resolve) => {
    void navigator.locks.request("meternet-wallet", { ifAvailable: true }, (lock) => {
      resolve(lock !== null);
      // Keep holding it until the tab closes.
      return lock ? new Promise<void>(() => undefined) : undefined;
    });
  });
}

export class WalletInUse extends Error {
  constructor() {
    super("MeterNet is already open in another tab of this browser. Use that tab, or close it and reload this one.");
    this.name = "WalletInUse";
  }
}

export async function startWallet(): Promise<Wallet> {
  if (!(await claimWallet())) throw new WalletInUse();
  if (!crossOriginIsolated) {
    throw new Error("This browser can't run the wallet here (the page isn't cross-origin isolated). Try Chrome or Safari.");
  }
  const [{ Fiber, randomSecretKey }, { parseDocument }] = await Promise.all([
    import("@nervosnetwork/fiber-js"),
    import("yaml"),
  ]);
  const fiber = new Fiber();
  const config = parseDocument(fiber.getDefaultConfig("testnet", node.ckbRpc), { schema: "failsafe" });
  config.setIn(["fiber", "listening_addr"], "/ip4/127.0.0.1/tcp/8228");
  config.setIn(["fiber", "bootnode_addrs"], [node.addr]);
  // A string on purpose (FIBER_NOTES F-004): written unquoted, read as false.
  config.setIn(["fiber", "announce_listening_addr"], "false");
  await fiber.start(
    config.toString({ lineWidth: 0 }),
    loadKey("meternet.fiberKey", randomSecretKey),
    loadKey("meternet.ckbKey", randomSecretKey),
    undefined,
    "error",
    "/meternet",
  );
  const info = await fiber.nodeInfo();
  const lock = info.default_funding_lock_script as Script;
  return { fiber, pubkey: info.pubkey, lock, address: lockToAddress(lock) };
}

export async function connectBox(fiber: Fiber, timeoutMs = 30_000): Promise<void> {
  await fiber.connectPeer({ address: node.addr });
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if ((await fiber.listPeers()).peers.some((p) => p.pubkey === node.pubkey)) return;
    await sleep(250);
  }
  throw new Error("Couldn't reach the MeterNet node. Check your connection and reload.");
}

// Spendable testnet CKB at the wallet's address, from the CKB RPC indexer.
export async function balanceCkb(lock: Script): Promise<number> {
  const res = await fetch(node.ckbRpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: 1,
      jsonrpc: "2.0",
      method: "get_cells_capacity",
      params: [{ script: lock, script_type: "lock" }],
    }),
  });
  const body = (await res.json()) as { result?: { capacity: string } | null };
  return body.result ? ckbFromHex(body.result.capacity) : 0;
}

export async function channels(fiber: Fiber): Promise<Channel[]> {
  const r = (await fiber.invokeCommand("list_channels", [{ pubkey: node.pubkey }])) as { channels: Channel[] };
  return r.channels.filter((c) => c.is_one_way !== false);
}

export const isReady = (c: Channel) => c.state.state_name === "ChannelReady";
export const isClosing = (c: Channel) => /Closed|ShuttingDown/.test(c.state.state_name);

// Opens the private one-way channel. connect_peer returns before the peer's
// Init message, so open_channel can fail briefly (FIBER_NOTES F-001): retry.
export async function openChannel(fiber: Fiber): Promise<void> {
  const until = Date.now() + 30_000;
  for (;;) {
    try {
      await fiber.invokeCommand("open_channel", [
        {
          pubkey: node.pubkey,
          funding_amount: "0x" + (BigInt(FUNDING_CKB) * BigInt(SHANNONS_PER_CKB)).toString(16),
          public: false,
          one_way: true,
        },
      ]);
      return;
    } catch (e) {
      if (String(e).includes("waiting for peer to send Init message") && Date.now() < until) {
        await sleep(500);
        continue;
      }
      throw new Error(`Couldn't open the channel: ${String(e)}`);
    }
  }
}

export interface PaymentResult {
  status: "Success" | "Failed" | "Inflight";
  ms: number;
}

// Pays one invoice and waits for it to settle. `onSlow` fires once if it
// takes longer than usual (FIBER_NOTES F-005: up to ~90 s after a reconnect).
export async function pay(fiber: Fiber, invoice: string, onSlow: () => void): Promise<PaymentResult & { hash: string }> {
  const t0 = performance.now();
  const sent = (await fiber.invokeCommand("send_payment", [{ invoice }])) as { payment_hash: string };
  let warned = false;
  for (;;) {
    const p = (await fiber.invokeCommand("get_payment", [{ payment_hash: sent.payment_hash }])) as {
      status: string;
    };
    const ms = Math.round(performance.now() - t0);
    if (p.status === "Success" || p.status === "Failed") {
      return { hash: sent.payment_hash, status: p.status, ms };
    }
    if (!warned && ms > 6_000) {
      warned = true;
      onSlow();
    }
    if (ms > 150_000) return { hash: sent.payment_hash, status: "Inflight", ms };
    await sleep(200);
  }
}
