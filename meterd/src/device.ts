// One device's meter loop: the pure state machine wired to FNN invoices,
// a Gate and the JSON-lines log. The caller drives it: requestChunk() when
// the device asks for data, poll() and tick() on a timer, usage() whenever
// fresh byte counters arrive.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { toHex, type FnnClient, type Hex, type InvoiceStatus } from "./fnn";
import type { Gate } from "./gate";
import type { EndReason, LogEntry, MeterLog } from "./log";
import { cutDueAtMs, initialSession, needsInvoice, step, type MeterEvent, type MeterSession } from "./meter";

export const INVOICE_EXPIRY_SEC = 120;
// A failed gate close is retried until it succeeds: fail closed, never leave
// a cut device online. Backoff doubles from the first delay up to the cap.
export const GATE_RETRY_FIRST_MS = 500;
export const GATE_RETRY_MAX_MS = 5_000;

export interface MeterDeps {
  fnn: FnnClient;
  gate: Gate;
  log: MeterLog;
  now: () => number;
  chunkPriceShannons: bigint;
  // Per-box secret so hashed device IDs can't be reversed by brute-forcing MACs.
  deviceSalt: string;
  // Runs fn after delayMs and returns a cancel function. Defaults to setTimeout.
  schedule?: (delayMs: number, fn: () => void) => () => void;
  // Issue the next invoice once this much allowance is left. Defaults to
  // PREFETCH_REMAINING_BYTES (1 MB); the web gateway uses a whole chunk.
  prefetchRemainingBytes?: number;
}

function defaultSchedule(delayMs: number, fn: () => void): () => void {
  const t = setTimeout(fn, delayMs);
  t.unref();
  return () => clearTimeout(t);
}

interface IssuedInvoice {
  address: string;
  preimage: Hex;
  createdAtMs: number;
}

export function hashDeviceId(salt: string, deviceKey: string): string {
  return createHash("sha256").update(salt).update(deviceKey).digest("hex");
}

export class DeviceMeter {
  readonly deviceId: string;
  readonly sessionId = randomUUID();
  private session: MeterSession;
  private readonly issued = new Map<Hex, IssuedInvoice>();
  private gateOpen = false;
  // Serialises requestChunk() and poll(): two overlapping calls would otherwise
  // issue duplicate invoices or credit the same payment twice.
  private busy: Promise<unknown> = Promise.resolve();
  // The armed cut-deadline timer, if any. tick() on a timer stays as a backstop.
  private deadline: { dueAtMs: number; cancel: () => void } | null = null;
  // Set by end(): the session is over and the meter ignores everything.
  private ended = false;

  // deviceKey identifies the device (hashed into device_id). gateKey is what
  // the gate opens and closes: the MAC on the hotspot (the same as
  // deviceKey), or one session on the web gateway, where a browser can have
  // several sessions under one device ID.
  constructor(
    private readonly deps: MeterDeps,
    readonly deviceKey: string,
    readonly gateKey: string = deviceKey,
  ) {
    this.deviceId = hashDeviceId(deps.deviceSalt, deviceKey);
    this.session = initialSession(deps.now());
  }

  get state() {
    return this.session.state;
  }

  get snapshot(): MeterSession {
    return this.session;
  }

