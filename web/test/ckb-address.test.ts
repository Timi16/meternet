import { describe, expect, it } from "vitest";
import { lockToAddress } from "../src/ckb-address";

describe("lockToAddress", () => {
  it("matches the public server's known testnet address", () => {
    // node_info.default_funding_lock_script of the MeterNet server FNN. The
    // address was funded from the faucet and confirmed on the explorer.
    const lock = {
      code_hash: "0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8",
      hash_type: "type" as const,
      args: "0x08832292339b76c9acdf48f21c2a74bb64ad3386",
    };
    expect(lockToAddress(lock)).toBe(
      "ckt1qzda0cr08m85hc8jlnfp3zer7xulejywt49kt2rr0vthywaa50xwsqggsv3fyvumwmy6eh6g7gwz5a9mvjkn8psm5dp4w",
    );
  });

  it("rejects a code_hash that is not 32 bytes", () => {
    expect(() => lockToAddress({ code_hash: "0x00", hash_type: "type", args: "0x" })).toThrow();
  });
});
