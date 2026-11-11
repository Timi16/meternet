// The Meter: the public web MVP page. Boards the visitor (wallet, test CKB,
// channel), then runs a ride: the page pays meterd's invoices one at a time
// while video or a download flows through the metered gateway, and the meter
// shows meterd's own numbers. Stop paying and meterd cuts the session.

import { api, ApiError, type SessionStatus } from "./api";
import { ckbFromHex, MiB, mbLed, mbText, seconds, shortHash, txHashFromOutpoint } from "./format";
import { showLed } from "./segments";
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
  type Channel,
  type Wallet,
} from "./wallet";

type Tone = "go" | "wait" | "stop" | undefined;
type Kind = "video" | "download";

const EXPLORER_TX = "https://pudge.explorer.nervos.org/transaction/";
const CHUNK = 2 * MiB;
const STATUS_MS = 500;
const TILES = 12;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let wallet: Wallet | null = null;

interface Ride {
  token: string;
  sessionId: string;
  kind: Kind;
  paying: boolean;
  ended: boolean;
  gateOpened: boolean;
  payments: number;
  priceCkb: number;
  lastPayMs: number | null;
  download: AbortController | null;
  hls: { destroy(): void } | null;
  last: SessionStatus | null;
}
let ride: Ride | null = null;

// ---------------------------------------------------------------- display

function step(id: "wallet" | "fund" | "channel", state: "todo" | "active" | "done" | "error", detail?: string | Node) {
  const el = $(`step-${id}`);
  el.dataset.state = state;
  if (detail !== undefined) {
    const d = $(`${id}-detail`);
    d.replaceChildren(typeof detail === "string" ? document.createTextNode(detail) : detail);
  }
}

function message(text: string, tone?: Tone, countdown?: number) {
  const m = $("message");
  m.dataset.tone = tone ?? "";
  m.replaceChildren(document.createTextNode(text));
  if (countdown !== undefined) {
    const c = document.createElement("span");
    c.className = "count";
    c.textContent = ` ${String(countdown).padStart(2, "0")} s`;
    m.appendChild(c);
  }
}

function lamp(tone: Tone) {
  $("lamp").dataset.tone = tone ?? "";
}

function flag(pos: "up" | "down" | "cut") {
  $("flag").dataset.pos = pos;
  // A Chinese taxi roof sign: 空车 vacant, 载客 occupied, 停运 out of service.
  $("flag-text").textContent = pos === "cut" ? "停运" : pos === "down" ? "载客" : "空车";
  $("flag").title = pos === "cut" ? "Stopped" : pos === "down" ? "Meter running" : "For hire";
}

let tilesShown = 0;
function showMeter(used: number, paid: number, payments: number, priceCkb: number) {
  showLed($("led-used"), mbLed(used));
  showLed($("led-paid"), mbLed(paid, 4));
  showLed($("led-ckb"), (payments * priceCkb).toFixed(1).padStart(4, "0"));
  showLed($("led-count"), String(Math.min(payments, 999)).padStart(3, "0"));

  // One tile per 2 MB paid (plus the one being used past it), last TILES only.
  const tape = $("tape");
  const count = Math.max(1, Math.ceil(Math.max(paid, used) / CHUNK));
  const first = Math.max(0, count - TILES);
  tape.replaceChildren();
  for (let i = first; i < count; i++) {
    const tile = document.createElement("div");
    tile.className = "tile";
    if ((i + 1) * CHUNK <= paid) tile.classList.add("paid");
    if (i >= tilesShown) tile.classList.add("new");
    const fill = document.createElement("i");
    fill.style.height = `${Math.round(Math.min(1, Math.max(0, (used - i * CHUNK) / CHUNK)) * 100)}%`;
    tile.appendChild(fill);
    tape.appendChild(tile);
  }
  tilesShown = count;
}

function receiptReset() {
  const ol = $("receipt");
  ol.replaceChildren(Object.assign(document.createElement("li"), { className: "empty", textContent: "No payments yet" }));
}

