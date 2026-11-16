// openNDS adapter for the hotspot box, through the `ndsctl` CLI.
// Checked against openNDS v11.0.0 (docs, and source where the docs are
// silent; see ARCHITECTURE.md "openNDS facts"):
// - `ndsctl auth <ip|mac>` / `ndsctl deauth <mac>`: exit 0 on success, 1 on
//   failure ("Client <mac> not found." for deauth of an unknown client).
//   Auth of a client openNDS hasn't seen yet (preemptive authentication)
//   looks the argument up in `ip neigh` and takes the first match, so by MAC
//   it can pick a stale address the device no longer has; by IP it can't.
//   openNDS also only adds clients whose IP is in the DHCP lease file.
// - `ndsctl json [mac]`: per-client `download_this_session` and
//   `upload_this_session` in KiB, as strings. openNDS refreshes its nftables
//   counters before printing, so each call is current.
// - The control socket is owner-only: meterd runs as openNDS's user (root).

import { execFile } from "node:child_process";
import type { Gate } from "./gate";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type Runner = (args: string[]) => Promise<RunResult>;

export interface NdsClient {
  mac: string;
  ip: string;
  // Preauthenticated, Authenticated, AuthBlocked or Trusted.
  state: string;
  downloadBytes: number;
  uploadBytes: number;
}

export interface Ndsctl {
  // By the device's current IPv4 address where known, else its MAC.
  auth(client: string): Promise<void>;
  deauth(mac: string): Promise<void>;
  clients(): Promise<NdsClient[]>;
}

const MAC = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/i;
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const RUN_TIMEOUT_MS = 5_000;

export function ndsctlRunner(bin = "/usr/bin/ndsctl"): Runner {
  return (args) =>
    new Promise((resolve) => {
      execFile(bin, args, { timeout: RUN_TIMEOUT_MS }, (err, stdout, stderr) => {
        const code = err ? (typeof err.code === "number" ? err.code : -1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      });
    });
}

function kib(c: Record<string, unknown>, field: string): number {
  const v = c[field];
  if (typeof v !== "string" || !/^\d+$/.test(v)) throw new Error(`ndsctl json: ${field} is not a whole number: ${String(v)}`);
  return Number(v) * 1024;
}

function toClient(c: Record<string, unknown>): NdsClient {
  if (typeof c.mac !== "string" || typeof c.state !== "string") throw new Error("ndsctl json: client without mac/state");
  return {
    mac: c.mac.toLowerCase(),
    ip: String(c.ip ?? ""),
    state: c.state,
    downloadBytes: kib(c, "download_this_session"),
    uploadBytes: kib(c, "upload_this_session"),
  };
}

// Parses `ndsctl json` (all clients) or `ndsctl json <mac>` (one, or {}).
export function parseNdsJson(text: string): NdsClient[] {
  const doc = JSON.parse(text) as Record<string, unknown>;
  if (doc.clients && typeof doc.clients === "object") {
    return Object.values(doc.clients as Record<string, Record<string, unknown>>).map(toClient);
  }
  if (Object.keys(doc).length === 0) return [];
  return [toClient(doc)];
}

// openNDS's control socket takes one command at a time and answers exit 4
// ("ndsctl thread is busy, please try later") to an overlapping one. So all
// calls go through one queue, and a busy answer is retried briefly; after
// busyTries the error propagates (a gate close is then retried by the meter).
const NDSCTL_BUSY = 4;

export interface NdsctlOptions {
  busyRetryMs?: number;
  busyTries?: number;
}

export class NdsctlCli implements Ndsctl {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly busyRetryMs: number;
  private readonly busyTries: number;

  constructor(
    private readonly run: Runner = ndsctlRunner(),
    o: NdsctlOptions = {},
  ) {
    this.busyRetryMs = o.busyRetryMs ?? 150;
    this.busyTries = o.busyTries ?? 10;
  }

  async auth(client: string): Promise<void> {
    await this.command("auth", client);
  }

  async deauth(mac: string): Promise<void> {
    await this.command("deauth", mac);
  }

  async clients(): Promise<NdsClient[]> {
    const r = await this.exec(["json"]);
    if (r.code !== 0) throw new NdsctlError("json", r);
    return parseNdsJson(r.stdout);
  }

  private async command(cmd: "auth" | "deauth", client: string): Promise<void> {
    if (!MAC.test(client) && !(cmd === "auth" && IPV4.test(client))) {
      throw new Error(`ndsctl ${cmd}: not a ${cmd === "auth" ? "MAC or IPv4 address" : "MAC address"}: ${JSON.stringify(client)}`);
    }
    const r = await this.exec([cmd, client]);
    if (r.code !== 0) throw new NdsctlError(cmd, r);
  }

  private exec(args: string[]): Promise<RunResult> {
    const job = this.queue.then(async () => {
      let r = await this.run(args);
      for (let i = 1; r.code === NDSCTL_BUSY && i < this.busyTries; i++) {
        await new Promise((res) => setTimeout(res, this.busyRetryMs));
        r = await this.run(args);
      }
      return r;
    });
    this.queue = job.catch(() => undefined);
    return job;
  }
}

export class NdsctlError extends Error {
  constructor(
    readonly command: string,
    readonly result: RunResult,
  ) {
    super(`ndsctl ${command} exited ${result.code}: ${(result.stdout + result.stderr).trim()}`);
    this.name = "NdsctlError";
  }
}

// The hotspot's gate: one openNDS client per device, keyed by MAC.
export class NdsGate implements Gate {
  constructor(private readonly nds: Ndsctl) {}

  open(mac: string): Promise<void> {
    return this.nds.auth(mac);
  }

  async close(mac: string): Promise<void> {
    try {
      await this.nds.deauth(mac);
    } catch (e) {
      // Unknown to openNDS means not authenticated: closed. Any other failure
      // propagates, so DeviceMeter keeps retrying (fail closed).
      if (e instanceof NdsctlError && e.result.code === 1 && /not found/i.test(e.result.stdout)) return;
      throw e;
    }
  }
}
