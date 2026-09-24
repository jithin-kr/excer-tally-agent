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
  assertVoucherBalanced,
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
 * The discount to post as its own ledger line, worked out from the totals.
 *
 * The payload does not say whether line `taxableValue`s are before or after the order discount,
 * and the two readings need different vouchers: pre-discount lines need a separate Discount
 * Allowed debit; post-discount lines must NOT get one, or the discount counts twice. The totals
 * settle it — `lines + tax - grandTotal` is the discount the lines still carry:
 *   = discountAmount  -> lines are pre-discount, post the discount line
 *   = 0               -> lines already net of discount, post none
 *   anything else     -> the payload does not add up; refuse rather than guess.
 */
export function invoiceDiscount(
  lineTotal: number,
  taxTotal: number,
  grandTotal: number,
  discountAmount: number
): number {
  const implied = roundMoney(lineTotal + taxTotal - grandTotal);
  if (Math.abs(implied - discountAmount) <= 0.01) return roundMoney(discountAmount);
  if (Math.abs(implied) <= 0.01) return 0;
  throw new Error(
    `Order totals do not reconcile: line values ${lineTotal.toFixed(2)} + tax ${taxTotal.toFixed(2)} ` +
      `- grand total ${grandTotal.toFixed(2)} = ${implied.toFixed(2)}, which matches neither the ` +
      `discount (${discountAmount.toFixed(2)}) nor zero.`
  );
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
  // Goods go OUT -> each line is a Credit, and carries the sales ledger in its ACCOUNTINGALLOCATIONS.
  // That allocation IS the sales posting: invoice-mode vouchers must not ALSO list the sales ledger
  // as a ledger line, or sales count twice and Tally rejects the voucher (verified live).
  const inventoryEntries = toInventory(p.lineItems, names, names.salesLedger);
  const lineTotal = roundMoney(inventoryEntries.reduce((sum, i) => sum + i.amount, 0));
  const discount = invoiceDiscount(lineTotal, p.taxTotal, p.grandTotal, p.discountAmount);

  const ledgerEntries: LedgerEntry[] = [
    // Party owes us the full invoice value -> Debit.
    { ledger: p.buyer.ledgerName, amount: -p.grandTotal, isPartyLedger: true },
  ];

  if (discount > 0) {
    // Discount allowed is an expense -> Debit.
    ledgerEntries.push({ ledger: names.discountLedger, amount: -discount });
  }

  ledgerEntries.push(
    ...taxLedgerEntries(
      p.taxTotal,
      { gstin: p.buyer.gstin ?? null, state: p.buyer.state ?? null },
      names,
      1
    )
  );

  // Fails loudly rather than posting a voucher Tally would reject. If this throws, the app's
  // line values/discount/tax/grandTotal do not reconcile — investigate there, not here.
  assertVoucherBalanced(ledgerEntries, inventoryEntries);

  const body = renderVoucher({
    voucherType: names.salesOrderVoucherType,
    date: p.orderDate,
    remoteId: p.remoteId,
    partyLedger: p.buyer.ledgerName,
    narration: p.notes ?? undefined,
    isInvoice: true,
    view: "Invoice Voucher View",
    ledgerEntries,
    inventoryEntries,
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
  // A Delivery Note moves goods, not money — Delivery Note is a non-accounting voucher type, so
  // these values never reach the books. But Tally still wants the invoice layout: party line +
  // item lines carrying the sales allocation. Verified live: an inventory-only Delivery Note is
  // rejected (EXCEPTIONS 1, no message); the invoice layout is created.
  if (!p.buyerLedgerName) {
    throw new Error(
      "Cannot post a Delivery Note without buyerLedgerName — Tally needs the party. The main app " +
        "sends it from the order's customer ledger; check buildDeliveryNotePayload()."
    );
  }
  const inventoryEntries = toInventory(p.lineItems, names, names.salesLedger); // goods out -> Credit
  const lineTotal = roundMoney(inventoryEntries.reduce((sum, i) => sum + i.amount, 0));
  const ledgerEntries: LedgerEntry[] = [
    { ledger: p.buyerLedgerName, amount: -lineTotal, isPartyLedger: true },
  ];
  assertVoucherBalanced(ledgerEntries, inventoryEntries);

  const body = renderVoucher({
    voucherType: names.deliveryNoteVoucherType,
    date: p.dispatchDate,
    remoteId: p.remoteId,
    partyLedger: p.buyerLedgerName,
    reference: p.referencedVoucherNumber ?? undefined,
    narration: [p.courierName, p.trackingNumber].filter(Boolean).join(" ") || undefined,
    isInvoice: true,
    view: "Invoice Voucher View",
    ledgerEntries,
    inventoryEntries,
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

  // Mirror image of the sale: goods come back IN -> each line is a Debit (negative), carrying the
  // sales ledger in its allocation; we now owe the customer -> party is a Credit. Posting the
  // returned goods as a Credit (upstream's sign) left the voucher unbalanced and Tally rejected it.
  const inventoryEntries = toInventory(p.lineItems, names, names.salesLedger).map((i) => ({
    ...i,
    amount: -i.amount,
  }));
  const ledgerEntries: LedgerEntry[] = [
    { ledger: p.buyerLedgerName, amount: p.totalCreditAmount, isPartyLedger: true },
  ];
  ledgerEntries.push(
    ...taxLedgerEntries(
      taxTotal,
      { gstin: p.buyerGstin ?? null, state: p.buyerState ?? null },
      names,
      -1
    )
  );
  assertVoucherBalanced(ledgerEntries, inventoryEntries);

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
    inventoryEntries,
    isOptional: postAsOptional,
  });
  return voucherImportEnvelope(body, company);
}

/* -------------------------------------------------------------------------- */
/*  4. New Customer Ledger (a master, not a voucher)                          */
/* -------------------------------------------------------------------------- */

/** GST came into force in India on 1 July 2017 — the earliest date any GST detail can apply from. */
const GST_EFFECTIVE_FROM = "20170701";

export function buildNewLedgerXml(p: NewLedgerPayload, names: TallyNames, company?: string): string {
  const addressLines = (p.address ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => `<ADDRESS>${escapeXml(l)}</ADDRESS>`)
    .join("");

  // TallyPrime 3+ stores address/state and GST registration in DATED lists and silently ignores
  // the old flat tags (verified live 2026-09-24: a ledger created with only <LEDSTATENAME> had no
  // state at all). Both forms are written, so older builds still get the flat ones.
  // APPLICABLEFROM is GST's start date (1 Jul 2017): the details must already be in force on the
  // date of any voucher posted against this customer, and no voucher predates GST.
  const mailing = `
        <LEDMAILINGDETAILS.LIST>
          <APPLICABLEFROM>${GST_EFFECTIVE_FROM}</APPLICABLEFROM>
          <MAILINGNAME>${escapeXml(p.customerName)}</MAILINGNAME>
          ${addressLines ? `<ADDRESS.LIST TYPE="String">${addressLines}</ADDRESS.LIST>` : ""}
          ${p.state ? `<STATE>${escapeXml(p.state)}</STATE>` : ""}
          <COUNTRY>India</COUNTRY>
        </LEDMAILINGDETAILS.LIST>`;
  const gstReg = `
        <LEDGSTREGDETAILS.LIST>
          <APPLICABLEFROM>${GST_EFFECTIVE_FROM}</APPLICABLEFROM>
          <GSTREGISTRATIONTYPE>${p.gstin ? "Regular" : "Unregistered/Consumer"}</GSTREGISTRATIONTYPE>
          ${p.state ? `<PLACEOFSUPPLY>${escapeXml(p.state)}</PLACEOFSUPPLY>` : ""}
          ${p.gstin ? `<GSTIN>${escapeXml(p.gstin)}</GSTIN>` : ""}
        </LEDGSTREGDETAILS.LIST>`;

  const body = `
    <TALLYMESSAGE xmlns:UDF="TallyUDF">
      <LEDGER NAME="${escapeXml(p.customerName)}" ACTION="Create">
        <REMOTEALTGUID>${escapeXml(p.remoteId)}</REMOTEALTGUID>
        <NAME>${escapeXml(p.customerName)}</NAME>
        <PARENT>${escapeXml(names.customerParentGroup)}</PARENT>
        <ISBILLWISEON>Yes</ISBILLWISEON>
        ${mailing}
        ${gstReg}
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
  // Records the cut as a matched OUT + IN of the same length, so the item's stock total is
  // unchanged. Deliberately net-zero: the cut metres leave stock through the order's own sale /
  // Delivery Note, and a stock journal that ALSO consumed them would deduct the same goods twice.
  // If the business wants cuts to consume stock (e.g. offcut wastage), that is a decision to make
  // explicitly — see the README. Verified live: Tally needs INVENTORYENTRIESOUT/IN.LIST here (the
  // flat list is rejected), and accepts zero-value lines, so no cost rate is needed.
  const line = (direction: "out" | "in"): InventoryEntry => ({
    stockItem: p.itemName,
    quantity: p.cutLength,
    amount: 0,
    unit: p.unit ?? undefined,
    godown: names.godown,
    direction,
    isDeemedPositive: direction === "in",
  });
  const body = renderVoucher({
    voucherType: names.stockJournalVoucherType,
    date: p.date,
    remoteId: p.remoteId,
    narration: `Cut ${p.cutLength}${p.unit ? ` ${p.unit}` : ""} from roll ${p.rollBarcode} (${p.remainingLength}${p.unit ? ` ${p.unit}` : ""} remaining)`,
    view: "Consumption Voucher View",
    ledgerEntries: [],
    inventoryEntries: [line("out"), line("in")],
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
  // The Sales Order is identified by the REMOTEID it was pushed with — the app always sends it as
  // referencedSalesOrderRemoteId. Verified live: cancel-by-REMOTEID needs no date or number.
  const body = renderCancelVoucher({
    voucherType: names.salesOrderVoucherType,
    remoteId: p.referencedSalesOrderRemoteId,
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