function receiptLine(cls: string, build: (li: HTMLLIElement) => void) {
  const ol = $("receipt");
  ol.querySelector(".empty")?.remove();
  const li = document.createElement("li");
  li.className = cls;
  build(li);
  ol.appendChild(li);
  ol.scrollTop = ol.scrollHeight;
}

function receiptPayment(n: number, hash: string, ms: number, priceCkb: number) {
  receiptLine("", (li) => {
    const row = document.createElement("div");
    row.className = "row";
    for (const t of [`#${String(n).padStart(2, "0")}`, "2.0 MB", `${priceCkb.toFixed(1)} CKB`, seconds(ms, 2)]) {
      row.appendChild(Object.assign(document.createElement("span"), { textContent: t }));
    }
    const h = Object.assign(document.createElement("div"), { className: "hash", textContent: hash });
    h.appendChild(Object.assign(document.createElement("span"), { className: "seal", textContent: "已付", title: "Paid" }));
    h.title = "Payment hash. meterd logs its preimage; anyone can check sha256(preimage) = hash.";
    li.append(row, h);
  });
}

function receiptNote(text: string, cls = "note") {
  receiptLine(cls, (li) => (li.textContent = text));
}

// ---------------------------------------------------------------- boarding

async function boot() {
  showMeter(0, 0, 0, 0.1);
  flag("up");
  lamp(undefined);
  message("Starting your wallet", "wait");

  const t0 = performance.now();
  const ticker = setInterval(() => {
    const s = Math.round((performance.now() - t0) / 1000);
    $("wallet-detail").textContent = `Downloading and starting the browser Fiber node (about 7 MB)… ${s} s`;
  }, 1000);
  try {
    wallet = await startWallet();
  } catch (e) {
    step("wallet", "error", e instanceof Error ? e.message : String(e));
    $("wallet-progress").classList.add("hidden");
    message("Wallet failed to start", "stop");
    lamp("stop");
    return;
  } finally {
    clearInterval(ticker);
  }
  $("wallet-progress").classList.add("hidden");
  step("wallet", "done", `Your node ${shortHash(wallet.pubkey)} runs in this tab. Its keys stay in this browser.`);

  message("Connecting to the MeterNet node", "wait");
  try {
    await connectBox(wallet.fiber);
  } catch (e) {
    step("channel", "error", e instanceof Error ? e.message : String(e));
    message("Can't reach the MeterNet node", "stop");
    return;
  }
  await channelFlow();
}

async function channelFlow() {
  const list = await channels(wallet!.fiber);
  const ready = list.find(isReady);
  if (ready) {
    step("fund", "done", "Not needed: you already have a channel from an earlier visit.");
    return channelReady(ready);
  }
  if (list.some((c) => !isReady(c) && !isClosing(c))) {
    step("fund", "done", "Funded.");
    return waitForChannel();
  }
  await fundFlow();
}

async function fundFlow() {
  step("fund", "active");
  $("fund-actions").classList.remove("hidden");
  $("address").textContent = wallet!.address;
  $("copy-address").onclick = async () => {
    try {
      await navigator.clipboard.writeText(wallet!.address);
      $("copy-address").textContent = "Copied ✓";
    } catch {
      $("copy-address").textContent = "Select and copy it";
    }
  };
  message("Get test CKB from the faucet", "wait");

  for (;;) {
    const bal = await balanceCkb(wallet!.lock).catch(() => 0);
    if (bal >= MIN_BALANCE_CKB) {
      step("fund", "done", `Balance: ${bal.toLocaleString()} test CKB.`);
      $("fund-actions").classList.add("hidden");
      break;
    }
    step(
      "fund",
      "active",
      bal > 0
        ? `Balance: ${bal.toLocaleString()} CKB. You need at least ${MIN_BALANCE_CKB}.`
        : `Paste your address into the faucet and claim. This page notices the coins by itself (usually under a minute).`,
    );
    await sleep(5000);
  }

  step("channel", "active", "200 test CKB goes into a private, one-way channel to the MeterNet node.");
  $("channel-actions").classList.remove("hidden");
  message("Open your channel", "wait");
  const button = $<HTMLButtonElement>("open-channel");
  await new Promise<void>((resolve) => (button.onclick = () => resolve()));
  button.disabled = true;
  try {
    await openChannel(wallet!.fiber);
  } catch (e) {
    step("channel", "error", e instanceof Error ? e.message : String(e));
    button.disabled = false;
    return fundFlowRetryOpen();
  }
  $("channel-actions").classList.add("hidden");
  await waitForChannel();
}

