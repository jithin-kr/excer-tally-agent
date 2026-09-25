// The wire contract between the Excer Next.js app and this agent.
//
// These types are the agent-side mirror of two files in the main repo:
//   - outbound payloads  : src/features/tally/mapping.ts   (build*Payload functions)
//   - inbound master rows: src/lib/tally/connector.ts      (TallyStockItemRow / TallyLedgerRow)
//
// The existing dev fixture at src/app/api/dev-fake-tally/ in the main repo is the executable
// specification for both endpoints — this agent must be a drop-in replacement for it. If you
// change a shape here, change it there too, or the mock stops proving anything.

import { z } from "zod";

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
  /** Standard selling price, ex-GST; null when none is set in Tally. */
  baseRate: number | null;
  active: boolean;
  /**
   * The item's Tally stock group, top-level group first: ["Cable", "AC Cable"]. Empty when the
   * item sits directly under Tally's root ("Primary"). The website files the item by it.
   */
  stockGroupPath?: string[];
  /** Tally's closing rate per unit (its stock valuation, e.g. average cost), or null if none. */
  closingRate?: number | null;
  /** Tally's closing stock value in rupees, as its Stock Summary shows it (positive for stock held). */
  closingValue?: number | null;
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
//
// These are zod schemas, not just interfaces, because the payload arrives over the network and a
// TypeScript cast checks nothing at runtime. Before this, a payload missing `grandTotal` produced
// `-undefined` = NaN, which slipped past the balance check (NaN > 0.01 is false) and would have
// rendered <AMOUNT>NaN</AMOUNT> into the client's books. Now it is a 400 before any XML exists.
//
// Nullable fields use `.nullish()` (null OR absent) so an app that omits an optional field is
// not rejected — only fields the voucher cannot be built without are strict.

/** Money and quantities: must be a real number. NaN / Infinity never reach Tally. */
const money = z.number().finite();
const nonNegativeMoney = money.nonnegative();

/**
 * The idempotency key. No double quotes: it is matched inside a TDL formula string when checking
 * for an existing voucher (src/excer/lookup.ts), and TDL has no way to escape one.
 */
const remoteId = z
  .string()
  .min(1)
  .max(200)
  .refine((v) => !v.includes('"'), "remoteId must not contain a double quote");

const date = z.string().min(1);
const text = z.string().nullish();

export const lineItemSchema = z.object({
  itemName: z.string().min(1),
  itemGuid: text,
  hsnCode: text,
  quantity: money.positive(),
  unit: text,
  rate: money,
  taxableValue: money,
  gstRate: money.nullish(),
});

export const salesOrderPayloadSchema = z.object({
  remoteId,
  orderDate: date,
  buyer: z.object({
    ledgerGuid: text,
    ledgerName: z.string().min(1),
    gstin: text,
    /**
     * Structural delivery state (`Order.deliveryState`, main repo CLAUDE.md §22.12) — used by
     * `splitGst()` to pick CGST+SGST vs IGST. Null when checkout used free text or the legacy
     * address blob, in which case `splitGst()` falls back to the GSTIN, or blocks with a clear
     * error.
     */
    state: text,
  }),
  deliveryAddress: text,
  lineItems: z.array(lineItemSchema).min(1),
  subtotal: nonNegativeMoney,
  discountAmount: nonNegativeMoney,
  taxableValue: nonNegativeMoney,
  taxTotal: nonNegativeMoney,
  grandTotal: nonNegativeMoney,
  notes: text,
});

export const deliveryNotePayloadSchema = z.object({
  remoteId,
  referencedSalesOrderRemoteId: z.string().min(1),
  dispatchDate: date,
  lineItems: z.array(lineItemSchema).min(1),
  trackingNumber: text,
  courierName: text,
  /** Resolved by the app from Order.tallyVoucherNumber so we can reference the Sales Order. */
  referencedVoucherNumber: text,
  /** Party ledger — needed because a Delivery Note still posts against the customer. */
  buyerLedgerName: text,
});

