import { describe, expect, it } from "vitest";
import { TokenBucket } from "../src/token-bucket";

// A fake clock: sleep() advances it instead of waiting.
function clock() {
  let now = 0;
  const slept: number[] = [];
  return {
    now: () => now,
    sleep: async (ms: number) => {
      slept.push(ms);
      now += ms;
    },
    slept,
    advance: (ms: number) => void (now += ms),
  };
}

describe("TokenBucket", () => {
  it("lets a burst through, then paces at the rate", async () => {
    const c = clock();
    const b = new TokenBucket(1000, 500, c.now, c.sleep); // 1000 B/s, 500 B burst
    await b.take(500);
    expect(c.slept).toEqual([]);
    await b.take(250);
    expect(c.slept).toEqual([250]); // 250 B at 1000 B/s
  });

  it("refills with time, up to the burst", async () => {
    const c = clock();
    const b = new TokenBucket(1000, 500, c.now, c.sleep);
    await b.take(500);
    c.advance(10_000); // would be 10,000 B, capped at 500
    await b.take(500);
    expect(c.slept).toEqual([]);
    await b.take(100);
    expect(c.slept).toEqual([100]);
  });

  it("paces concurrent takers as one stream, so parallel requests can't multiply the rate", async () => {
    const c = clock();
    const b = new TokenBucket(1000, 0, c.now, c.sleep);
    await Promise.all([b.take(1000), b.take(1000), b.take(1000)]);
    expect(c.now()).toBe(3000);
  });
});