async function fundFlowRetryOpen() {
  message("Channel failed to open. Try again", "stop");
  const button = $<HTMLButtonElement>("open-channel");
  await new Promise<void>((resolve) => (button.onclick = () => resolve()));
  button.disabled = true;
  try {
    await openChannel(wallet!.fiber);
    $("channel-actions").classList.add("hidden");
    await waitForChannel();
  } catch (e) {
    step("channel", "error", e instanceof Error ? e.message : String(e));
    button.disabled = false;
    return fundFlowRetryOpen();
  }
}

const STATE_TEXT: Record<string, string> = {
  NegotiatingFunding: "Agreeing the channel with the MeterNet node…",
  CollaboratingFundingTx: "Building the funding transaction together…",
  SigningCommitment: "Signing the first commitment…",
  AwaitingTxSignatures: "Signing the funding transaction…",
  AwaitingChannelReady: "Funding transaction sent. Waiting for CKB testnet to confirm it (1–3 min)…",
};

async function waitForChannel() {
  message("Opening your channel", "wait");
  const until = Date.now() + 20 * 60_000;
  while (Date.now() < until) {
    const list = await channels(wallet!.fiber).catch(() => [] as Channel[]);
    const ready = list.find(isReady);
    if (ready) return channelReady(ready);
    const c = list.find((x) => !isClosing(x));
    const text = (c && STATE_TEXT[c.state.state_name]) ?? "Waiting for the channel…";
    step("channel", "active", withTx(text, c?.channel_outpoint));
    await sleep(2000);
  }
  step("channel", "error", "The channel didn't open within 20 minutes. Reload to check again.");
}

function withTx(text: string, outpoint: string | null | undefined): Node {
  const frag = document.createDocumentFragment();
  frag.append(text);
  const tx = txHashFromOutpoint(outpoint);
  if (tx) {
    frag.append(" Funding tx: ");
    frag.append(Object.assign(document.createElement("a"), { href: EXPLORER_TX + tx, target: "_blank", rel: "noopener", textContent: shortHash(tx) + " ↗" }));
  }
  return frag;
}

function channelReady(c: Channel) {
  step("channel", "done", withTx(`Ready: ${ckbFromHex(c.local_balance).toFixed(1)} test CKB to spend (about ${Math.floor(ckbFromHex(c.local_balance) / 0.1) * 2} MB).`, c.channel_outpoint));
  $("ride").classList.remove("hidden");
  message("Ready. Pick a ride", "go");
  lamp("go");
  for (const b of document.querySelectorAll<HTMLButtonElement>(".choice")) {
    b.disabled = false;
    b.onclick = () => void startRide(b.dataset.kind as Kind);
  }
}

// ---------------------------------------------------------------- the ride

function rideNumber(): number {
  try {
    const n = Number(localStorage.getItem("meternet.rides") ?? "0") + 1;
    localStorage.setItem("meternet.rides", String(n));
    return n;
  } catch {
    return 1;
  }
}

