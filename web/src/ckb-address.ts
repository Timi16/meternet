// CKB full-format address (bech32m), per CKB RFC 0021. Used to show the
// browser node's own testnet address so the user can fund it from the faucet.

export interface Script {
  code_hash: string;
  hash_type: "data" | "type" | "data1" | "data2";
  args: string;
}

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32M_CONST = 0x2bc830a3;
const HASH_TYPE = { data: 0, type: 1, data1: 2, data2: 4 } as const;
const FULL_FORMAT = 0x00;

function polymod(values: number[]): number {
  const gen = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = (((chk & 0x1ffffff) << 5) ^ v) >>> 0;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk = (chk ^ gen[i]!) >>> 0;
  }
  return chk;
}

function hrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (const c of hrp) out.push(c.charCodeAt(0) >> 5);
  out.push(0);
  for (const c of hrp) out.push(c.charCodeAt(0) & 31);
  return out;
}

function to5bit(bytes: Uint8Array): number[] {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out.push((acc >> bits) & 31);
    }
  }
  if (bits > 0) out.push((acc << (5 - bits)) & 31);
  return out;
}

function hexBytes(hex: string): number[] {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(h)) throw new Error(`bad hex: ${hex}`);
  const out: number[] = [];
  for (let i = 0; i < h.length; i += 2) out.push(parseInt(h.slice(i, i + 2), 16));
  return out;
}

/** Encodes a lock script as a full-format address; "ckt" is testnet. */
export function lockToAddress(lock: Script, hrp: "ckt" | "ckb" = "ckt"): string {
  const codeHash = hexBytes(lock.code_hash);
  if (codeHash.length !== 32) throw new Error("code_hash must be 32 bytes");
  const hashType = HASH_TYPE[lock.hash_type];
  if (hashType === undefined) throw new Error(`unknown hash_type: ${lock.hash_type}`);
  const payload = new Uint8Array([FULL_FORMAT, ...codeHash, hashType, ...hexBytes(lock.args)]);
  const data = to5bit(payload);
  const chk = polymod([...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0]) ^ BECH32M_CONST;
  const checksum = Array.from({ length: 6 }, (_, i) => (chk >>> (5 * (5 - i))) & 31);
  return hrp + "1" + [...data, ...checksum].map((v) => CHARSET[v]).join("");
}