  // Ends a session that is not cut, e.g. one left idle: closes the gate if it
  // is open (fail closed, like a cut) and logs a session_ended line.
  async end(reason: EndReason): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    this.deadline?.cancel();
    this.deadline = null;
    if (this.session.state === "cut") return;
    if (this.gateOpen) {
      this.gateOpen = false;
      await this.closeGateUntilClosed();
    }
    this.write({ event: "session_ended", cutoff_reason: reason, t_gate_closed_ms: this.deps.now() });
  }

  // Returns the invoice the device should pay next, issuing one if the meter
  // wants it, or null if nothing is due (or the device is cut or ended).
  requestChunk(): Promise<string | null> {
    return this.serial(async () => {
      if (this.ended) return null;
      if (needsInvoice(this.session, this.deps.prefetchRemainingBytes)) await this.issueInvoice();
      return this.latestInvoice();
    });
  }

  // The invoice the device should be paying now, and its payment hash.
  get pendingInvoice(): { invoice: string; payment_hash: string } | null {
    const latest = this.session.pendingInvoices.at(-1) as Hex | undefined;
    return latest ? { invoice: this.issued.get(latest)!.address, payment_hash: latest } : null;
  }

  poll(): Promise<void> {
    return this.serial(() => this.pollOnce());
  }

  private latestInvoice(): string | null {
    const latest = this.session.pendingInvoices.at(-1) as Hex | undefined;
    return latest ? this.issued.get(latest)!.address : null;
  }

  private async pollOnce(): Promise<void> {
    for (const hash of [...this.session.pendingInvoices] as Hex[]) {
      const { status } = await this.deps.fnn.getInvoice({ payment_hash: hash });
      await this.settle(hash, status);
    }
  }

  // Acts on an invoice's FNN status: credit Paid, drop Expired and Cancelled.
  private async settle(hash: Hex, status: InvoiceStatus): Promise<void> {
    if (status === "Paid") await this.onPaid(hash);
    else if (status === "Expired" || status === "Cancelled") {
      this.apply({ type: "INVOICE_CLOSED", paymentHash: hash });
      this.write({
        event: status === "Expired" ? "invoice_expired" : "invoice_cancelled",
        ...this.invoiceFields(hash),
      });
      this.issued.delete(hash);
    }
  }

  usage(bytes: number): void {
    const before = this.session.state;
    this.apply({ type: "USAGE_UPDATE", bytes, nowMs: this.deps.now() });
    if (before !== "grace" && this.session.state === "grace") {
      this.write({ event: "grace_started", t_exhausted_ms: this.session.graceStartedAtMs });
    }
  }

  // Deliberately not serialised with poll(): a hung FNN call must never
  // delay a cut.
  async tick(): Promise<void> {
    if (this.ended) return;
    const before = this.session.state;
    this.apply({ type: "TICK", nowMs: this.deps.now() });
    if (before !== "cut" && this.session.state === "cut") {
      if (this.gateOpen) {
        this.gateOpen = false;
        await this.closeGateUntilClosed();
      }
      // Written after the close succeeds, so t_gate_closed_ms is when access
      // actually ended.
      this.write({
        event: "cut",
        cutoff_reason: this.session.cutReason,
        t_exhausted_ms: this.session.graceStartedAtMs,
        t_gate_closed_ms: this.deps.now(),
      });
    }
  }

  private async issueInvoice(): Promise<void> {
    const preimage = `0x${randomBytes(32).toString("hex")}` as Hex;
    const res = await this.deps.fnn.newInvoice({
      amount: toHex(this.deps.chunkPriceShannons),
      currency: "Fibt",
      description: "MeterNet 2 MB",
      payment_preimage: preimage,
      expiry: toHex(BigInt(INVOICE_EXPIRY_SEC)),
      hash_algorithm: "sha256",
    });
    const hash = res.invoice.data.payment_hash;
    this.issued.set(hash, { address: res.invoice_address, preimage, createdAtMs: this.deps.now() });
    this.apply({ type: "INVOICE_ISSUED", paymentHash: hash });
    this.write({ event: "invoice_created", ...this.invoiceFields(hash) });
  }

  private async onPaid(hash: Hex): Promise<void> {
    const paidAt = this.deps.now();
    this.apply({ type: "PAYMENT_CONFIRMED", paymentHash: hash });
    this.write({
      event: "invoice_paid",
      ...this.invoiceFields(hash),
      preimage: this.issued.get(hash)!.preimage,
      t_paid_seen_ms: paidAt,
    });
    this.issued.delete(hash);
    if (!this.gateOpen && !this.ended && this.session.state === "paid") {
      this.gateOpen = true;
      await this.deps.gate.open(this.gateKey);
      this.write({ event: "gate_opened" });
    }
  }

  private async closeGateUntilClosed(): Promise<void> {
    for (let delay = GATE_RETRY_FIRST_MS; ; delay = Math.min(delay * 2, GATE_RETRY_MAX_MS)) {
      try {
        await this.deps.gate.close(this.gateKey);
        return;
      } catch (err) {
        // One line per failed attempt, so a crash mid-retry still leaves
        // evidence that the cut was due and the gate would not close.
        this.write({
          event: "gate_close_failed",
          t_exhausted_ms: this.session.graceStartedAtMs,
          error: err instanceof Error ? err.message : String(err),
        });
        await new Promise<void>((r) => (this.deps.schedule ?? defaultSchedule)(delay, r));
      }
    }
  }

  private serial<T>(f: () => Promise<T>): Promise<T> {
    const run = this.busy.then(f, f);
    this.busy = run.catch(() => undefined);
    return run;
  }

  private apply(e: MeterEvent): void {
    this.session = step(this.session, e);
    this.syncDeadline();
  }

  // Keeps exactly one timer armed for the grace deadline while in grace.
  private syncDeadline(): void {
    if (this.ended) return;
    const due = cutDueAtMs(this.session);
    if (this.deadline && this.deadline.dueAtMs === due) return;
    this.deadline?.cancel();
    this.deadline = null;
    if (due === null) return;
    const schedule = this.deps.schedule ?? defaultSchedule;
    const cancel = schedule(Math.max(0, due - this.deps.now()), () => {
      this.deadline = null;
      // If the timer fired early, tick() leaves us in grace and re-arms.
      this.tick().catch((err) => console.error(`meterd: cut failed for ${this.deviceId}:`, err));
    });
    this.deadline = { dueAtMs: due, cancel };
  }

  private invoiceFields(hash: Hex): Partial<LogEntry> {
    const inv = this.issued.get(hash)!;
    return {
      invoice: inv.address,
      payment_hash: hash,
      hash_algorithm: "sha256",
      amount_shannons: this.deps.chunkPriceShannons.toString(),
      t_invoice_created_ms: inv.createdAtMs,
    };
  }

  private write(entry: Omit<LogEntry, "device_id" | "session_id" | "bytes_used" | "allowance_bytes">): void {
    this.deps.log.write({
      ...entry,
      ts: new Date(this.deps.now()).toISOString(),
      device_id: this.deviceId,
      session_id: this.sessionId,
      bytes_used: this.session.usedBytes,
      allowance_bytes: this.session.allowanceBytes,
    });
  }
}
