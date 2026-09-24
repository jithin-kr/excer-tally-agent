// Excer payloads -> Tally XML.
//
// This is the translation layer: it turns the six payload shapes the Excer app already produces
// (src/features/tally/mapping.ts in the main repo) into the generic `VoucherInput` that
// src/tally/voucher-render.ts knows how to render. Keeping the two apart means the proven
// XML structure stays untouched while all Excer-specific accounting decisions live here.
//
// SIGN CONVENTION (inherited from Tally, enforced by assertBalanced):
//   NEGATIVE amount = Debit (Dr)      POSITIVE amount = Credit (Cr)
//   Every voucher's ledger entries must sum to zero.

import type { TallyNames } from "./config.js";
import type {
  CancelSalesOrderPayload,
  CreditNotePayload,
  DeliveryNotePayload,
  NewLedgerPayload,
  PushRequest,
  SalesOrderPayload,
  StockJournalPayload,
} from "./contract.js";
import { escapeXml } from "../tally/xml.js";
import {
  assertBalanced,
  masterImportEnvelope,
  renderCancelVoucher,
  renderVoucher,
  voucherImportEnvelope,
  type InventoryEntry,
  type LedgerEntry,
} from "../tally/voucher-render.js";

/* -------------------------------------------------------------------------- */
/*  GST split                                                                 */
/* -------------------------------------------------------------------------- */

export interface GstSplit {
  cgst: number;
  sgst: number;
  igst: number;
}

/** What we know about the buyer's location when deciding the tax treatment. */
export interface BuyerTaxIdentity {
  /** GSTIN, when we have one. Its first two digits are the state code — "32" is Kerala. */
  gstin: string | null;
  /** Free-text state name, when we have one. */
  state: string | null;
}

/**
 * Official two-digit GST state/UT codes -> canonical state name (CBIC list). Used only as a
 * fallback to derive a buyer's state from their GSTIN when no free-text state is on file — see
 * `splitGst` below.
 */
const GST_STATE_CODES: Record<string, string> = {
  "01": "Jammu and Kashmir",
  "02": "Himachal Pradesh",
  "03": "Punjab",
  "04": "Chandigarh",
  "05": "Uttarakhand",
  "06": "Haryana",
  "07": "Delhi",
  "08": "Rajasthan",
  "09": "Uttar Pradesh",
  "10": "Bihar",
  "11": "Sikkim",
  "12": "Arunachal Pradesh",
  "13": "Nagaland",
  "14": "Manipur",
  "15": "Mizoram",
  "16": "Tripura",
  "17": "Meghalaya",
  "18": "Assam",
  "19": "West Bengal",
  "20": "Jharkhand",
  "21": "Odisha",
  "22": "Chhattisgarh",
  "23": "Madhya Pradesh",
  "24": "Gujarat",
  "26": "Dadra and Nagar Haveli and Daman and Diu",
  "27": "Maharashtra",
  "28": "Andhra Pradesh",
  "29": "Karnataka",
  "30": "Goa",
  "31": "Lakshadweep",
  "32": "Kerala",
  "33": "Tamil Nadu",
  "34": "Puducherry",
  "35": "Andaman and Nicobar Islands",
  "36": "Telangana",
  "37": "Andhra Pradesh",
  "38": "Ladakh",
  "97": "Other Territory",
  "99": "Centre Jurisdiction",
};

function normalizeState(state: string): string {
  return state.trim().toLowerCase();
}

function stateFromGstin(gstin: string): string | null {
  const code = gstin.trim().slice(0, 2);
  return GST_STATE_CODES[code] ?? null;
}

