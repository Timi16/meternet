// The macOS hotspot firewall (pf), against output in the format the macOS
// pfctl(8) and arp(8) man pages show (macOS 26).

import { describe, expect, it } from "vitest";
import type { RunResult } from "../src/ndsctl";
import { normalizeMac, parseArp, parsePfTable, PfFirewall } from "../src/pf";

const TABLE = `   192.168.2.5
	Cleared:     Mon Nov 16 20:01:02 2026
	In/Block:    [ Packets: 0	Bytes: 0	]
	In/Pass:     [ Packets: 120	Bytes: 15000	]
	Out/Block:   [ Packets: 0	Bytes: 0	]
	Out/Pass:    [ Packets: 900	Bytes: 1200000	]
   192.168.2.7
	Cleared:     Mon Nov 16 20:03:00 2026
	In/Block:    [ Packets: 0	Bytes: 0	]
	In/Pass:     [ Packets: 2	Bytes: 100	]
	Out/Block:   [ Packets: 0	Bytes: 0	]
	Out/Pass:    [ Packets: 1	Bytes: 60	]
`;

const ARP = `? (192.168.2.5) at 3a:1f:9:aa:b:c on bridge100 ifscope [bridge]
? (192.168.2.7) at de:ad:be:ef:0:1 on bridge100 ifscope [bridge]
? (192.168.2.9) at (incomplete) on bridge100 ifscope [bridge]
? (172.16.89.32) at 70:ae:d5:45:e5:3 on en0 ifscope permanent [ethernet]
`;

class FakeRun {
  calls: string[][] = [];
  replies = new Map<string, RunResult>();
  run = async (args: string[]) => {
    this.calls.push(args);
    return this.replies.get(args.join(" ")) ?? { code: 0, stdout: "", stderr: "" };
  };
}

describe("pf output parsing", () => {
  it("reads each address's passed bytes, both directions", () => {
    expect(parsePfTable(TABLE)).toEqual(
      new Map([
        ["192.168.2.5", 15_000 + 1_200_000],
        ["192.168.2.7", 160],
      ]),
    );
    expect(parsePfTable("")).toEqual(new Map());
  });

  it("maps addresses to MACs on the hotspot interface only, with zero-padded MACs", () => {
    expect(parseArp(ARP, "bridge100")).toEqual(
      new Map([
        ["192.168.2.5", "3a:1f:09:aa:0b:0c"],
        ["192.168.2.7", "de:ad:be:ef:00:01"],
      ]),
    );
    expect(normalizeMac("70:AE:D5:45:E5:3")).toBe("70:ae:d5:45:e5:03");
    expect(normalizeMac("nope")).toBeNull();
  });
});

describe("PfFirewall", () => {
  const anchor = "com.apple/meternet";

  it("opens and closes by adding and removing the phone's address in the paid table", async () => {
    const f = new FakeRun();
    const fw = new PfFirewall({ pfctl: f.run, arp: f.run, anchor, iface: "bridge100" });
    await fw.open("192.168.2.5");
    await fw.close("192.168.2.5");
    expect(f.calls).toEqual([
      ["-a", anchor, "-t", "paid", "-T", "add", "192.168.2.5"],
      ["-a", anchor, "-t", "paid", "-T", "delete", "192.168.2.5"],
      // Also ends its open connections, so a cut stops traffic at once.
      ["-k", "192.168.2.5"],
    ]);
  });

  it("refuses anything that isn't an IPv4 address", async () => {
    const f = new FakeRun();
    const fw = new PfFirewall({ pfctl: f.run, arp: f.run, anchor, iface: "bridge100" });
    await expect(fw.open("192.168.2.5; rm -rf /")).rejects.toThrow(/IPv4/);
    expect(f.calls).toEqual([]);
  });

  it("fails a close loudly if pfctl fails, so the meter retries (fail closed)", async () => {
    const f = new FakeRun();
    f.replies.set(["-a", anchor, "-t", "paid", "-T", "delete", "192.168.2.5"].join(" "), {
      code: 1,
      stdout: "",
      stderr: "pfctl: Permission denied",
    });
    const fw = new PfFirewall({ pfctl: f.run, arp: f.run, anchor, iface: "bridge100" });
    await expect(fw.close("192.168.2.5")).rejects.toThrow(/Permission denied/);
  });

  it("reports usage per paid address and finds a phone's MAC by its address", async () => {
    const f = new FakeRun();
    f.replies.set(["-a", anchor, "-t", "paid", "-vT", "show"].join(" "), { code: 0, stdout: TABLE, stderr: "" });
    f.replies.set(["-an", "-i", "bridge100"].join(" "), { code: 0, stdout: ARP, stderr: "" });
    const fw = new PfFirewall({ pfctl: f.run, arp: f.run, anchor, iface: "bridge100" });
    expect((await fw.usage()).get("192.168.2.5")).toBe(1_215_000);
    expect(await fw.identify("192.168.2.7")).toEqual({ key: "192.168.2.7", mac: "de:ad:be:ef:00:01" });
    expect(await fw.identify("192.168.2.99")).toBeNull();
  });
});