async function startRide(kind: Kind) {
  for (const b of document.querySelectorAll<HTMLButtonElement>(".choice")) b.disabled = true;
  let s;
  try {
    s = await api.createSession(wallet!.pubkey);
  } catch (e) {
    message(e instanceof ApiError ? e.message : "Couldn't start a session", "stop");
    for (const b of document.querySelectorAll<HTMLButtonElement>(".choice")) b.disabled = false;
    return;
  }
  ride = {
    token: s.token,
    sessionId: s.session_id,
    kind,
    paying: true,
    ended: false,
    gateOpened: false,
    payments: 0,
    priceCkb: Number(s.price_shannons) / 1e8,
    lastPayMs: null,
    download: null,
    hls: null,
    last: s,
  };
  const n = rideNumber();
  $("ride-no").textContent = `Ride #${n}${n > 1 ? " · same channel" : ""}`;
  $("ride-kicker").textContent = kind === "video" ? "Now playing" : "Now downloading";
  $("ride-title").textContent = kind === "video" ? "Metered video" : "Metered download";
  $("choose").classList.add("hidden");
  $("screen").classList.remove("hidden");
  $("screen").dataset.mode = kind;
  $("video").classList.toggle("hidden", kind !== "video");
  $("download").classList.toggle("hidden", kind !== "download");
  overlay("Paying for the first 2 MB…", "Your browser is paying the meter. Data starts when the payment lands.");
  $("ride-hint").textContent = "Keep watching the meter. When you're ready, press STOP PAYING.";
  $("stop").classList.remove("hidden");
  $<HTMLButtonElement>("stop").disabled = false;
  keyLabel("Stop paying", "停止付款");
  receiptReset();
  tilesShown = 0;
  $("boarding").classList.add("compact");
  flag("down");
  lamp("wait");

  void payLoop(ride);
  void statusLoop(ride);
}

function keyLabel(en: string, zh: string) {
  $("stop").replaceChildren(en, Object.assign(document.createElement("span"), { className: "zh", textContent: zh }));
}

function overlay(title: string | null, small?: string, cls = "") {
  const o = $("overlay");
  if (title === null) return o.classList.add("hidden");
  o.className = `overlay ${cls}`;
  o.replaceChildren(document.createTextNode(title));
  if (small) o.appendChild(Object.assign(document.createElement("small"), { textContent: small }));
}

// One payment in flight at a time: the browser channel takes one
// unacknowledged TLC at a time (FIBER_NOTES F-005).
async function payLoop(r: Ride) {
  const tried = new Set<string>();
  while (r.paying && !r.ended) {
    let c;
    try {
      c = await api.chunk(r.token);
    } catch {
      await sleep(1000);
      continue;
    }
    if (c.state === "cut") return;
    if (c.invoice && !tried.has(c.invoice)) {
      tried.add(c.invoice);
      const res = await pay(wallet!.fiber, c.invoice, () =>
        receiptNote("This payment is slow. A known Fiber delay after a reconnect; waiting…"),
      ).catch((e: unknown) => ({ status: "Failed" as const, ms: 0, hash: "", error: String(e) }));
      if (res.status === "Success") {
        r.payments++;
        r.lastPayMs = res.ms;
        receiptPayment(r.payments, res.hash, res.ms, r.priceCkb);
      } else if (res.status === "Failed") {
        tried.delete(c.invoice); // the invoice is still open: pay it again
        receiptNote("Payment failed; retrying.");
        await sleep(1000);
      } else {
        receiptNote("Payment still pending after 150 s.");
      }
      continue;
    }
    await sleep(400);
  }
}

async function statusLoop(r: Ride) {
  while (!r.ended) {
    let s: SessionStatus;
    try {
      s = await api.status(r.token);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return finish(r, null);
      await sleep(1000);
      continue;
    }
    r.last = s;
    showMeter(s.used_bytes, s.allowance_bytes, r.payments, r.priceCkb);

    if (s.gate_open && !r.gateOpened) {
      r.gateOpened = true;
      void startMedia(r);
    }

    switch (s.state) {
      case "idle":
      case "awaiting_payment":
        message("Paying for the first 2 MB", "wait");
        lamp("wait");
        break;
      case "paid":
        if (s.capped && r.paying) message(`Session limit reached (${mbText(s.max_bytes)}). Press stop to see the cut`, "wait");
        else if (r.paying) message(`Paying · ${r.payments} payment${r.payments === 1 ? "" : "s"}${r.lastPayMs ? ` · last ${seconds(r.lastPayMs)}` : ""}`, "go");
        else message(`Not paying · paid data left ${mbText(s.allowance_bytes - s.used_bytes)}`, "wait");
        lamp(r.paying ? "go" : "wait");
        break;
      case "grace": {
        const left = Math.ceil((s.cut_due_in_ms ?? 0) / 1000);
        message(r.paying ? "Paid data used up · next payment in flight · cut in" : "Paid data used up · cut in", "wait", left);
        lamp("wait");
        break;
      }
      case "cut":
        return finish(r, s);
    }
    await sleep(STATUS_MS);
  }
}

