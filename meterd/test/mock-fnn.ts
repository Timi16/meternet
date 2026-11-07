// In-process mock of the FNN JSON-RPC endpoint, for tests only.
// Request/response shapes follow crates/fiber-lib/src/rpc/README.md at FNN v0.9.1.
// Only sha256 invoices get a real payment hash; the invoice_address is fake.

import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { InvoiceStatus } from "../src/fnn";

interface StoredInvoice {
  invoice_address: string;
  invoice: Record<string, unknown>;
  status: InvoiceStatus;
}

export interface RecordedRequest {
  jsonrpc: unknown;
  id: unknown;
  method: string;
  params: unknown;
}

export class MockFnn {
  readonly requests: RecordedRequest[] = [];
  readonly invoices = new Map<string, StoredInvoice>();
  private server: Server | null = null;
  url = "";
  // While true, requests get no reply until releaseHung(): a stuck FNN RPC.
  hang = false;
  private hung: (() => void)[] = [];

  releaseHung(): void {
    for (const reply of this.hung.splice(0)) reply();
  }

  async start(): Promise<this> {
    this.server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const msg = JSON.parse(body) as RecordedRequest;
        this.requests.push(msg);
        const send = () => {
          const reply = this.handle(msg);
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, ...reply }));
        };
        if (this.hang) this.hung.push(send);
        else send();
      });
    });
    await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", r));
    const { port } = this.server.address() as AddressInfo;
    this.url = `http://127.0.0.1:${port}`;
    return this;
  }

  async stop(): Promise<void> {
    this.releaseHung();
    await new Promise<void>((r) => this.server?.close(() => r()));
  }

  setStatus(paymentHash: string, status: InvoiceStatus): void {
    const inv = this.invoices.get(paymentHash);
    if (!inv) throw new Error(`mock: no invoice ${paymentHash}`);
    inv.status = status;
  }

  private handle(msg: RecordedRequest): { result: unknown } | { error: { code: number; message: string } } {
    if (!Array.isArray(msg.params) || msg.params.length !== 1) {
      return { error: { code: -32602, message: "Invalid params" } };
    }
    const p = msg.params[0] as Record<string, string | undefined>;
    switch (msg.method) {
      case "new_invoice": {
        if (!p.amount?.startsWith("0x") || !p.currency) {
          return { error: { code: -32602, message: "Invalid params" } };
        }
        const paymentHash =
          p.payment_preimage && p.hash_algorithm === "sha256"
            ? "0x" + createHash("sha256").update(Buffer.from(p.payment_preimage.slice(2), "hex")).digest("hex")
            : "0x" + randomBytes(32).toString("hex");
        const stored: StoredInvoice = {
          invoice_address: `${p.currency.toLowerCase()}mock${paymentHash.slice(2, 18)}`,
          invoice: {
            currency: p.currency,
            amount: p.amount,
            signature: null,
            data: { timestamp: "0x0", payment_hash: paymentHash, attrs: [] },
          },
          status: "Open",
        };
        this.invoices.set(paymentHash, stored);
        return { result: { invoice_address: stored.invoice_address, invoice: stored.invoice } };
      }
      case "get_invoice": {
        const inv = this.invoices.get(p.payment_hash ?? "");
        if (!inv) return { error: { code: -32000, message: "invoice not found" } };
        return { result: inv };
      }
      case "cancel_invoice": {
        const inv = this.invoices.get(p.payment_hash ?? "");
        if (!inv) return { error: { code: -32000, message: "invoice not found" } };
        if (inv.status !== "Open") return { error: { code: -32000, message: "invoice not open" } };
        inv.status = "Cancelled";
        return { result: inv };
      }
      default:
        return { error: { code: -32601, message: "Method not found" } };
    }
  }
}