/** Same rounding convention as the main app's `roundMoney` (`features/orders/approval.ts`). */
function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * Split a total tax amount into CGST / SGST / IGST ledger postings.
 *
 * Indian GST splits one way for a sale inside your own state (CGST + SGST, half each) and
 * another way for a sale to a different state (IGST, all of it). Excer is in Kerala
 * (`names.homeState`), so a Kerala buyer is intra-state and a Tamil Nadu buyer is not.
 *
 * Two decisions made deliberately on 2026-09-23, after this exact function blocked a real order
 * during Stage 1 testing (every taxed order hits this, not just an edge case):
 *
 *   1. **Free-text `state` always wins when present** — including when it disagrees with what
 *      the GSTIN's state code would imply. The GSTIN is only used as a *fallback* to derive a
 *      state when no free-text state is on file at all.
 *   2. **Both missing or the GSTIN's code is unrecognised → throw.** Blocks the push until
 *      someone fixes the customer's address/GSTIN, rather than silently guessing intra-state and
 *      letting an accountant discover a misfiled inter-state sale months later. The job retries
 *      automatically (`MAX_AUTO_RETRY_ATTEMPTS`, main repo) once the record is fixed.
 *
 * Rounding: CGST and SGST are each half of `taxTotal`; an odd paisa can't split evenly, so SGST
 * is computed as the remainder (`taxTotal - cgst`) rather than independently rounded, guaranteeing
 * the two halves still sum to exactly `taxTotal` — Tally rejects a voucher whose entries don't
 * balance to the paisa.
 */
