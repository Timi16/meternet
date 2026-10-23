// Typed JSON-RPC client interface for the box's Fiber Network Node (FNN).
// Only the two methods meterd needs. Bodies are stubs at week 0.
//
// TODO(verify): every param/result shape below against the FNN RPC docs for
// the FNN version we pin, including how u64/u128 values are encoded and
// whether params are sent as a single-object array.

export type Hex = `0x${string}`;

export type InvoiceStatus = "Open" | "Cancelled" | "Expired" | "Received" | "Paid";

export interface NewInvoiceParams {
  amount: Hex; // TODO(verify): unit and encoding
  currency: string; // TODO(verify): testnet currency code
  description?: string;
  expiry?: Hex; // TODO(verify)
  payment_preimage?: Hex; // TODO(verify): required or optional
}

export interface NewInvoiceResult {
  invoice_address: string; // TODO(verify)
  invoice: unknown; // TODO(verify): decoded invoice shape
}

export interface GetInvoiceParams {
  payment_hash: Hex;
}

export interface GetInvoiceResult {
  invoice_address: string; // TODO(verify)
  invoice: unknown; // TODO(verify)
  status: InvoiceStatus;
}

export interface FnnClient {
  newInvoice(params: NewInvoiceParams): Promise<NewInvoiceResult>;
  getInvoice(params: GetInvoiceParams): Promise<GetInvoiceResult>;
}

export class FnnRpcClient implements FnnClient {
  constructor(readonly rpcUrl: string) {}

  async newInvoice(_params: NewInvoiceParams): Promise<NewInvoiceResult> {
    throw new Error("not implemented");
  }

  async getInvoice(_params: GetInvoiceParams): Promise<GetInvoiceResult> {
    throw new Error("not implemented");
  }
}
