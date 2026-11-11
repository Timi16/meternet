// Week 2, step 1: can the official browser node reach the MeterNet FNN over
// wss? Starts fiber-js, shows the node's testnet address, then runs
// connect_peer to the box and waits until list_peers shows it.
// Progress goes to the page and to window.spike, for scripts/browser-spike.mjs.

import { Fiber, randomSecretKey } from "@nervosnetwork/fiber-js";
import { parseDocument } from "yaml";
import { lockToAddress, type Script } from "./ckb-address";

declare const __BOX_ADDR__: string;
declare const __BOX_PUBKEY__: string;
declare const __CKB_RPC__: string;

const PEER_TIMEOUT_MS = 30_000;

interface SpikeState {
  stage: "starting" | "started" | "connecting" | "connected" | "failed";
  t0: number;
  startedMs?: number;
  connectedMs?: number;
  pubkey?: string;
  address?: string;
  peerAddress?: string;
  error?: string;
}

const state: SpikeState = { stage: "starting", t0: performance.now() };
(window as unknown as { spike: SpikeState }).spike = state;

function log(msg: string): void {
  const line = `${((performance.now() - state.t0) / 1000).toFixed(2)}s  ${msg}`;
  console.log(line);
  const el = document.getElementById("log");
  if (el) el.textContent += line + "\n";
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (h: string) => new Uint8Array(h.match(/../g)!.map((x) => parseInt(x, 16)));

// Testnet only. Keys stay in this browser so the channel survives a reload.
function loadKey(name: string): Uint8Array {
  try {
    const saved = localStorage.getItem(name);
    if (saved && /^[0-9a-f]{64}$/.test(saved)) return unhex(saved);
  } catch {
    /* storage blocked: use a fresh key for this tab */
  }
  const key = randomSecretKey();
  try {
    localStorage.setItem(name, hex(key));
  } catch {
    /* ignore */
  }
  return key;
}

async function main(): Promise<void> {
  if (!crossOriginIsolated) throw new Error("page is not cross-origin isolated (COOP/COEP headers missing)");

  const fiber = new Fiber();
  const config = parseDocument(fiber.getDefaultConfig("testnet", __CKB_RPC__), { schema: "failsafe" });
  // From the fiber-js README: browser nodes can't use the TCP bootnodes.
  config.setIn(["fiber", "listening_addr"], "/ip4/127.0.0.1/tcp/8228");
  config.setIn(["fiber", "bootnode_addrs"], [__BOX_ADDR__]);
  // A string on purpose: the failsafe schema can't serialize a boolean ("Tag
  // not resolved for Boolean value", the README's `false` throws), and it
  // writes this string unquoted, so FNN reads a plain YAML `false`.
  config.setIn(["fiber", "announce_listening_addr"], "false");

  log("starting fiber-js 0.9.1");
  await fiber.start(
    config.toString({ lineWidth: 0 }),
    loadKey("meternet.fiberKey"),
    loadKey("meternet.ckbKey"),
    undefined,
    "info",
    "/meternet",
  );
  state.startedMs = Math.round(performance.now() - state.t0);
  state.stage = "started";
  // For scripts/browser-bridge.mjs, which drives this node from a test script.
  (window as unknown as { fiber: Fiber }).fiber = fiber;

  const info = await fiber.nodeInfo();
  state.pubkey = info.pubkey;
  state.address = lockToAddress(info.default_funding_lock_script as Script);
  log(`node started in ${state.startedMs} ms, pubkey ${info.pubkey}`);
  log(`testnet address (fund this from the faucet): ${state.address}`);

  state.stage = "connecting";
  log(`connect_peer ${__BOX_ADDR__}`);
  const tConnect = performance.now();
  await fiber.connectPeer({ address: __BOX_ADDR__ });
  while (performance.now() - tConnect < PEER_TIMEOUT_MS) {
    const box = (await fiber.listPeers()).peers.find((p) => p.pubkey === __BOX_PUBKEY__);
    if (box) {
      state.connectedMs = Math.round(performance.now() - tConnect);
      state.peerAddress = box.address;
      state.stage = "connected";
      log(`connected to the MeterNet node in ${state.connectedMs} ms via ${box.address}`);
      return;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`box not in list_peers after ${PEER_TIMEOUT_MS / 1000} s`);
}

main().catch((e: unknown) => {
  state.stage = "failed";
  state.error = e instanceof Error ? e.message : String(e);
  log(`FAILED: ${state.error}`);
});
