// The web MVP's gate: which sessions the metered gateway may serve. Closing a
// session also destroys its in-flight responses, so a cut stops data
// mid-download instead of after the current file.

import type { ServerResponse } from "node:http";
import type { Gate } from "./gate";

export class HttpGate implements Gate {
  private readonly openKeys = new Set<string>();
  private readonly streams = new Map<string, Set<ServerResponse>>();

  async open(key: string): Promise<void> {
    this.openKeys.add(key);
  }

  async close(key: string): Promise<void> {
    this.openKeys.delete(key);
    for (const res of this.streams.get(key) ?? []) res.destroy();
    this.streams.delete(key);
  }

  isOpen(key: string): boolean {
    return this.openKeys.has(key);
  }

  // Registers a response so close() can end it; forgets it when it finishes.
  track(key: string, res: ServerResponse): void {
    let set = this.streams.get(key);
    if (!set) this.streams.set(key, (set = new Set()));
    set.add(res);
    res.on("close", () => {
      set.delete(res);
      if (set.size === 0 && this.streams.get(key) === set) this.streams.delete(key);
    });
  }
}
