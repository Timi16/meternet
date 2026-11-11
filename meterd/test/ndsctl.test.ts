// The openNDS adapter, against output in the exact format openNDS v11.0.0
// prints (src/util.c: ndsctl_json_all / ndsctl_json_one / ndsctl_json_client).

import { describe, expect, it } from "vitest";
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

  it("refuses anything that isn't a MAC address", async () => {
    const f = new FakeRun();
    const nds = new NdsctlCli(f.run);
    for (const bad of ["", "aa:bb", "aa:bb:cc:dd:ee:ff; reboot", "10.0.0.1"]) {
      await expect(nds.auth(bad)).rejects.toThrow(/MAC/);
    }
    expect(f.calls).toEqual([]);
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
