// One device's meter loop: the pure state machine wired to FNN invoices,
// a Gate and the JSON-lines log. The caller drives it: requestChunk() when
// the device asks for data, poll() and tick() on a timer, usage() whenever
// fresh byte counters arrive.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { toHex, type FnnClient, type Hex } from "./fnn";
import type { Gate } from "./gate";
import type { LogEntry, MeterLog } from "./log";
import { cutDueAtMs, initialSession, needsInvoice, step, type MeterEvent, type MeterSession } from "./meter";

export const INVOICE_EXPIRY_SEC = 120;

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

  constructor(
    private readonly deps: MeterDeps,
    readonly deviceKey: string,
  ) {
    this.deviceId = hashDeviceId(deps.deviceSalt, deviceKey);
    this.session = initialSession(deps.now());
  }

  get state() {
    return this.session.state;
  }

  // Returns the invoice the device should pay next, issuing one if the meter
  // wants it, or null if nothing is due (or the device is cut).
  requestChunk(): Promise<string | null> {
    return this.serial(async () => {
      if (needsInvoice(this.session)) await this.issueInvoice();
      const latest = this.session.pendingInvoices.at(-1) as Hex | undefined;
      return latest ? this.issued.get(latest)!.address : null;
    });
  }

  poll(): Promise<void> {
    return this.serial(() => this.pollOnce());
  }

  private async pollOnce(): Promise<void> {
    for (const hash of [...this.session.pendingInvoices] as Hex[]) {
      const { status } = await this.deps.fnn.getInvoice({ payment_hash: hash });
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
    const before = this.session.state;
    this.apply({ type: "TICK", nowMs: this.deps.now() });
    if (before !== "cut" && this.session.state === "cut") {
      let closedAtMs: number | null = null;
      try {
        if (this.gateOpen) {
          this.gateOpen = false;
          await this.deps.gate.close(this.deviceKey);
        }
        closedAtMs = this.deps.now();
      } finally {
        // Written after the close returns, so t_gate_closed_ms is when access
        // actually ended. It stays null if the close threw.
        this.write({
          event: "cut",
          cutoff_reason: this.session.cutReason,
          t_exhausted_ms: this.session.graceStartedAtMs,
          t_gate_closed_ms: closedAtMs,
        });
      }
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
    if (!this.gateOpen && this.session.state === "paid") {
      this.gateOpen = true;
      await this.deps.gate.open(this.deviceKey);
      this.write({ event: "gate_opened" });
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
