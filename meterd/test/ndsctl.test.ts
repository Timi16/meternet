// The openNDS adapter, against output in the exact format openNDS v11.0.0
// prints (src/util.c: ndsctl_json_all / ndsctl_json_one / ndsctl_json_client).

import { describe, expect, it } from "vitest";
import { OpenNdsFirewall, parseProcArp } from "../src/firewall";
import { NdsctlCli, NdsGate, parseNdsJson, type RunResult } from "../src/ndsctl";

const MAC = "aa:bb:cc:dd:ee:01";
const MAC2 = "aa:bb:cc:dd:ee:02";

function client(mac: string, ip: string, state: string, downKiB: number, upKiB: number, indent = "") {
  return [
    `  ${indent}"gatewayname":"MeterNet-demo",`,
    `  ${indent}"gatewayaddress":"10.0.0.1:2050",`,
    `  ${indent}"gatewayfqdn":"disable",`,
    `  ${indent}"version":"11.0.0",`,
    `  ${indent}"client_type":"cpd_can",`,
    `  ${indent}"mac":"${mac}",`,
    `  ${indent}"ip":"${ip}",`,
    `  ${indent}"clientif":"wlan0",`,
    `  ${indent}"session_start":"1794300000",`,
    `  ${indent}"session_end":"null",`,
    `  ${indent}"last_active":"1794300042",`,
    `  ${indent}"token":"0123abcd",`,
    `  ${indent}"state":"${state}",`,
    `  ${indent}"custom":"bmE=",`,
    `  ${indent}"download_rate_limit_threshold":"null",`,
    `  ${indent}"download_packet_rate":"null",`,
    `  ${indent}"download_bucket_size":"null",`,
    `  ${indent}"upload_rate_limit_threshold":"null",`,
    `  ${indent}"upload_packet_rate":"null",`,
    `  ${indent}"upload_bucket_size":"null",`,
    `  ${indent}"download_quota":"null",`,
    `  ${indent}"upload_quota":"null",`,
    `  ${indent}"download_this_session":"${downKiB}",`,
    `  ${indent}"download_session_avg":"12.34",`,
    `  ${indent}"upload_this_session":"${upKiB}",`,
    `  ${indent}"upload_session_avg":"1.23"`,
  ].join("\n");
}

const ALL =
  `{\n  "client_list_length":"2",\n  "clients":{\n` +
  `    "${MAC}":{\n${client(MAC, "10.0.0.11", "Authenticated", 2048, 100, "    ")}\n    },\n` +
  `    "${MAC2}":{\n${client(MAC2, "10.0.0.12", "Preauthenticated", 0, 1, "    ")}\n    }\n` +
  `  }\n}\n`;
const ONE = `{\n${client(MAC, "10.0.0.11", "Authenticated", 2048, 100)}\n}\n`;

class FakeRun {
  calls: string[][] = [];
  reply: RunResult = { code: 0, stdout: "", stderr: "" };
  run = async (args: string[]) => {
    this.calls.push(args);
    return this.reply;
  };
}

describe("parseNdsJson", () => {
  it("reads every client from `ndsctl json`, with bytes = KiB x 1024", () => {
    expect(parseNdsJson(ALL)).toEqual([
      { mac: MAC, ip: "10.0.0.11", state: "Authenticated", downloadBytes: 2048 * 1024, uploadBytes: 100 * 1024 },
      { mac: MAC2, ip: "10.0.0.12", state: "Preauthenticated", downloadBytes: 0, uploadBytes: 1024 },
    ]);
  });

  it("reads one client from `ndsctl json <mac>`, and {} as none", () => {
    expect(parseNdsJson(ONE)).toEqual([
      { mac: MAC, ip: "10.0.0.11", state: "Authenticated", downloadBytes: 2048 * 1024, uploadBytes: 100 * 1024 },
    ]);
    expect(parseNdsJson("{}\n")).toEqual([]);
  });

  it("rejects output it doesn't understand instead of guessing usage", () => {
    expect(() => parseNdsJson("not json")).toThrow();
    expect(() => parseNdsJson(ONE.replace(/"download_this_session":"\d+"/, '"download_this_session":"lots"'))).toThrow();
  });
});