export const creditNotePayloadSchema = z.object({
  remoteId,
  referencedRemoteId: z.string().min(1),
  returnDate: date,
  lineItems: z.array(lineItemSchema.omit({ hsnCode: true })).min(1),
  totalCreditAmount: nonNegativeMoney,
  reason: text,
  /** Required: a credit note posts against the customer, and Tally rejects an empty party. */
  buyerLedgerName: z.string().min(1),
  /** Needed to decide CGST+SGST vs IGST on the reversal. See "Required changes in the main app". */
  buyerGstin: text,
  /** Structural delivery state (§22.12) — same fallback rules as `SalesOrderPayload.buyer.state`. */
  buyerState: text,
});

export const newLedgerPayloadSchema = z.object({
  remoteId,
  customerName: z.string().min(1),
  gstin: text,
  address: text,
  state: text,
  phone: text,
});

export const stockJournalPayloadSchema = z.object({
  remoteId,
  itemName: z.string().min(1),
  itemGuid: text,
  rollBarcode: z.string().min(1),
  cutLength: money.positive(),
  /** Tally's unit name for the item, or null/absent to use the item's own base unit. */
  unit: text,
  remainingLength: money.nonnegative(),
  date,
});

export const cancelSalesOrderPayloadSchema = z.object({
  remoteId,
  referencedSalesOrderRemoteId: z.string().min(1),
  cancellationDate: date,
  reason: text,
  /**
   * Tally cancels a voucher by its voucher NUMBER, not by REMOTEID. The app stores this on
   * Order.tallyVoucherNumber from the `voucherNumber` this agent returns when the Sales Order
   * push succeeds. Left optional here so a missing one produces buildCancelSalesOrderXml's
   * specific error message rather than a generic validation failure.
   */
  salesOrderVoucherNumber: text,
  /**
   * The Sales Order's own date (Order date, as sent in its push). Tally identifies the voucher to
   * cancel by date + type + number, so this — not `cancellationDate` — must go in the cancel's
   * DATE. It also lets the agent look up the voucher number by REMOTEID when
   * `salesOrderVoucherNumber` is missing. Optional only for compatibility; without it the agent
   * falls back to `cancellationDate`, which fails for any order not cancelled on its own day.
   */
  salesOrderDate: text,
});

export type LineItemPayload = z.infer<typeof lineItemSchema>;
export type SalesOrderPayload = z.infer<typeof salesOrderPayloadSchema>;
export type DeliveryNotePayload = z.infer<typeof deliveryNotePayloadSchema>;
export type CreditNotePayload = z.infer<typeof creditNotePayloadSchema>;
export type NewLedgerPayload = z.infer<typeof newLedgerPayloadSchema>;
export type StockJournalPayload = z.infer<typeof stockJournalPayloadSchema>;
export type CancelSalesOrderPayload = z.infer<typeof cancelSalesOrderPayloadSchema>;

/**
 * The whole POST body: the payload fields plus a `type` that says which of the six it is.
 * A discriminated union, so after parsing, `switch (req.type)` narrows the payload for free.
 */
export const pushRequestSchema = z.discriminatedUnion("type", [
  salesOrderPayloadSchema.extend({ type: z.literal("push_sales_order") }),
  deliveryNotePayloadSchema.extend({ type: z.literal("push_delivery_note") }),
  creditNotePayloadSchema.extend({ type: z.literal("push_credit_note") }),
  newLedgerPayloadSchema.extend({ type: z.literal("push_new_ledger") }),
  stockJournalPayloadSchema.extend({ type: z.literal("push_stock_journal") }),
  cancelSalesOrderPayloadSchema.extend({ type: z.literal("push_cancel_sales_order") }),
]);

export type PushRequest = z.infer<typeof pushRequestSchema>;
export type TallyJobType = PushRequest["type"];

/** What the app's `pushTallyVoucher()` expects back. */
export interface PushResponse {
  success?: boolean;
  duplicate?: boolean;
  /** Tally's GUID for the voucher or ledger, read back after writing. */
  guid?: string;
  /**
   * The voucher's real VOUCHERNUMBER, read back after writing — the app stores it as
   * Order.tallyVoucherNumber and later sends it to cancel. Absent when Tally assigned none (e.g.
   * an Optional voucher on a build that numbers only on conversion), in which case cancelling
   * that order fails with a clear error instead of hitting the wrong voucher.
   */
  voucherNumber?: string;
  error?: string;
  [key: string]: unknown;
}
