// Week-1 keysend-vs-invoice trial over one existing payer->box one-way channel.
// Alternates the two modes N times each and measures, from the box's side,
// how long until meterd could credit the chunk:
//   invoice: new_invoice (sha256, our preimage) -> send_payment{invoice} -> get_invoice == Paid
//   keysend: send_payment{target_pubkey, amount, keysend} -> box list_channels local_balance rises
// Run `npm run e2e` first so the channel exists.
//
// Usage: TRIAL_N=20 npm run trial

import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fromHex, toHex, type Hex } from "../src/fnn";
import {
  box,
  env,
  LOG_DIR,
  payer,
  PRICE_SHANNONS,
  readyOneWayChannel,
  waitFor,
  type NodeInfo,
  type Payment,
} from "./lib";

const N = Number(env("TRIAL_N", "20"));
const POLL_MS = 100;
const TIMEOUT_MS = 60_000;

type Mode = "invoice" | "keysend";
interface Result {
  mode: Mode;
  i: number;
  ok: boolean;
  payment_hash: Hex | null;
  preimage_known_to_box: boolean;
  ms_box_credit: number | null;
  ms_payer_success: number | null;
  error: string | null;
}

async function payerSuccessMs(hash: Hex, t0: number): Promise<number | null> {
  try {
    return await waitFor("payer Success", TIMEOUT_MS, POLL_MS, async () => {
      const p = await payer.call<Payment>("get_payment", { payment_hash: hash });
      if (p.status === "Failed") throw new Error(p.failed_error ?? "Failed");
      return p.status === "Success" ? Date.now() - t0 : undefined;
    });
  } catch {
    return null;
  }
}

async function invoiceRun(i: number): Promise<Result> {
  const preimage = `0x${randomBytes(32).toString("hex")}` as Hex;
  const expected = `0x${createHash("sha256").update(Buffer.from(preimage.slice(2), "hex")).digest("hex")}`;
  const inv = await box.newInvoice({
    amount: toHex(PRICE_SHANNONS),
    currency: "Fibt",
    description: `MeterNet trial ${i}`,
    payment_preimage: preimage,
    expiry: toHex(120n),
    hash_algorithm: "sha256",
  });
  const hash = inv.invoice.data.payment_hash;
  if (hash !== expected) throw new Error(`payment_hash ${hash} != sha256(preimage) ${expected}`);

  const t0 = Date.now();
  await payer.call<Payment>("send_payment", { invoice: inv.invoice_address });
  const payerMs = payerSuccessMs(hash, t0);
  const boxMs = await waitFor("invoice Paid", TIMEOUT_MS, POLL_MS, async () => {
    const { status } = await box.getInvoice({ payment_hash: hash });
    if (status === "Expired" || status === "Cancelled") throw new Error(`invoice ${status}`);
    return status === "Paid" ? Date.now() - t0 : undefined;
  });
  return { mode: "invoice", i, ok: true, payment_hash: hash, preimage_known_to_box: true, ms_box_credit: boxMs, ms_payer_success: await payerMs, error: null };
}

async function keysendRun(i: number, boxPubkey: string, payerPubkey: string): Promise<Result> {
  const before = fromHex((await readyOneWayChannel(box, payerPubkey))!.local_balance);
  const t0 = Date.now();
  const sent = await payer.call<Payment>("send_payment", {
    target_pubkey: boxPubkey,
    amount: toHex(PRICE_SHANNONS),
    keysend: true,
  });
  const payerMs = payerSuccessMs(sent.payment_hash, t0);
  const boxMs = await waitFor("box balance rise", TIMEOUT_MS, POLL_MS, async () => {
    const ch = await readyOneWayChannel(box, payerPubkey);
    return ch && fromHex(ch.local_balance) - before >= PRICE_SHANNONS ? Date.now() - t0 : undefined;
  });
  return { mode: "keysend", i, ok: true, payment_hash: sent.payment_hash, preimage_known_to_box: false, ms_box_credit: boxMs, ms_payer_success: await payerMs, error: null };
}

function pct(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!;
}

async function main() {
  const boxInfo = await box.call<NodeInfo>("node_info");
  const payerInfo = await payer.call<NodeInfo>("node_info");
  if (!(await readyOneWayChannel(payer, boxInfo.pubkey))) throw new Error("no ready one-way channel; run `npm run e2e` first");

  mkdirSync(LOG_DIR, { recursive: true });
  const out = join(LOG_DIR, `trial-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
  const results: Result[] = [];
  for (let i = 1; i <= N; i++) {
    for (const mode of ["invoice", "keysend"] as const) {
      let r: Result;
      try {
        r = mode === "invoice" ? await invoiceRun(i) : await keysendRun(i, boxInfo.pubkey, payerInfo.pubkey);
      } catch (e) {
        r = { mode, i, ok: false, payment_hash: null, preimage_known_to_box: mode === "invoice", ms_box_credit: null, ms_payer_success: null, error: String(e) };
      }
      results.push(r);
      appendFileSync(out, JSON.stringify({ ts: new Date().toISOString(), fnn: boxInfo.version, ...r }) + "\n");
      console.log(`${mode.padEnd(7)} #${String(i).padStart(2)} ${r.ok ? `box ${r.ms_box_credit} ms, payer ${r.ms_payer_success} ms` : `FAILED ${r.error}`}`);
    }
  }

  console.log(`\nFNN ${boxInfo.version}, N=${N} per mode, chunk ${PRICE_SHANNONS} shannons, poll ${POLL_MS} ms`);
  for (const mode of ["invoice", "keysend"] as const) {
    const rs = results.filter((r) => r.mode === mode);
    const ms = rs.filter((r) => r.ok).map((r) => r.ms_box_credit!);
    const under5 = ms.filter((x) => x < 5_000).length;
    const line = ms.length
      ? `p50 ${pct(ms, 50)} ms, p95 ${pct(ms, 95)} ms, max ${Math.max(...ms)} ms, <5s ${under5}/${rs.length}`
      : "no successes";
    console.log(`${mode.padEnd(7)} ok ${ms.length}/${rs.length}; box credit ${line}`);
  }
  console.log(`log ${out}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