async function startMedia(r: Ride) {
  overlay(null);
  if (r.kind === "video") {
    const video = $<HTMLVideoElement>("video");
    const url = `/gw/${r.token}/video/index.m3u8`;
    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = url;
    } else {
      const { default: Hls } = await import("hls.js");
      if (!Hls.isSupported()) return overlay("This browser can't play the video", "Try the download instead.", "stop");
      // A small buffer, so playback tracks what has been paid for.
      const hls = new Hls({ maxBufferLength: 14, maxMaxBufferLength: 20 });
      hls.loadSource(url);
      hls.attachMedia(video);
      r.hls = hls;
    }
    video.onended = () => {
      if (!r.ended) $("ride-hint").textContent = "Video finished. Press STOP PAYING to watch the meter cut you off.";
    };
    video.muted = true;
    await video.play().catch(() => undefined);
  } else {
    void download(r);
  }
}

async function download(r: Ride) {
  r.download = new AbortController();
  let got = 0;
  let total = 50 * MiB;
  let windowStart = performance.now();
  let windowBytes = 0;
  try {
    const res = await fetch(`/gw/${r.token}/files/test-50MB.bin`, { signal: r.download.signal });
    if (!res.ok || !res.body) throw new Error(`gateway ${res.status}`);
    total = Number(res.headers.get("content-length")) || total;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.byteLength;
      windowBytes += value.byteLength;
      $("dl-fill").style.width = `${(got / total) * 100}%`;
      $("dl-got").textContent = `${mbText(got)} of ${mbText(total)}`;
      const now = performance.now();
      if (now - windowStart > 1000) {
        $("dl-rate").textContent = `${((windowBytes / MiB) / ((now - windowStart) / 1000)).toFixed(2)} MB/s`;
        windowStart = now;
        windowBytes = 0;
      }
    }
    $("dl-rate").textContent = "complete";
    $("ride-hint").textContent = "Download complete. Press STOP PAYING to watch the meter cut you off.";
  } catch {
    if (!r.ended) $("dl-rate").textContent = "stopped";
  }
}

