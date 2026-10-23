// Interface to openNDS via the `ndsctl` CLI. Bodies are stubs at week 0.

// TODO(verify): the shape of `ndsctl json` output, and whether it exposes
// per-client byte counters. If not, fall back to per-device iptables counters.
export type NdsctlJson = unknown;

export interface Ndsctl {
  auth(mac: string): Promise<void>;
  deauth(mac: string): Promise<void>;
  json(): Promise<NdsctlJson>;
}

export class NdsctlCli implements Ndsctl {
  async auth(_mac: string): Promise<void> {
    throw new Error("not implemented");
  }

  async deauth(_mac: string): Promise<void> {
    throw new Error("not implemented");
  }

  async json(): Promise<NdsctlJson> {
    throw new Error("not implemented");
  }
}
