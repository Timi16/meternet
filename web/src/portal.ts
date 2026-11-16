// The hotspot box's portal (portal.html): what a phone on "MeterNet-demo"
// sees before and while it pays. The same browser wallet as the Meter
// (wallet.ts, official fiber-js), pointed at the box's own Fiber node, which
// the box reports at runtime (/api/hotspot/info). meterd knows the phone by
// its address on the Wi-Fi, so there is no session token: ask for the next
// invoice, pay it, and the box lets the phone's traffic through.

import {
  balanceCkb,
  channels,
  connectBox,
  isClosing,
  isReady,
  MIN_BALANCE_CKB,
  openChannel,
  pay,
  startWallet,
  useNode,
  WalletInUse,
  type Wallet,
} from "./wallet";

interface Info {
  box_wss: string;
  box_pubkey: string;
  ckb_rpc: string;
  price_shannons: string;
  chunk_bytes: number;
}

interface View {
  state: "idle" | "awaiting_payment" | "paid" | "grace" | "cut";
  allowance_bytes: number;
  used_bytes: number;
  gate_open: boolean;
  cut_due_in_ms: number | null;
  invoice: string | null;
}

const $ = (id: string) => document.getElementById(id)!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const mb = (b: number) => `${(b / 1024 / 1024).toFixed(1)} MB`;

async function get<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await fetch(path, { cache: "no-store", ...init });
  return { status: res.status, body: (await res.json()) as T };
}

function step(id: string, state: "active" | "done" | "error" | "", detail?: string) {
  const el = $(id);
  el.dataset.state = state;
  if (detail !== undefined) el.querySelector(".detail")!.textContent = detail;
}

let wallet: Wallet;
let paying = true;
let payments = 0;
let lastMs = 0;

async function boot() {
  const info = (await get<Info>("/api/hotspot/info")).body;
  const ckb = Number(BigInt(info.price_shannons)) / 1e8;
  $("price").textContent = `${ckb} CKB per ${mb(info.chunk_bytes)}`;
  useNode({ addr: info.box_wss, pubkey: info.box_pubkey, ckbRpc: new URL(info.ckb_rpc, location.href).href });

  step("s-wallet", "active", "Starting the wallet in this browser…");
  try {
    wallet = await startWallet();
    await connectBox(wallet.fiber);
  } catch (e) {
    step("s-wallet", "error", e instanceof WalletInUse ? e.message : `Couldn't start the wallet: ${String(e)}`);
    return;
  }
  step("s-wallet", "done", "Wallet running, connected to this hotspot's Fiber node.");

  await channelFlow();
  step("s-online", "active", "Paying for the first chunk…");
  $("controls").hidden = false;
  void payLoop();
  void statusLoop();
}

async function channelFlow() {
  for (;;) {
    const list = await channels(wallet.fiber).catch(() => []);
    if (list.some(isReady)) {
      step("s-funds", "done", "Funded.");
      step("s-channel", "done", "Channel open. Reused every time you come back.");
      return;
    }
    if (list.some((c) => !isReady(c) && !isClosing(c))) {
      step("s-channel", "active", "Channel opening: waiting for the CKB testnet to confirm it (a minute or two)…");
      await sleep(3000);
      continue;
    }
    const bal = await balanceCkb(wallet.lock).catch(() => 0);
    $("addr").textContent = wallet.address;
    if (bal < MIN_BALANCE_CKB) {
      step(
        "s-funds",
        "active",
        `This wallet has ${bal.toLocaleString()} testnet CKB and needs ${MIN_BALANCE_CKB}. ` +
          "The hotspot can't reach the faucet for you before you've paid: fund this address on mobile data, or ask the host.",
      );
      $("fund").hidden = false;
      await sleep(5000);
      continue;
    }
    $("fund").hidden = true;
    step("s-funds", "done", `${bal.toLocaleString()} testnet CKB.`);
    step("s-channel", "active", "Opening a private one-way channel to the hotspot…");
    try {
      await openChannel(wallet.fiber);
    } catch (e) {
      step("s-channel", "error", String(e));
      await sleep(5000);
    }
  }
}

async function payLoop() {
  const tried = new Set<string>();
  for (;;) {
    if (!paying) {
      await sleep(300);
      continue;
    }
    const r = await get<View>("/api/hotspot/chunk", { method: "POST" }).catch(() => null);
    const inv = r?.status === 200 ? r.body.invoice : null;
    if (!inv || tried.has(inv)) {
      await sleep(r ? 400 : 1000);
      continue;
    }
    tried.add(inv);
    const res = await pay(wallet.fiber, inv, () => note("This payment is slow (a known Fiber delay after a reconnect); waiting…")).catch(
      () => ({ status: "Failed" as const, ms: 0, hash: "" }),
    );
    if (res.status === "Success") {
      payments++;
      lastMs = res.ms;
      note(`Paid chunk ${payments} in ${(res.ms / 1000).toFixed(1)} s · ${res.hash.slice(0, 18)}…`);
    } else if (res.status === "Failed") {
      tried.delete(inv); // still open: try again
      note("Payment failed (is the channel empty?); retrying.");
      await sleep(2000);
    }
  }
}

async function statusLoop() {
  for (;;) {
    const r = await get<View>("/api/hotspot/status").catch(() => null);
    if (r?.status === 200) render(r.body);
    await sleep(1000);
  }
}

function render(v: View) {
  $("used").textContent = `${mb(v.used_bytes)} of ${mb(v.allowance_bytes)} paid`;
  $("pays").textContent = `${payments} payment${payments === 1 ? "" : "s"}${lastMs ? ` · last ${(lastMs / 1000).toFixed(1)} s` : ""}`;
  const due = v.cut_due_in_ms === null ? "" : ` Cut in ${Math.ceil(v.cut_due_in_ms / 1000)} s unless a payment lands.`;
  const text: Record<View["state"], string> = {
    idle: "Not online yet.",
    awaiting_payment: "Paying for the first chunk…",
    paid: paying ? "Online. Paying as you go." : "Online on what you've already paid for.",
    grace: `Paid data used up.${due}`,
    cut: "Cut off: payments stopped. Press resume to pay again.",
  };
  step("s-online", v.gate_open ? "done" : v.state === "cut" ? "error" : "active", text[v.state]);
  $("lamp").dataset.state = v.gate_open ? "go" : v.state === "cut" ? "stop" : "wait";
}

function note(t: string) {
  $("note").textContent = t;
}

$("toggle").addEventListener("click", () => {
  paying = !paying;
  $("toggle").textContent = paying ? "Stop paying" : "Resume paying";
});

void boot().catch((e) => step("s-wallet", "error", String(e)));