function finish(r: Ride, s: SessionStatus | null) {
  if (r.ended) return;
  r.ended = true;
  r.paying = false;
  r.download?.abort();
  r.hls?.destroy();
  const video = $<HTMLVideoElement>("video");
  video.pause();
  video.removeAttribute("src");
  video.load();

  flag("cut");
  lamp("stop");
  $("stop").classList.add("hidden");
  $("ride-hint").textContent = "Ride over. Your channel stays open for the next ride.";
  const used = s?.used_bytes ?? r.last?.used_bytes ?? 0;
  const paid = s?.allowance_bytes ?? r.last?.allowance_bytes ?? 0;
  const cutMs = s?.cut?.cutoff_ms ?? null;

  if (s && cutMs !== null) {
    message(`Stopped · cut ${seconds(cutMs)} after paid data ran out`, "stop");
    overlay("Stopped", `You stopped paying. The meter closed access ${seconds(cutMs)} after your paid data ran out.`, "stop");
    receiptNote(`*** STOPPED ${seconds(cutMs)} AFTER PAID DATA RAN OUT ***`, "final");
    receiptLine("final", (li) => li.appendChild(Object.assign(document.createElement("div"), { className: "seal big", textContent: "停运", title: "Stopped" })));
    $("result-big").replaceChildren(`Cut in ${seconds(cutMs)}`, Object.assign(document.createElement("span"), { className: "zh", textContent: `${(cutMs / 1000).toFixed(1)} 秒切断` }));
    const v = $("result-verdict");
    v.className = `verdict${s.cut?.within_deadline ? " ok" : ""}`;
    v.textContent = s.cut?.within_deadline
      ? "✓ Within the 15-second promise. 符合 15 秒承诺。"
      : "✗ Slower than the 15-second promise. This run will show up on the Board.";
  } else {
    message("Session ended", "stop");
    overlay("Session ended", "The session closed (idle for too long, or the server restarted).", "stop");
    receiptNote("*** SESSION ENDED ***", "final");
    $("result-big").textContent = "Session ended";
    $("result-verdict").textContent = "";
  }
  $("result-detail").textContent =
    `You used ${mbText(used)} and paid for ${mbText(paid)} with ${r.payments} payment${r.payments === 1 ? "" : "s"}` +
    (used <= paid ? ". Not a single unpaid byte was sent." : ".");
  $("result").classList.remove("hidden");
  $("result").scrollIntoView({ behavior: "smooth", block: "start" });
}

function stopPaying() {
  if (!ride || ride.ended) return;
  ride.paying = false;
  $<HTMLButtonElement>("stop").disabled = true;
  keyLabel("Not paying…", "已停止付款");
  receiptNote("You stopped paying.");
}

function rideAgain() {
  ride = null;
  $("result").classList.add("hidden");
  $("screen").classList.add("hidden");
  $("choose").classList.remove("hidden");
  $("ride-kicker").textContent = "Ready";
  $("ride-title").textContent = "Pick your ride";
  $("ride-hint").textContent = "Choose one. Payments start as soon as you do.";
  $("dl-fill").style.width = "0";
  $("dl-got").textContent = "0.0 MB";
  $("dl-rate").textContent = "waiting for the first payment";
  $<HTMLFormElement>("fb").reset();
  $<HTMLFormElement>("fb").querySelector("button")!.disabled = false;
  $("fb-status").textContent = "";
  tilesShown = 0;
  showMeter(0, 0, 0, 0.1);
  flag("up");
  lamp("go");
  message("Ready. Pick a ride", "go");
  for (const b of document.querySelectorAll<HTMLButtonElement>(".choice")) b.disabled = false;
  $("ride").scrollIntoView({ behavior: "smooth", block: "start" });
}

// ---------------------------------------------------------------- feedback

function buildFeedback() {
  for (const group of document.querySelectorAll<HTMLElement>(".pills")) {
    const name = group.dataset.name!;
    const options = group.dataset.options?.split(",") ?? ["1", "2", "3", "4", "5"];
    for (const value of options) {
      const id = `fb-${name}-${value}`;
      const input = Object.assign(document.createElement("input"), { type: "radio", name, value, id, required: true });
      const label = Object.assign(document.createElement("label"), { htmlFor: id, textContent: value });
      group.append(input, label);
    }
  }
  $<HTMLFormElement>("fb").onsubmit = async (ev) => {
    ev.preventDefault();
    const form = ev.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    const status = $("fb-status");
    try {
      await api.feedback({
        session_id: ride?.sessionId ?? null,
        clear: Number(data.get("clear")),
        smooth: Number(data.get("smooth")),
        would_use: data.get("would_use") as "yes" | "maybe" | "no",
        comment: ($<HTMLTextAreaElement>("fb-comment").value || null) as string | null,
      });
      status.textContent = "Thank you. It goes into the project's report.";
      form.querySelector("button")!.disabled = true;
    } catch (e) {
      status.textContent = e instanceof ApiError ? e.message : "Couldn't send. Try again.";
    }
  };
}

$("stop").onclick = stopPaying;
$("ride-again").onclick = rideAgain;
buildFeedback();
void boot();
