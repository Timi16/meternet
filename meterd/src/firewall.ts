// What the hotspot box needs from its firewall, on any OS. meterd's meter
// only ever calls open/close (the Gate); the hotspot also reads per-client
// usage and maps a portal visitor's address to its device.
//
// - Linux: openNDS (ndsctl.ts). Clients are keyed by MAC.
// - macOS: pf with Internet Sharing (pf.ts). Clients are keyed by IPv4
//   address, because pf tables hold addresses; the MAC comes from arp.
// The device ID is always hashed from the MAC, so it's the same on both.

import { readFileSync } from "node:fs";
import type { Gate } from "./gate";
import { NdsctlCli, NdsGate, type NdsClient } from "./ndsctl";

export interface Firewall extends Gate {
  // Bytes each allowed client has used, both directions, by gate key.
  usage(): Promise<Map<string, number>>;
  // The portal sees the visitor's IP; this finds its gate key and MAC.
  identify(ip: string): Promise<{ key: string; mac: string } | null>;
  // Every device currently on the hotspot, paid or not.
  clients(): Promise<{ key: string; mac: string }[]>;
}

export class OpenNdsFirewall implements Firewall {
  private readonly gate: NdsGate;
  // One `ndsctl json` serves clients(), usage() and identify() for a moment:
  // openNDS refreshes counters on every call, and calls queue behind each other.
  private snapshot: { at: number; clients: Promise<NdsClient[]> } | null = null;
  // Each device's current address, from portal requests and openNDS's list.
  // Authenticating by IP keeps openNDS off stale neighbour entries.
  private readonly ipOf = new Map<string, string>();

  constructor(
    private readonly nds: NdsctlCli = new NdsctlCli(),
    private readonly snapshotMs = 500,
    private readonly now: () => number = Date.now,
    // Devices openNDS hasn't registered yet (no plain-HTTP request so far)
    // are found in the kernel's neighbour table; openNDS can authenticate
    // them anyway (allow_preemptive_authentication, on by default).
    private readonly neighbours: () => Map<string, string> = () => readArpTable(),
  ) {
    this.gate = new NdsGate(nds);
  }

  private list(): Promise<NdsClient[]> {
    const t = this.now();
    if (!this.snapshot || t - this.snapshot.at >= this.snapshotMs) {
      const clients = this.nds.clients();
      clients.then((cs) => cs.forEach((c) => this.ipOf.set(c.mac, c.ip))).catch(() => undefined);
      this.snapshot = { at: t, clients };
      clients.catch(() => (this.snapshot = null));
    }
    return this.snapshot.clients;
  }

  async open(mac: string): Promise<void> {
    try {
      await this.nds.auth(this.ipOf.get(mac) ?? mac);
    } catch (e) {
      // openNDS answers "No" to auth of a client it already has authenticated
      // (ndsctl_auth only authenticates Preauthenticated clients): open.
      this.snapshot = null;
      const c = (await this.list()).find((x) => x.mac === mac);
      if (c?.state !== "Authenticated") throw e;
    } finally {
      this.snapshot = null;
    }
  }

  async close(mac: string): Promise<void> {
    await this.gate.close(mac);
    this.snapshot = null;
  }

  async usage(): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    for (const c of await this.list()) {
      if (c.state === "Authenticated") out.set(c.mac, c.downloadBytes + c.uploadBytes);
    }
    return out;
  }

  async identify(ip: string): Promise<{ key: string; mac: string } | null> {
    const c = (await this.list()).find((x) => x.ip === ip);
    const mac = c?.mac ?? this.neighbours().get(ip);
    if (!mac) return null;
    this.ipOf.set(mac, ip);
    return { key: mac, mac };
  }

  // openNDS's clients, plus devices on the hotspot it hasn't registered: after
  // a box restart it knows nobody until they browse, and paid credit must
  // still be restored.
  async clients(): Promise<{ key: string; mac: string }[]> {
    const macs = new Set((await this.list()).map((c) => c.mac));
    for (const mac of this.neighbours().values()) macs.add(mac);
    return [...macs].map((mac) => ({ key: mac, mac }));
  }
}

// Linux /proc/net/arp: "IP address  HW type  Flags  HW address  Mask  Device".
// Complete entries only (flags 0x2).
export function parseProcArp(text: string, iface?: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split("\n").slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 6 || f[2] !== "0x2" || (iface && f[5] !== iface)) continue;
    if (/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(f[3]!) && f[3] !== "00:00:00:00:00:00") out.set(f[0]!, f[3]!.toLowerCase());
  }
  return out;
}

function readArpTable(): Map<string, string> {
  try {
    return parseProcArp(readFileSync("/proc/net/arp", "utf8"), process.env.GATEWAY_IFACE);
  } catch {
    return new Map();
  }
}
