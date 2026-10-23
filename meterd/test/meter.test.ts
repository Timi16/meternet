import { describe, expect, it } from "vitest";
import { CHUNK_BYTES, GRACE_MS, initialSession, step } from "../src/meter";

describe("meter", () => {
  it("starts unpaid", () => {
    const s = initialSession();
    expect(s.state).toBe("unpaid");
    expect(s.allowanceBytes).toBe(0);
  });

  // Expected to FAIL at week 0: the grace -> cut transition is not implemented.
  it("cuts an unpaid session within 15s after the allowance is used", () => {
    let s = initialSession(0);
    s = step(s, { type: "PAYMENT_CONFIRMED" });
    s = step(s, { type: "TICK", nowMs: 1_000 });
    s = step(s, { type: "USAGE_UPDATE", bytes: CHUNK_BYTES });
    expect(s.state).toBe("grace");

    s = step(s, { type: "TICK", nowMs: 1_000 + GRACE_MS });
    expect(s.state).toBe("cut");
  });
});
