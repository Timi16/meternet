// openNDS adapter for the hotspot box, through the `ndsctl` CLI.
// Checked against openNDS v11.0.0 (docs, and source where the docs are
// silent; see ARCHITECTURE.md "openNDS facts"):
// - `ndsctl auth <mac>` / `ndsctl deauth <mac>`: exit 0 on success, 1 on
//   failure ("Client <mac> not found." for deauth of an unknown client).
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
  auth(mac: string): Promise<void>;
  deauth(mac: string): Promise<void>;
  clients(): Promise<NdsClient[]>;
}

const MAC = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/i;
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

export class NdsctlCli implements Ndsctl {
  constructor(private readonly run: Runner = ndsctlRunner()) {}

  async auth(mac: string): Promise<void> {
    await this.command("auth", mac);
  }

  async deauth(mac: string): Promise<void> {
    await this.command("deauth", mac);
  }

  async clients(): Promise<NdsClient[]> {
    const r = await this.run(["json"]);
    if (r.code !== 0) throw new NdsctlError("json", r);
    return parseNdsJson(r.stdout);
  }

  private async command(cmd: "auth" | "deauth", mac: string): Promise<void> {
    if (!MAC.test(mac)) throw new Error(`ndsctl ${cmd}: not a MAC address: ${JSON.stringify(mac)}`);
    const r = await this.run([cmd, mac]);
    if (r.code !== 0) throw new NdsctlError(cmd, r);
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
