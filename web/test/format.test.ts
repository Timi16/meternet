import { describe, expect, it } from "vitest";
import { ckbFromHex, ledCells, litSegments, mbLed, mbText, shortHash, txHashFromOutpoint } from "../src/format";

describe("format", () => {
  it("shows megabytes like the meter does", () => {
    expect(mbLed(0)).toBe("000.0");
    expect(mbLed(8 * 1024 * 1024)).toBe("008.0");
    expect(mbLed(123.45 * 1024 * 1024)).toBe("123.5");
    expect(mbLed(5000 * 1024 * 1024)).toBe("999.9");
    expect(mbText(2 * 1024 * 1024)).toBe("2.0 MB");
  });

  it("converts shannons to CKB", () => {
    expect(ckbFromHex("0x989680")).toBe(0.1);
    expect(ckbFromHex("0x2540be400")).toBe(100);
  });

  it("takes the funding tx hash out of a channel outpoint", () => {
    const op = "0x5df1bc868210e16da8cedf388e3923242233b3de187bb8d852742e6cab87305a00000000";
    expect(txHashFromOutpoint(op)).toBe("0x5df1bc868210e16da8cedf388e3923242233b3de187bb8d852742e6cab87305a");
    expect(txHashFromOutpoint(null)).toBeNull();
    expect(txHashFromOutpoint("0x1234")).toBeNull();
  });

  it("shortens hashes", () => {
    expect(shortHash("0x57e6eb12ec598e458735293ceac73fc9e6c6a493d25e896bc2c2593e463f0790")).toBe("0x57e6eb…0790");
  });

  it("lights the right segments", () => {
    expect(litSegments("8")).toHaveLength(7);
    expect(litSegments("1")).toBe("bc");
    expect(litSegments("x")).toBe("");
    expect(ledCells("012.4")).toEqual([
      { ch: "0", dot: false },
      { ch: "1", dot: false },
      { ch: "2", dot: true },
      { ch: "4", dot: false },
    ]);
  });
});
