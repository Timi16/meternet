// Small pure helpers shared by the Meter and the Board.

export const MiB = 1024 * 1024;
export const SHANNONS_PER_CKB = 100_000_000;

// Megabytes as shown on the meter: one decimal, zero-padded to `width`.
export function mbLed(bytes: number, width = 5): string {
  const v = Math.min(bytes / MiB, 999.9);
  return v.toFixed(1).padStart(width, "0");
}

export function mbText(bytes: number): string {
  return `${(bytes / MiB).toFixed(1)} MB`;
}

export function ckbFromHex(hex: string): number {
  return Number(BigInt(hex)) / SHANNONS_PER_CKB;
}

export function shortHash(h: string, head = 6, tail = 4): string {
  return h.length <= head + tail + 2 ? h : `${h.slice(0, head + 2)}…${h.slice(-tail)}`;
}

// An OutPoint is serialized as tx_hash (32 bytes) + index (4 bytes LE).
export function txHashFromOutpoint(outpoint: string | null | undefined): string | null {
  return outpoint && /^0x[0-9a-f]{72}$/i.test(outpoint) ? outpoint.slice(0, 66) : null;
}

export function seconds(ms: number, digits = 1): string {
  return `${(ms / 1000).toFixed(digits)} s`;
}

// Seven-segment digits: which of a-g are lit.
const SEGMENTS: Record<string, string> = {
  "0": "abcdef",
  "1": "bc",
  "2": "abged",
  "3": "abgcd",
  "4": "fgbc",
  "5": "afgcd",
  "6": "afgedc",
  "7": "abc",
  "8": "abcdefg",
  "9": "abcdfg",
  "-": "g",
  " ": "",
};

export function litSegments(ch: string): string {
  return SEGMENTS[ch] ?? "";
}

// "012.4" -> [{ch:"0"},{ch:"1"},{ch:"2",dot:true},{ch:"4"}]
export function ledCells(text: string): { ch: string; dot: boolean }[] {
  const cells: { ch: string; dot: boolean }[] = [];
  for (const ch of text) {
    if (ch === "." && cells.length > 0) cells[cells.length - 1]!.dot = true;
    else cells.push({ ch, dot: false });
  }
  return cells;
}
