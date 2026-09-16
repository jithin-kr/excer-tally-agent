// Excer payloads -> Tally XML.
//
// This is the translation layer: it turns the six payload shapes the Excer app already produces
// (src/features/tally/mapping.ts in the main repo) into the generic `VoucherInput` that
// src/tally/voucher-render.ts knows how to render. Keeping the two apart means upstream's proven
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
  SalesOrderPayload,
  StockJournalPayload,
  TallyJobType,
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
 * Split a total tax amount into CGST / SGST / IGST ledger postings.
 *
 * TODO(excer): implement this — see "Your one decision" in the README.
 *
 * Indian GST splits one way for a sale inside your own state (CGST + SGST, half each) and
 * another way for a sale to a different state (IGST, all of it). Excer is in Kerala
 * (`names.homeState`), so a Kerala buyer is intra-state and a Tamil Nadu buyer is not.
 *
 * Things worth deciding deliberately:
 *   - Which signal do you trust? A GSTIN's first two digits are a government-issued state code
 *     and cannot be typo'd into a different valid state the way free text can. But unregistered
 *     buyers have no GSTIN at all, and `state` is all you get.
 *   - What happens when BOTH are missing or unrecognised? Defaulting to intra-state silently
 *     mis-files inter-state sales; throwing blocks the push until someone fixes the customer
 *     record. Both are defensible and they fail in very different places — one on the
 *     accountant's desk months later, one in the admin panel today.
 *   - Rounding. CGST and SGST are each half the total, and an odd number of paise will not
 *     split evenly. Tally rejects a voucher whose entries do not balance to the paisa, so the
 *     two halves must still sum to exactly `taxTotal`.
 */
export function splitGst(
  _taxTotal: number,
  _buyer: BuyerTaxIdentity,
  _names: TallyNames
): GstSplit {
  throw new Error("splitGst() is not implemented yet — see src/excer/vouchers.ts");
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
  unit?: string;
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
    unit: l.unit,
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

export function buildSalesOrderXml(p: SalesOrderPayload, names: TallyNames, company?: string): string {
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

  ledgerEntries.push(...taxLedgerEntries(p.taxTotal, { gstin: p.buyer.gstin, state: null }, names, 1));

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
  });
  return voucherImportEnvelope(body, company);
}

/* -------------------------------------------------------------------------- */
/*  2. Delivery Note                                                          */
/* -------------------------------------------------------------------------- */

export function buildDeliveryNoteXml(
  p: DeliveryNotePayload,
  names: TallyNames,
  company?: string
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
  });
  return voucherImportEnvelope(body, company);
}

/* -------------------------------------------------------------------------- */
/*  3. Credit Note                                                            */
/* -------------------------------------------------------------------------- */

export function buildCreditNoteXml(
  p: CreditNotePayload,
  names: TallyNames,
  company?: string
): string {
  const taxableTotal = p.lineItems.reduce((sum, l) => sum + l.taxableValue, 0);
  const taxTotal = Number((p.totalCreditAmount - taxableTotal).toFixed(2));

  // Mirror image of the sale: we now owe the customer.
  const ledgerEntries: LedgerEntry[] = [
    { ledger: p.buyerLedgerName ?? "", amount: p.totalCreditAmount, isPartyLedger: true },
    { ledger: names.salesLedger, amount: -taxableTotal },
  ];
  ledgerEntries.push(...taxLedgerEntries(taxTotal, { gstin: p.buyerGstin ?? null, state: null }, names, -1));
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
  company?: string
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

export function buildVoucherXml(
  type: TallyJobType,
  payload: unknown,
  names: TallyNames,
  company?: string
): string {
  switch (type) {
    case "push_sales_order":
      return buildSalesOrderXml(payload as SalesOrderPayload, names, company);
    case "push_delivery_note":
      return buildDeliveryNoteXml(payload as DeliveryNotePayload, names, company);
    case "push_credit_note":
      return buildCreditNoteXml(payload as CreditNotePayload, names, company);
    case "push_new_ledger":
      return buildNewLedgerXml(payload as NewLedgerPayload, names, company);
    case "push_stock_journal":
      return buildStockJournalXml(payload as StockJournalPayload, names, company);
    case "push_cancel_sales_order":
      return buildCancelSalesOrderXml(payload as CancelSalesOrderPayload, names, company);
    default:
      throw new Error(`Unknown Tally job type: ${type}`);
  }
}
