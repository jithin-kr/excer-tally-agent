// The wire contract between the Excer Next.js app and this agent.
//
// These types are the agent-side mirror of two files in the main repo:
//   - outbound payloads  : src/features/tally/mapping.ts   (build*Payload functions)
//   - inbound master rows: src/lib/tally/connector.ts      (TallyStockItemRow / TallyLedgerRow)
//
// The existing dev fixture at src/app/api/dev-fake-tally/ in the main repo is the executable
// specification for both endpoints — this agent must be a drop-in replacement for it. If you
// change a shape here, change it there too, or the mock stops proving anything.

/* -------------------------------------------------------------------------- */
/*  Inbound: Tally -> Excer  (GET /api/export/masters)                        */
/* -------------------------------------------------------------------------- */

export interface TallyStockItemRow {
  guid: string;
  name: string;
  alias?: string | null;
  alterId: number;
  closingStockQty: number;
  godown?: string | null;
  baseUnit: string;
  hsnCode?: string | null;
  gstRate?: number | null;
  baseRate: number;
  active: boolean;
}

export interface TallyLedgerRow {
  guid: string;
  alterId: number;
  ledgerName: string;
  gstin?: string | null;
  addressLine?: string | null;
  city?: string | null;
  state?: string | null;
  pincode?: string | null;
  mobile?: string | null;
  email?: string | null;
  creditLimit?: number | null;
  active: boolean;
}

export interface MastersResponse {
  stockItems: TallyStockItemRow[];
  ledgers: TallyLedgerRow[];
  /** Highest AlterID seen in this batch — the app echoes it back as `?sinceAlterId=` next time. */
  maxAlterId?: number;
}

/* -------------------------------------------------------------------------- */
/*  Outbound: Excer -> Tally  (POST /api/import/voucher)                      */
/* -------------------------------------------------------------------------- */

export type TallyJobType =
  | "push_sales_order"
  | "push_delivery_note"
  | "push_credit_note"
  | "push_new_ledger"
  | "push_stock_journal"
  | "push_cancel_sales_order";

export interface LineItemPayload {
  itemName: string;
  itemGuid: string | null;
  hsnCode?: string | null;
  quantity: number;
  unit?: string;
  rate: number;
  taxableValue: number;
  gstRate: number | null;
}

export interface SalesOrderPayload {
  remoteId: string;
  orderDate: string;
  buyer: { ledgerGuid: string | null; ledgerName: string; gstin: string | null };
  deliveryAddress: string;
  lineItems: LineItemPayload[];
  subtotal: number;
  discountAmount: number;
  taxableValue: number;
  taxTotal: number;
  grandTotal: number;
  notes: string | null;
}

export interface DeliveryNotePayload {
  remoteId: string;
  referencedSalesOrderRemoteId: string;
  dispatchDate: string;
  lineItems: LineItemPayload[];
  trackingNumber: string | null;
  courierName: string | null;
  /** Resolved by the app from Order.tallyVoucherNumber so we can reference the Sales Order. */
  referencedVoucherNumber?: string | null;
  /** Party ledger — needed because a Delivery Note still posts against the customer. */
  buyerLedgerName?: string | null;
}

export interface CreditNotePayload {
  remoteId: string;
  referencedRemoteId: string;
  returnDate: string;
  lineItems: Array<Omit<LineItemPayload, "hsnCode" | "unit">>;
  totalCreditAmount: number;
  reason: string | null;
  buyerLedgerName?: string | null;
  /** Needed to decide CGST+SGST vs IGST on the reversal. See "Required changes in the main app". */
  buyerGstin?: string | null;
}

export interface NewLedgerPayload {
  remoteId: string;
  customerName: string;
  gstin: string | null;
  address: string | null;
  state: string | null;
  phone: string | null;
}

export interface StockJournalPayload {
  remoteId: string;
  itemName: string;
  itemGuid: string | null;
  rollBarcode: string;
  cutLength: number;
  unit: string;
  remainingLength: number;
  date: string;
}

export interface CancelSalesOrderPayload {
  remoteId: string;
  referencedSalesOrderRemoteId: string;
  cancellationDate: string;
  reason: string | null;
  /**
   * Tally cancels a voucher by its voucher NUMBER, not by REMOTEID. The app stores this on
   * Order.tallyVoucherNumber when the Sales Order push succeeds, but the current
   * `buildCancelVoucherPayload` in the main repo does not send it — see the README's
   * "Required change in the main app". Without it we cannot cancel and return a clear error.
   */
  salesOrderVoucherNumber?: string | null;
}

export type VoucherPayload =
  | SalesOrderPayload
  | DeliveryNotePayload
  | CreditNotePayload
  | NewLedgerPayload
  | StockJournalPayload
  | CancelSalesOrderPayload;

/** What the app's `pushTallyVoucher()` expects back. */
export interface PushResponse {
  success?: boolean;
  duplicate?: boolean;
  guid?: string;
  voucherNumber?: string;
  error?: string;
  [key: string]: unknown;
}
