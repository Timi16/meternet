// The hotspot box's sessions: one DeviceMeter per device on the Wi-Fi.
// The portal asks for invoices on the device's behalf (the device is known by
// its address on the hotspot, via the firewall), usage comes from the
// firewall's counters, and paid-but-unused credit is saved so a box restart
// never takes away what a device paid for (failure-lab scenario 4).
//
// The device ID is hashed from the MAC on both openNDS (Linux) and pf (macOS).

import { renameSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { DeviceMeter, type MeterDeps } from "./device";
import type { Firewall } from "./firewall";
import { CHUNK_BYTES, cutDueAtMs } from "./meter";

const REOPEN_RETRY_MS = 5_000;

export interface Credit {
  allowanceBytes: number;
  usedBytes: number;
  updatedAt: string;
}

export interface CreditStore {
  load(): Promise<Record<string, Credit>>;
  save(credits: Record<string, Credit>): Promise<void>;
}

export class MemoryCreditStore implements CreditStore {
  private data: Record<string, Credit> = {};
  async load() {
    return structuredClone(this.data);
  }
  async save(credits: Record<string, Credit>) {
    this.data = structuredClone(credits);
  }
}

// One JSON file, replaced atomically. It holds MACs, so it stays on the box
// (mode 600) and is never published; the logs only carry hashed device IDs.
export class FileCreditStore implements CreditStore {
  constructor(readonly path: string) {}
  async load() {
    return existsSync(this.path) ? (JSON.parse(readFileSync(this.path, "utf8")) as Record<string, Credit>) : {};
  }
  async save(credits: Record<string, Credit>) {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(credits, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}

export interface HotspotDeps {
  meter: Omit<MeterDeps, "gate">;
  firewall: Firewall;
  credits: CreditStore;
  now: () => number;
  maxSessions?: number;
  // A device that never paid is forgotten after this long without asking.
  idleUnpaidMs?: number;
  // A cut session stays visible this long, so the portal can show why.
  cutRetainMs?: number;
}

interface Session {
  key: string;
  mac: string;
  meter: DeviceMeter;
  // Usage before the firewall's counter last restarted (re-auth, reboot).
  base: number;
  lastCounter: number;
  lastSeenMs: number;
  // Earliest time to retry opening a paid device the firewall isn't passing.
  reopenAtMs: number;
}

export type Result = { ok: true; view: SessionView } | { ok: false; status: 403 | 503; error: string };

export interface SessionView {
  session_id: string;
  device_id: string;
  state: string;
  allowance_bytes: number;
  used_bytes: number;
  chunk_bytes: number;
  gate_open: boolean;
  cut_due_in_ms: number | null;
  invoice: string | null;
  payment_hash: string | null;
}

export class Hotspot {
  private readonly sessions = new Map<string, Session>();
  private pending: Record<string, Credit> = {};
  private usageRun: Promise<void> | null = null;
  private lastSaved = "{}";

  constructor(private readonly deps: HotspotDeps) {}

  // Loads saved credit; each device gets it back when it rejoins the Wi-Fi.
  async start(): Promise<void> {
    this.pending = await this.deps.credits.load();
    this.lastSaved = JSON.stringify(this.pending);
  }

  async status(ip: string): Promise<Result> {
    const s = await this.find(ip, false);
    return "error" in s ? s : { ok: true, view: this.view(s) };
  }

  // The invoice the device should pay next (and its status).
  async nextInvoice(ip: string): Promise<Result> {
    const s = await this.find(ip, true);
    if ("error" in s) return s;
    s.lastSeenMs = this.deps.now();
    await s.meter.requestChunk();
    return { ok: true, view: this.view(s) };
  }

  async pollInvoices(): Promise<void> {
    await Promise.all(
      [...this.sessions.values()]
        .filter((s) => s.meter.snapshot.pendingInvoices.length > 0)
        .map((s) => s.meter.poll().catch((e) => console.error(`meterd: poll ${s.meter.sessionId}:`, e))),
    );
  }

  async tickAll(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((s) => s.meter.tick()));
  }

  // Restores credit for devices that rejoined, feeds the firewall's counters
  // into the meters, and saves what each device still has.
  // Runs one at a time: an overlapping call (the 1 s loop, while ndsctl is
  // slow) joins the one in progress instead of re-opening devices twice.
  pollUsage(): Promise<void> {
    this.usageRun ??= this.pollUsageOnce().finally(() => (this.usageRun = null));
    return this.usageRun;
  }

  private async pollUsageOnce(): Promise<void> {
    const present = new Set<string>();
    for (const c of await this.deps.firewall.clients()) {
      present.add(c.key);
      await this.restoreCredit(c.key, c.mac);
    }

    const counters = await this.deps.firewall.usage();
    for (const s of this.sessions.values()) {
      const counter = counters.get(s.key);
      if (counter === undefined) {
        // On the Wi-Fi with paid credit, but the firewall isn't letting it
        // through (openNDS timeout or restart): let it back in. Its counter
        // starts again from 0.
        // reopen() never throws, so one stuck device can't stop the others
        // being metered; a failed attempt is logged and retried in 5 s.
        const st = s.meter.state;
        if ((st === "paid" || st === "grace") && present.has(s.key) && this.deps.now() >= s.reopenAtMs) {
          s.base += s.lastCounter;
          s.lastCounter = 0;
          if (!(await s.meter.reopen())) s.reopenAtMs = this.deps.now() + REOPEN_RETRY_MS;
        }
        continue;
      }
      if (counter < s.lastCounter) s.base += s.lastCounter;
      s.lastCounter = counter;
      s.lastSeenMs = this.deps.now();
      s.meter.usage(s.base + counter);
    }
    await this.saveCredits();
  }

  // Forgets cut sessions once shown, and devices that never paid.
  async reap(): Promise<void> {
    const now = this.deps.now();
    for (const [key, s] of this.sessions) {
      const st = s.meter.snapshot;
      const quiet = now - s.lastSeenMs;
      if (st.state === "cut" && quiet >= (this.deps.cutRetainMs ?? 120_000)) this.sessions.delete(key);
      else if ((st.state === "idle" || st.state === "awaiting_payment") && quiet >= (this.deps.idleUnpaidMs ?? 600_000)) {
        await s.meter.end("idle");
        this.sessions.delete(key);
      }
    }
  }

  get size(): number {
    return this.sessions.size;
  }

  private liveSession(key: string): Session | undefined {
    const s = this.sessions.get(key);
    return s && s.meter.state !== "cut" ? s : undefined;
  }

  private async find(ip: string, create: boolean): Promise<Session | { ok: false; status: 403 | 503; error: string }> {
    const who = await this.deps.firewall.identify(ip);
    if (!who) return { ok: false, status: 403, error: "this address is not a device on the MeterNet hotspot" };
    const restored = await this.restoreCredit(who.key, who.mac);
    if (restored) return restored;
    const existing = this.liveSession(who.key) ?? (create ? undefined : this.sessions.get(who.key));
    if (existing) return existing;
    if (!create) return { ok: false, status: 403, error: "no session yet: ask for the first invoice" };
    if (this.sessions.size >= (this.deps.maxSessions ?? 50)) {
      return { ok: false, status: 503, error: "the hotspot is full; try again in a few minutes" };
    }
    return this.create(who.key, who.mac);
  }

  // Gives a device back the paid credit it had before a box restart, the
  // first time it shows up: on the firewall, or asking the portal (whichever
  // comes first, so it never pays twice for the same data).
  private async restoreCredit(key: string, mac: string): Promise<Session | undefined> {
    const credit = this.pending[mac];
    if (!credit || this.liveSession(key)) return undefined;
    delete this.pending[mac];
    const s = this.create(key, mac);
    s.base = credit.usedBytes;
    if (await s.meter.resume(credit.allowanceBytes, credit.usedBytes)) return s;
    this.sessions.delete(key);
    return undefined;
  }

  private create(key: string, mac: string): Session {
    const meter = new DeviceMeter({ ...this.deps.meter, gate: this.deps.firewall }, mac, key);
    const s: Session = { key, mac, meter, base: 0, lastCounter: 0, lastSeenMs: this.deps.now(), reopenAtMs: 0 };
    this.sessions.set(key, s);
    return s;
  }

  private view(s: Session): SessionView {
    const snap = s.meter.snapshot;
    const due = cutDueAtMs(snap);
    const pending = s.meter.pendingInvoice;
    return {
      session_id: s.meter.sessionId,
      device_id: s.meter.deviceId,
      state: snap.state,
      allowance_bytes: snap.allowanceBytes,
      used_bytes: snap.usedBytes,
      chunk_bytes: CHUNK_BYTES,
      gate_open: s.meter.gateIsOpen,
      cut_due_in_ms: due === null ? null : Math.max(0, due - this.deps.now()),
      invoice: pending?.invoice ?? null,
      payment_hash: pending?.payment_hash ?? null,
    };
  }

  private async saveCredits(): Promise<void> {
    const out: Record<string, Credit> = { ...this.pending };
    const at = new Date(this.deps.now()).toISOString();
    for (const s of this.sessions.values()) {
      const st = s.meter.snapshot;
      if ((st.state === "paid" || st.state === "grace") && st.allowanceBytes > st.usedBytes) {
        out[s.mac] = { allowanceBytes: st.allowanceBytes, usedBytes: st.usedBytes, updatedAt: at };
      }
    }
    // Only write when something other than the timestamp changed.
    const key = JSON.stringify(Object.fromEntries(Object.entries(out).map(([m, c]) => [m, [c.allowanceBytes, c.usedBytes]])));
    if (key === this.lastSaved) return;
    this.lastSaved = key;
    await this.deps.credits.save(out);
  }
}
