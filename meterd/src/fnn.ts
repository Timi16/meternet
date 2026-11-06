// Typed JSON-RPC client for the box's Fiber Network Node (FNN).
// Shapes follow crates/fiber-lib/src/rpc/README.md at FNN v0.9.1 (pinned).
// Wire format: JSON-RPC 2.0, `params` is a single-object array, integers are
// 0x-prefixed hex strings.

export type Hex = `0x${string}`;

// The only FNN methods this project calls.
export type FnnMethod =
  | "new_invoice"
  | "get_invoice"
  | "cancel_invoice"
  | "send_payment"
  | "get_payment"
  | "connect_peer"
  | "open_channel"
  | "list_channels"
  | "node_info";

export type Currency = "Fibb" | "Fibt" | "Fibd";
export type HashAlgorithm = "ckb_hash" | "sha256";
export type InvoiceStatus = "Open" | "Cancelled" | "Expired" | "Received" | "Paid";

export interface CkbInvoice {
  currency: Currency;
  amount?: Hex | null;
  signature?: string | null;
  data: {
    timestamp: Hex;
    payment_hash: Hex;
    attrs: unknown[];
  };
}

export interface NewInvoiceParams {
  amount: Hex; // shannons for CKB invoices
  currency: Currency;
  description?: string;
  // Set the preimage ourselves so meterd can log it and `verify` can check it.
  payment_preimage?: Hex;
  expiry?: Hex; // seconds
  hash_algorithm?: HashAlgorithm;
}

export interface NewInvoiceResult {
  invoice_address: string;
  invoice: CkbInvoice;
}

export interface PaymentHashParams {
  payment_hash: Hex;
}

export interface InvoiceStatusResult {
  invoice_address: string;
  invoice: CkbInvoice;
  status: InvoiceStatus;
}

export interface FnnClient {
  newInvoice(params: NewInvoiceParams): Promise<NewInvoiceResult>;
  getInvoice(params: PaymentHashParams): Promise<InvoiceStatusResult>;
  cancelInvoice(params: PaymentHashParams): Promise<InvoiceStatusResult>;
}

export class FnnRpcError extends Error {
  constructor(
    readonly method: FnnMethod,
    readonly code: number,
    message: string,
  ) {
    super(`${method}: ${message} (code ${code})`);
    this.name = "FnnRpcError";
  }
}

export function toHex(n: bigint): Hex {
  return `0x${n.toString(16)}`;
}

export function fromHex(h: string): bigint {
  return BigInt(h);
}

export class FnnRpcClient implements FnnClient {
  private nextId = 1;

  constructor(readonly rpcUrl: string) {}

  newInvoice(params: NewInvoiceParams): Promise<NewInvoiceResult> {
    return this.call("new_invoice", params);
  }

  getInvoice(params: PaymentHashParams): Promise<InvoiceStatusResult> {
    return this.call("get_invoice", params);
  }

  cancelInvoice(params: PaymentHashParams): Promise<InvoiceStatusResult> {
    return this.call("cancel_invoice", params);
  }

  // Untyped escape hatch for scripts (channel setup, payer side). Methods
  // without params (node_info) are sent with an empty params array.
  async call<T>(method: FnnMethod, params?: object): Promise<T> {
    const res = await fetch(this.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: this.nextId++,
        method,
        params: params === undefined ? [] : [params],
      }),
    });
    if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
    const body = (await res.json()) as {
      result?: T;
      error?: { code: number; message: string };
    };
    if (body.error) throw new FnnRpcError(method, body.error.code, body.error.message);
    return body.result as T;
  }
}