export function splitGst(taxTotal: number, buyer: BuyerTaxIdentity, names: TallyNames): GstSplit {
  const resolvedState =
    (buyer.state && buyer.state.trim()) || (buyer.gstin && stateFromGstin(buyer.gstin)) || null;

  if (!resolvedState) {
    throw new Error(
      "Cannot determine the buyer's state for the GST split: no state on file, and either no " +
        "GSTIN or an unrecognised GSTIN state code. Fix the customer's address or GSTIN in the " +
        "admin panel, then it retries automatically — this blocks on purpose rather than " +
        "guessing, since a wrong guess misfiles tax in the client's books."
    );
  }

  const isIntraState = normalizeState(resolvedState) === normalizeState(names.homeState);

  if (isIntraState) {
    const cgst = roundMoney(taxTotal / 2);
    const sgst = roundMoney(taxTotal - cgst);
    return { cgst, sgst, igst: 0 };
  }

  return { cgst: 0, sgst: 0, igst: roundMoney(taxTotal) };
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

/** The subset of a line item that becomes a Tally inventory entry. */
interface InventoryLineInput {
  itemName: string;
  quantity: number;
  rate?: number;
  taxableValue: number;
  unit?: string | null;
}

function toInventory(
  lines: InventoryLineInput[],
  names: TallyNames,
  accountingLedger?: string
): InventoryEntry[] {
  return lines.map((l) => ({
    stockItem: l.itemName,
    quantity: l.quantity,
    rate: l.rate,
    amount: l.taxableValue,
    unit: l.unit ?? undefined,
    godown: names.godown,
    accountingLedger,
  }));
}

function taxLedgerEntries(
  taxTotal: number,
  buyer: BuyerTaxIdentity,
  names: TallyNames,
  sign: 1 | -1
): LedgerEntry[] {
  if (taxTotal === 0) return [];
  const split = splitGst(taxTotal, buyer, names);
  const entries: LedgerEntry[] = [];
  if (split.igst > 0) {
    entries.push({ ledger: names.igstLedger, amount: sign * split.igst });
  } else {
    if (split.cgst > 0) entries.push({ ledger: names.cgstLedger, amount: sign * split.cgst });
    if (split.sgst > 0) entries.push({ ledger: names.sgstLedger, amount: sign * split.sgst });
  }
  return entries;
}

/* -------------------------------------------------------------------------- */
/*  1. Sales Order                                                            */
/* -------------------------------------------------------------------------- */

export function buildSalesOrderXml(
  p: SalesOrderPayload,
  names: TallyNames,
  company?: string,
  postAsOptional = false
): string {
  const ledgerEntries: LedgerEntry[] = [
    // Party owes us the full invoice value -> Debit.
    { ledger: p.buyer.ledgerName, amount: -p.grandTotal, isPartyLedger: true },
    // Sales income -> Credit, at gross (pre-discount) value.
    { ledger: names.salesLedger, amount: p.subtotal },
  ];

  if (p.discountAmount > 0) {
    // Discount allowed is an expense -> Debit.
    ledgerEntries.push({ ledger: names.discountLedger, amount: -p.discountAmount });
  }

  ledgerEntries.push(
    ...taxLedgerEntries(
      p.taxTotal,
      { gstin: p.buyer.gstin ?? null, state: p.buyer.state ?? null },
      names,
      1
    )
  );

  // Fails loudly rather than posting a voucher Tally would half-accept. If this throws, the
  // app's subtotal/discount/tax/grandTotal do not reconcile — investigate there, not here.
  assertBalanced(ledgerEntries);

  const body = renderVoucher({
    voucherType: names.salesOrderVoucherType,
    date: p.orderDate,
    remoteId: p.remoteId,
    partyLedger: p.buyer.ledgerName,
    narration: p.notes ?? undefined,
    isInvoice: true,
    view: "Invoice Voucher View",
    ledgerEntries,
    inventoryEntries: toInventory(p.lineItems, names, names.salesLedger),
    isOptional: postAsOptional,
  });
  return voucherImportEnvelope(body, company);
}

/* -------------------------------------------------------------------------- */
/*  2. Delivery Note                                                          */
/* -------------------------------------------------------------------------- */

export function buildDeliveryNoteXml(
  p: DeliveryNotePayload,
  names: TallyNames,
  company?: string,
  postAsOptional = false
): string {
  // A Delivery Note moves goods, not money: inventory lines only, no ledger postings.
  const body = renderVoucher({
    voucherType: names.deliveryNoteVoucherType,
    date: p.dispatchDate,
    remoteId: p.remoteId,
    partyLedger: p.buyerLedgerName ?? undefined,
    reference: p.referencedVoucherNumber ?? undefined,
    narration: [p.courierName, p.trackingNumber].filter(Boolean).join(" ") || undefined,
    view: "Inventory Voucher View",
    ledgerEntries: [],
    inventoryEntries: toInventory(p.lineItems, names),
    isOptional: postAsOptional,
  });
  return voucherImportEnvelope(body, company);
}

/* -------------------------------------------------------------------------- */
/*  3. Credit Note                                                            */
/* -------------------------------------------------------------------------- */

export function buildCreditNoteXml(
  p: CreditNotePayload,
  names: TallyNames,
  company?: string,
  postAsOptional = false
): string {
  const taxableTotal = p.lineItems.reduce((sum, l) => sum + l.taxableValue, 0);
  const taxTotal = Number((p.totalCreditAmount - taxableTotal).toFixed(2));

  // Mirror image of the sale: we now owe the customer.
  const ledgerEntries: LedgerEntry[] = [
    { ledger: p.buyerLedgerName, amount: p.totalCreditAmount, isPartyLedger: true },
    { ledger: names.salesLedger, amount: -taxableTotal },
  ];
  ledgerEntries.push(
    ...taxLedgerEntries(
      taxTotal,
      { gstin: p.buyerGstin ?? null, state: p.buyerState ?? null },
      names,
      -1
    )
  );
  assertBalanced(ledgerEntries);

  const body = renderVoucher({
    voucherType: names.creditNoteVoucherType,
    date: p.returnDate,
    remoteId: p.remoteId,
    partyLedger: p.buyerLedgerName ?? undefined,
    reference: p.referencedRemoteId,
    narration: p.reason ?? undefined,
    isInvoice: true,
    view: "Invoice Voucher View",
    ledgerEntries,
    inventoryEntries: toInventory(p.lineItems, names, names.salesLedger),
    isOptional: postAsOptional,
  });
  return voucherImportEnvelope(body, company);
}

/* -------------------------------------------------------------------------- */
/*  4. New Customer Ledger (a master, not a voucher)                          */
/* -------------------------------------------------------------------------- */

export function buildNewLedgerXml(p: NewLedgerPayload, names: TallyNames, company?: string): string {
  const addressLines = (p.address ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => `<ADDRESS>${escapeXml(l)}</ADDRESS>`)
    .join("");

  const body = `
    <TALLYMESSAGE xmlns:UDF="TallyUDF">
      <LEDGER NAME="${escapeXml(p.customerName)}" ACTION="Create">
        <REMOTEALTGUID>${escapeXml(p.remoteId)}</REMOTEALTGUID>
        <NAME>${escapeXml(p.customerName)}</NAME>
        <PARENT>${escapeXml(names.customerParentGroup)}</PARENT>
        <ISBILLWISEON>Yes</ISBILLWISEON>
        ${p.gstin ? `<PARTYGSTIN>${escapeXml(p.gstin)}</PARTYGSTIN>` : ""}
        ${p.gstin ? "<GSTREGISTRATIONTYPE>Regular</GSTREGISTRATIONTYPE>" : ""}
        ${p.state ? `<LEDSTATENAME>${escapeXml(p.state)}</LEDSTATENAME>` : ""}
        ${p.phone ? `<LEDGERPHONE>${escapeXml(p.phone)}</LEDGERPHONE>` : ""}
        ${addressLines ? `<ADDRESS.LIST>${addressLines}</ADDRESS.LIST>` : ""}
        <OPENINGBALANCE>0</OPENINGBALANCE>
      </LEDGER>
    </TALLYMESSAGE>`;
  return masterImportEnvelope(body, company);
}

/* -------------------------------------------------------------------------- */
/*  5. Stock Journal (a cable/roll cut)                                       */
/* -------------------------------------------------------------------------- */

export function buildStockJournalXml(
  p: StockJournalPayload,
  names: TallyNames,
  company?: string,
  postAsOptional = false
): string {
  // UNVERIFIED: Tally's Stock Journal uses DESTINATIONLIST/SOURCELIST in some configurations
  // rather than a flat ALLINVENTORYENTRIES.LIST. This renders the flat form. Confirm against
  // their Tally before trusting cable-cut postings — see the README's validation checklist.
  const body = renderVoucher({
    voucherType: names.stockJournalVoucherType,
    date: p.date,
    remoteId: p.remoteId,
    narration: `Cut ${p.cutLength} ${p.unit} from roll ${p.rollBarcode} (${p.remainingLength} ${p.unit} remaining)`,
    view: "Inventory Voucher View",
    ledgerEntries: [],
    inventoryEntries: [
      {
        stockItem: p.itemName,
        quantity: p.cutLength,
        amount: 0,
        unit: p.unit,
        godown: names.godown,
        isDeemedPositive: true,
      },
    ],
    isOptional: postAsOptional,
  });
  return voucherImportEnvelope(body, company);
}

/* -------------------------------------------------------------------------- */
/*  6. Cancel Sales Order                                                     */
/* -------------------------------------------------------------------------- */

export function buildCancelSalesOrderXml(
  p: CancelSalesOrderPayload,
  names: TallyNames,
  company?: string
): string {
  if (!p.salesOrderVoucherNumber) {
    throw new Error(
      "Cannot cancel: salesOrderVoucherNumber is missing. Tally cancels a voucher by its " +
        "voucher number, not by REMOTEID. The main app must include Order.tallyVoucherNumber " +
        "in buildCancelVoucherPayload() — see the README."
    );
  }
  const body = renderCancelVoucher({
    voucherType: names.salesOrderVoucherType,
    date: p.cancellationDate,
    voucherNumber: p.salesOrderVoucherNumber,
    narration: p.reason ?? undefined,
  });
  return voucherImportEnvelope(body, company);
}

/* -------------------------------------------------------------------------- */
/*  Dispatch                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Build the import XML for an already-validated request (`pushRequestSchema.parse`). Taking the
 * parsed union rather than `unknown` means no casts: each case sees exactly its own payload type.
 */
export function buildVoucherXml(
  req: PushRequest,
  names: TallyNames,
  company?: string,
  postAsOptional = false
): string {
  switch (req.type) {
    case "push_sales_order":
      return buildSalesOrderXml(req, names, company, postAsOptional);
    case "push_delivery_note":
      return buildDeliveryNoteXml(req, names, company, postAsOptional);
    case "push_credit_note":
      return buildCreditNoteXml(req, names, company, postAsOptional);
    case "push_new_ledger":
      // A master creation, not a voucher — "Optional" has no meaning here.
      return buildNewLedgerXml(req, names, company);
    case "push_stock_journal":
      return buildStockJournalXml(req, names, company, postAsOptional);
    case "push_cancel_sales_order":
      // Cancels a voucher already pushed (by voucher number). UNVERIFIED whether Tally's Cancel
      // action applies cleanly to an Optional voucher the accountant hasn't converted yet — see
      // the README's validation checklist. Left as a real Cancel either way, not made Optional
      // itself: cancelling is inherently the "undo" action, there is no draft form of it.
      return buildCancelSalesOrderXml(req, names, company);
  }
}

/** The date a voucher is posted on — used to scope the REMOTEID lookup to one day. */
export function voucherDate(req: PushRequest): string | null {
  switch (req.type) {
    case "push_sales_order":
      return req.orderDate;
    case "push_delivery_note":
      return req.dispatchDate;
    case "push_credit_note":
      return req.returnDate;
    case "push_stock_journal":
      return req.date;
    case "push_new_ledger":
    case "push_cancel_sales_order":
      return null;
  }
}
