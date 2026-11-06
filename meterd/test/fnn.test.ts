import { createHash, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FnnRpcClient, FnnRpcError, fromHex, toHex, type Hex } from "../src/fnn";
import { MockFnn } from "./mock-fnn";

let mock: MockFnn;
let fnn: FnnRpcClient;

beforeEach(async () => {
  mock = await new MockFnn().start();
  fnn = new FnnRpcClient(mock.url);
});
afterEach(() => mock.stop());

describe("hex helpers", () => {
  it("round-trips u128 values as 0x hex", () => {
    expect(toHex(10_000_000n)).toBe("0x989680");
    expect(fromHex("0x989680")).toBe(10_000_000n);
    expect(toHex(0n)).toBe("0x0");
  });
});

describe("FnnRpcClient", () => {
  it("sends JSON-RPC 2.0 with params as a single-object array", async () => {
    await fnn.newInvoice({ amount: toHex(10_000_000n), currency: "Fibt" });
    expect(mock.requests).toHaveLength(1);
    const req = mock.requests[0]!;
    expect(req.jsonrpc).toBe("2.0");
    expect(req.method).toBe("new_invoice");
    expect(req.params).toEqual([{ amount: "0x989680", currency: "Fibt" }]);
  });

  it("creates a sha256 invoice whose payment hash matches our preimage", async () => {
    const preimage = ("0x" + randomBytes(32).toString("hex")) as Hex;
    const expected = "0x" + createHash("sha256").update(Buffer.from(preimage.slice(2), "hex")).digest("hex");
    const res = await fnn.newInvoice({
      amount: toHex(10_000_000n),
      currency: "Fibt",
      payment_preimage: preimage,
      hash_algorithm: "sha256",
    });
    expect(res.invoice.data.payment_hash).toBe(expected);
    expect(typeof res.invoice_address).toBe("string");
  });

  it("reads invoice status with get_invoice", async () => {
    const { invoice } = await fnn.newInvoice({ amount: toHex(1n), currency: "Fibt" });
    const hash = invoice.data.payment_hash;
    expect((await fnn.getInvoice({ payment_hash: hash })).status).toBe("Open");
    mock.setStatus(hash, "Paid");
    expect((await fnn.getInvoice({ payment_hash: hash })).status).toBe("Paid");
  });

  it("cancels an open invoice", async () => {
    const { invoice } = await fnn.newInvoice({ amount: toHex(1n), currency: "Fibt" });
    const res = await fnn.cancelInvoice({ payment_hash: invoice.data.payment_hash });
    expect(res.status).toBe("Cancelled");
  });

  it("throws FnnRpcError with the RPC error code and message", async () => {
    const err = await fnn.getInvoice({ payment_hash: "0xdead" }).catch((e) => e);
    expect(err).toBeInstanceOf(FnnRpcError);
    expect(err.code).toBe(-32000);
    expect(err.message).toContain("invoice not found");
  });
});