describe("NdsctlCli", () => {
  it("authenticates and deauthenticates by MAC", async () => {
    const f = new FakeRun();
    const nds = new NdsctlCli(f.run);
    await nds.auth(MAC);
    await nds.deauth(MAC);
    expect(f.calls).toEqual([
      ["auth", MAC],
      ["deauth", MAC],
    ]);
  });

  it("throws when ndsctl fails, with its output", async () => {
    const f = new FakeRun();
    f.reply = { code: 1, stdout: `Failed to authenticate client ${MAC}.`, stderr: "" };
    await expect(new NdsctlCli(f.run).auth(MAC)).rejects.toThrow(/Failed to authenticate/);
  });

  it("authenticates by MAC or IPv4, deauthenticates by MAC only, and refuses anything else", async () => {
    const f = new FakeRun();
    const nds = new NdsctlCli(f.run);
    for (const bad of ["", "aa:bb", "aa:bb:cc:dd:ee:ff; reboot", "10.0.0.256", "10.0.0.1; reboot", "-h"]) {
      await expect(nds.auth(bad)).rejects.toThrow(/MAC/);
    }
    await expect(nds.deauth("10.0.0.1")).rejects.toThrow(/MAC/);
    expect(f.calls).toEqual([]);
    await nds.auth("10.42.0.193");
    expect(f.calls).toEqual([["auth", "10.42.0.193"]]);
  });

  it("lists clients", async () => {
    const f = new FakeRun();
    f.reply = { code: 0, stdout: ALL, stderr: "" };
    const clients = await new NdsctlCli(f.run).clients();
    expect(f.calls).toEqual([["json"]]);
    expect(clients.map((c) => c.mac)).toEqual([MAC, MAC2]);
  });
});

describe("NdsGate", () => {
  it("opens with ndsctl auth and closes with ndsctl deauth", async () => {
    const f = new FakeRun();
    const gate = new NdsGate(new NdsctlCli(f.run));
    await gate.open(MAC);
    await gate.close(MAC);
    expect(f.calls).toEqual([
      ["auth", MAC],
      ["deauth", MAC],
    ]);
  });

  it("treats 'not found' on close as closed: the client is already gone", async () => {
    const f = new FakeRun();
    f.reply = { code: 1, stdout: `Client ${MAC} not found.`, stderr: "" };
    await expect(new NdsGate(new NdsctlCli(f.run)).close(MAC)).resolves.toBeUndefined();
  });

  it("fails a close for any other error, so meterd keeps retrying (fail closed)", async () => {
    const f = new FakeRun();
    f.reply = { code: 3, stdout: "", stderr: "ndsctl: opennds probably not started" };
    await expect(new NdsGate(new NdsctlCli(f.run)).close(MAC)).rejects.toThrow();
  });
});

describe("ndsctl concurrency (openNDS runs one command at a time)", () => {
  it("retries when ndsctl says it is busy (exit 4)", async () => {
    let n = 0;
    const run = async (args: string[]): Promise<RunResult> => {
      n++;
      return n < 3
        ? { code: 4, stdout: "ndsctl thread is busy, please try later.", stderr: "" }
        : { code: 0, stdout: args[0] === "json" ? ALL : "", stderr: "" };
    };
    const nds = new NdsctlCli(run, { busyRetryMs: 1 });
    expect((await nds.clients()).map((c) => c.mac)).toEqual([MAC, MAC2]);
    expect(n).toBe(3);
  });

  it("never runs two ndsctl commands at once", async () => {
    let running = 0;
    let maxRunning = 0;
    const run = async (args: string[]): Promise<RunResult> => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return { code: 0, stdout: args[0] === "json" ? ALL : "", stderr: "" };
    };
    const nds = new NdsctlCli(run);
    await Promise.all([nds.clients(), nds.auth(MAC), nds.deauth(MAC2), nds.clients()]);
    expect(maxRunning).toBe(1);
  });

  it("gives up on busy after a few tries, so a cut retries at the meter level", async () => {
    const run = async (): Promise<RunResult> => ({ code: 4, stdout: "ndsctl thread is busy, please try later.", stderr: "" });
    await expect(new NdsctlCli(run, { busyRetryMs: 1, busyTries: 3 }).deauth(MAC)).rejects.toThrow(/busy/);
  });
});

