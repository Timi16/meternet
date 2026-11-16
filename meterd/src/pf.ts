// macOS hotspot firewall: pf, with macOS Internet Sharing providing the
// Wi-Fi access point (bridge100) and NAT. MeterNet's rules live in their own
// anchor under com.apple/, which macOS's default /etc/pf.conf already
// evaluates (anchor "com.apple/*"), so the system ruleset is never edited.
// The rules are in box/mac/pf.anchor; this module only manages the <paid>
// table and reads it.
//
// - open(ip):  pfctl -a <anchor> -t paid -T add <ip>
// - close(ip): pfctl -a <anchor> -t paid -T delete <ip>, then pfctl -k <ip>
//   so connections already open stop at once (fail closed: any error throws
//   and the meter retries).
// - usage():   pfctl -a <anchor> -t paid -vT show. Per-address In/Pass and
//   Out/Pass bytes (pfctl(8): packets passed by state are accounted to the
//   table entry, so download bytes count too).
// - identify(ip): arp -an -i <iface>. macOS prints MACs without leading
//   zeros ("e5:3"), so they are normalized.

import { execFile } from "node:child_process";
import type { Firewall } from "./firewall";
import type { Runner } from "./ndsctl";

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const RUN_TIMEOUT_MS = 5_000;

export function commandRunner(bin: string): Runner {
  return (args) =>
    new Promise((resolve) => {
      execFile(bin, args, { timeout: RUN_TIMEOUT_MS }, (err, stdout, stderr) => {
        const code = err ? (typeof err.code === "number" ? err.code : -1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      });
    });
}

export function normalizeMac(mac: string): string | null {
  const parts = mac.trim().toLowerCase().split(":");
  if (parts.length !== 6 || !parts.every((p) => /^[0-9a-f]{1,2}$/.test(p))) return null;
  return parts.map((p) => p.padStart(2, "0")).join(":");
}

// `pfctl -t paid -vT show`: an address line, then counter lines.
export function parsePfTable(text: string): Map<string, number> {
  const out = new Map<string, number>();
  let current: string | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (IPV4.test(line)) {
      current = line;
      out.set(current, 0);
      continue;
    }
    const m = /^(In|Out)\/Pass:\s*\[\s*Packets:\s*\d+\s+Bytes:\s*(\d+)\s*\]/.exec(line);
    if (m && current) out.set(current, out.get(current)! + Number(m[2]));
  }
  return out;
}

// `arp -an -i <iface>`: "? (192.168.2.5) at 3a:1f:9:aa:b:c on bridge100 ...".
export function parseArp(text: string, iface: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split("\n")) {
    const m = /^\? \((\d+\.\d+\.\d+\.\d+)\) at (\S+) on (\S+)/.exec(line.trim());
    if (!m || m[3] !== iface) continue;
    const mac = normalizeMac(m[2]!);
    if (mac) out.set(m[1]!, mac);
  }
  return out;
}

export interface PfOptions {
  pfctl?: Runner;
  arp?: Runner;
  // Default com.apple/meternet; box/mac/hotspot.sh loads the rules there.
  anchor?: string;
  // Internet Sharing's bridge; macOS uses bridge100.
  iface?: string;
}

export class PfFirewall implements Firewall {
  private readonly pfctl: Runner;
  private readonly arp: Runner;
  private readonly anchor: string;
  private readonly iface: string;

  constructor(o: PfOptions = {}) {
    this.pfctl = o.pfctl ?? commandRunner("/sbin/pfctl");
    this.arp = o.arp ?? commandRunner("/usr/sbin/arp");
    this.anchor = o.anchor ?? "com.apple/meternet";
    this.iface = o.iface ?? "bridge100";
  }

  async open(ip: string): Promise<void> {
    await this.table("add", ip);
  }

  async close(ip: string): Promise<void> {
    await this.table("delete", ip);
    await this.must(["-k", ip]);
  }

  async usage(): Promise<Map<string, number>> {
    const r = await this.must(["-a", this.anchor, "-t", "paid", "-vT", "show"]);
    return parsePfTable(r.stdout);
  }

  async identify(ip: string): Promise<{ key: string; mac: string } | null> {
    const mac = (await this.arpTable()).get(ip);
    return mac ? { key: ip, mac } : null;
  }

  async clients(): Promise<{ key: string; mac: string }[]> {
    return [...(await this.arpTable())].map(([ip, mac]) => ({ key: ip, mac }));
  }

  private async arpTable(): Promise<Map<string, string>> {
    const r = await this.arp(["-an", "-i", this.iface]);
    if (r.code !== 0) throw new Error(`arp exited ${r.code}: ${(r.stdout + r.stderr).trim()}`);
    return parseArp(r.stdout, this.iface);
  }

  private async table(op: "add" | "delete", ip: string): Promise<void> {
    if (!IPV4.test(ip)) throw new Error(`pf ${op}: not an IPv4 address: ${JSON.stringify(ip)}`);
    await this.must(["-a", this.anchor, "-t", "paid", "-T", op, ip]);
  }

  private async must(args: string[]) {
    const r = await this.pfctl(args);
    if (r.code !== 0) throw new Error(`pfctl ${args.join(" ")} exited ${r.code}: ${(r.stdout + r.stderr).trim()}`);
    return r;
  }
}