describe("OpenNdsFirewall.identify", () => {
  const PROC_ARP = `IP address       HW type     Flags       HW address            Mask     Device
10.42.0.10       0x1         0x2         2a:0b:5c:aa:bb:cc     *        mn-gw
10.42.0.11       0x1         0x0         00:00:00:00:00:00     *        mn-gw
162.35.126.1     0x1         0x2         00:16:3e:00:00:01     *        eth0
`;

  it("reads complete neighbour entries on the hotspot interface only", () => {
    expect(parseProcArp(PROC_ARP, "mn-gw")).toEqual(new Map([["10.42.0.10", "2a:0b:5c:aa:bb:cc"]]));
  });

  it("finds a device openNDS hasn't registered yet through the neighbour table", async () => {
    const empty = async (): Promise<RunResult> => ({ code: 0, stdout: '{\n  "client_list_length":"0",\n  "clients":{\n  }\n}\n', stderr: "" });
    const fw = new OpenNdsFirewall(new NdsctlCli(empty), 500, Date.now, () => parseProcArp(PROC_ARP, "mn-gw"));
    expect(await fw.identify("10.42.0.10")).toEqual({ key: "2a:0b:5c:aa:bb:cc", mac: "2a:0b:5c:aa:bb:cc" });
    expect(await fw.identify("10.42.0.99")).toBeNull();
  });

  it("counts an auth openNDS refuses because the client is already authenticated as open", async () => {
    const refusing = (json: string) => async (args: string[]): Promise<RunResult> =>
      args[0] === "json" ? { code: 0, stdout: json, stderr: "" } : { code: 1, stdout: "No", stderr: "" };
    const fw = (json: string) => new OpenNdsFirewall(new NdsctlCli(refusing(json)), 500, Date.now, () => new Map());
    await expect(fw(ALL).open(MAC)).resolves.toBeUndefined(); // MAC is Authenticated in ALL
    await expect(fw(ALL).open(MAC2)).rejects.toThrow(/exited 1/); // MAC2 is Preauthenticated
  });

  it("lists devices on the hotspot that openNDS doesn't know yet (after a restart)", async () => {
    const run = async (): Promise<RunResult> => ({ code: 0, stdout: ALL, stderr: "" });
    const fw = new OpenNdsFirewall(new NdsctlCli(run), 500, Date.now, () => parseProcArp(PROC_ARP, "mn-gw"));
    expect((await fw.clients()).map((c) => c.mac).sort()).toEqual(["2a:0b:5c:aa:bb:cc", MAC, MAC2]);
  });

  // openNDS's preemptive auth by MAC takes the first `ip neigh` match, which
  // can be an address the phone had before its current DHCP lease.
  it("authenticates a device by the address it is using now", async () => {
    const calls: string[][] = [];
    const run = async (args: string[]): Promise<RunResult> => {
      calls.push(args);
      return args[0] === "json"
        ? { code: 0, stdout: '{\n  "client_list_length":"0",\n  "clients":{\n  }\n}\n', stderr: "" }
        : { code: 0, stdout: "", stderr: "" };
    };
    const fw = new OpenNdsFirewall(new NdsctlCli(run), 500, Date.now, () => parseProcArp(PROC_ARP, "mn-gw"));
    await fw.open("2a:0b:5c:aa:bb:cc");
    expect(calls.at(-1)).toEqual(["auth", "2a:0b:5c:aa:bb:cc"]); // address not known yet
    await fw.identify("10.42.0.10");
    await fw.open("2a:0b:5c:aa:bb:cc");
    expect(calls.at(-1)).toEqual(["auth", "10.42.0.10"]);
  });
});

