// Generic Tally voucher/XML rendering.
//
// Includes third-party MIT-licensed code — see NOTICE. The XML structure below is drawn from
// https://help.tallysolutions.com/sample-xml/ and is the part we least want to reinvent.
// Excer-specific voucher construction lives in `src/excer/vouchers.ts`, which builds the
// `VoucherInput` objects this module renders.
//
// EXCER ADDITION: `remoteId` — stamped as the REMOTEID *attribute* of <VOUCHER>, the idempotency
// key. VERIFIED on a live TallyPrime Edit Log (2026-09-24): as an attribute Tally stores it
// (readable back as $RemoteGUID); as a child element it is silently replaced by Tally's own GUID.
// A second import with the same REMOTEID ALTERS the existing voucher — it is not ignored — which
// is why `src/server.ts` looks the REMOTEID up BEFORE writing and never re-imports.
//
// EXCER ADDITION: `isOptional` — stamped onto the voucher as <ISOPTIONAL>Yes</ISOPTIONAL>, which
// Tally posts to its "Optional Vouchers" register instead of the regular books. Added 2026-09-23
// when the main app's push became fully automatic (CLAUDE.md §21/§22): an unattended push can no
// longer rely on an admin's button-press as the review step, so Optional makes Tally itself the
// review gate — an accountant converts each voucher to Regular inside Tally before it affects any
// balance or report. VERIFIED live: the voucher reads back with ISOPTIONAL Yes.
//
// Invoice-view layout (VERIFIED live): ledger lines go in LEDGERENTRIES.LIST, and the sales side
// is carried ONLY by each inventory line's ACCOUNTINGALLOCATIONS — see `src/excer/vouchers.ts`.

import { z } from "zod";
import { buildImportEnvelope, escapeXml, tallyDate } from "./xml.js";

/* -------------------------------------------------------------------------- */
/*  Schemas                                                                   */
/* -------------------------------------------------------------------------- */

export const ledgerEntrySchema = z.object({
  ledger: z.string().min(1),
  /** Signed: NEGATIVE = Debit (Dr), POSITIVE = Credit (Cr). Must net to zero across a voucher. */
  amount: z.number(),
  isPartyLedger: z.boolean().optional(),
  billAllocations: z
    .array(
      z.object({
        billName: z.string(),
        billType: z.enum(["Advance", "Agst Ref", "New Ref", "On Account"]).default("New Ref"),
        amount: z.number(),
      })
    )
    .optional(),
});

export const inventoryEntrySchema = z.object({
  stockItem: z.string().min(1),
  quantity: z.number(),
  rate: z.number().optional(),
  amount: z.number(),
  unit: z.string().optional(),
  godown: z.string().optional(),
  batch: z.string().optional(),
  destinationGodown: z.string().optional(),
  /** Sales/Purchase ledger this line allocates to (Invoice mode). */
  accountingLedger: z.string().optional(),
  isDeemedPositive: z.boolean().optional(),
  /**
   * EXCER: which list the line goes in. Omitted = ALLINVENTORYENTRIES.LIST (invoices, notes).
   * A Stock Journal needs "out" (source/consumed) and "in" (destination/produced) — verified live;
   * the flat list is rejected for a Stock Journal.
   */
  direction: z.enum(["in", "out"]).optional(),
});

export const voucherSchema = z.object({
  voucherType: z.string().min(1),
  date: z.string(),
  voucherNumber: z.string().optional(),
  reference: z.string().optional(),
  narration: z.string().optional(),
  partyLedger: z.string().optional(),
  isInvoice: z.boolean().optional(),
  view: z
    .enum(["Accounting Voucher View", "Invoice Voucher View", "Inventory Voucher View", "Consumption Voucher View"])
    .optional(),
  ledgerEntries: z.array(ledgerEntrySchema).default([]),
  inventoryEntries: z.array(inventoryEntrySchema).optional(),
  /** EXCER: idempotency key, stamped as <REMOTEID>. */
  remoteId: z.string().optional(),
  /** EXCER: posts as an Optional voucher — see the file header. */
  isOptional: z.boolean().optional(),
});

export type VoucherInput = z.infer<typeof voucherSchema>;
export type LedgerEntry = z.infer<typeof ledgerEntrySchema>;
export type InventoryEntry = z.infer<typeof inventoryEntrySchema>;

/* -------------------------------------------------------------------------- */
/*  Rendering                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * EXCER: `listTag` — invoice-view vouchers take their ledger lines as LEDGERENTRIES.LIST;
 * accounting-view ones as ALLLEDGERENTRIES.LIST. Verified on a live TallyPrime: an invoice-view
 * Credit Note with ALLLEDGERENTRIES.LIST is rejected (EXCEPTIONS 1, no message); the same voucher
 * with LEDGERENTRIES.LIST is created.
 */
export function renderLedgerEntry(e: LedgerEntry, listTag = "ALLLEDGERENTRIES.LIST"): string {
  const isDr = e.amount < 0;
  const billLines = (e.billAllocations ?? [])
    .map(
      (b) => `
    <BILLALLOCATIONS.LIST>
      <NAME>${escapeXml(b.billName)}</NAME>
      <BILLTYPE>${escapeXml(b.billType)}</BILLTYPE>
      <AMOUNT>${b.amount.toFixed(2)}</AMOUNT>
    </BILLALLOCATIONS.LIST>`
    )
    .join("");
  return `
    <${listTag}>
      <LEDGERNAME>${escapeXml(e.ledger)}</LEDGERNAME>
      <ISDEEMEDPOSITIVE>${isDr ? "Yes" : "No"}</ISDEEMEDPOSITIVE>
      ${e.isPartyLedger ? "<ISPARTYLEDGER>Yes</ISPARTYLEDGER>" : ""}
      <AMOUNT>${e.amount.toFixed(2)}</AMOUNT>
      ${billLines}
    </${listTag}>`;
}

/**
 * Inventory lines use the same sign convention as ledger lines: NEGATIVE amount = Debit (goods
 * coming IN, e.g. a sales return), POSITIVE = Credit (goods going OUT, e.g. a sale). The
 * ISDEEMEDPOSITIVE flag follows the sign unless set explicitly (a zero-value stock movement).
 *
 * EXCER: with no unit, quantities and rates are rendered bare ("10", "60.00") and Tally applies
 * the item's own base unit — verified live. Upstream defaulted to "nos", which Tally rejects for
 * any item not measured in Nos (e.g. cable in Mtr).
 */
export function renderInventoryEntry(i: InventoryEntry): string {
  const unit = i.unit ? ` ${escapeXml(i.unit)}` : "";
  const qty = `${i.quantity}${unit}`;
  const isDeemed = i.isDeemedPositive ?? i.amount < 0;
  const rateBlock =
    i.rate !== undefined
      ? `<RATE>${i.rate.toFixed(2)}${i.unit ? `/${escapeXml(i.unit)}` : ""}</RATE>`
      : "";
  const destination = i.destinationGodown
    ? `<DESTINATIONGODOWNNAME>${escapeXml(i.destinationGodown)}</DESTINATIONGODOWNNAME>`
    : "";
  const batch = `
    <BATCHALLOCATIONS.LIST>
      <GODOWNNAME>${escapeXml(i.godown ?? "Main Location")}</GODOWNNAME>
      <BATCHNAME>${escapeXml(i.batch ?? "Primary Batch")}</BATCHNAME>
      ${destination}
      <AMOUNT>${i.amount.toFixed(2)}</AMOUNT>
      <ACTUALQTY>${qty}</ACTUALQTY>
      <BILLEDQTY>${qty}</BILLEDQTY>
    </BATCHALLOCATIONS.LIST>`;
  const accAllocation = i.accountingLedger
    ? `<ACCOUNTINGALLOCATIONS.LIST>
        <LEDGERNAME>${escapeXml(i.accountingLedger)}</LEDGERNAME>
        <ISDEEMEDPOSITIVE>${isDeemed ? "Yes" : "No"}</ISDEEMEDPOSITIVE>
        <AMOUNT>${i.amount.toFixed(2)}</AMOUNT>
      </ACCOUNTINGALLOCATIONS.LIST>`
    : "";
  const listTag =
    i.direction === "in"
      ? "INVENTORYENTRIESIN.LIST"
      : i.direction === "out"
        ? "INVENTORYENTRIESOUT.LIST"
        : "ALLINVENTORYENTRIES.LIST";
  return `
    <${listTag}>
      <STOCKITEMNAME>${escapeXml(i.stockItem)}</STOCKITEMNAME>
      <ISDEEMEDPOSITIVE>${isDeemed ? "Yes" : "No"}</ISDEEMEDPOSITIVE>
      ${rateBlock}
      <AMOUNT>${i.amount.toFixed(2)}</AMOUNT>
      <ACTUALQTY>${qty}</ACTUALQTY>
      <BILLEDQTY>${qty}</BILLEDQTY>
      ${batch}
      ${accAllocation}
    </${listTag}>`;
}

export function renderVoucher(args: VoucherInput): string {
  const view = args.view ?? (args.isInvoice ? "Invoice Voucher View" : "Accounting Voucher View");
  const isInvoice = args.isInvoice ?? view === "Invoice Voucher View";

  const ledgerTag = isInvoice ? "LEDGERENTRIES.LIST" : "ALLLEDGERENTRIES.LIST";
  const ledgerXml = args.ledgerEntries.map((e) => renderLedgerEntry(e, ledgerTag)).join("");
  const invXml = (args.inventoryEntries ?? []).map(renderInventoryEntry).join("");
  // EXCER: REMOTEID must be an ATTRIBUTE of <VOUCHER>. As a child element (upstream's form) a live
  // TallyPrime silently ignores it and stamps its own GUID instead, so duplicate detection never
  // matches. As an attribute Tally keeps it (readable back as $RemoteGUID) and a re-import with
  // the same value ALTERS that voucher rather than creating a second one.
  const remoteAttr = args.remoteId ? ` REMOTEID="${escapeXml(args.remoteId)}"` : "";
  const vchNo = args.voucherNumber
    ? `<VOUCHERNUMBER>${escapeXml(args.voucherNumber)}</VOUCHERNUMBER>`
    : "";
  const reference = args.reference ? `<REFERENCE>${escapeXml(args.reference)}</REFERENCE>` : "";
  const party = args.partyLedger
    ? `<PARTYLEDGERNAME>${escapeXml(args.partyLedger)}</PARTYLEDGERNAME>` +
      `<PARTYNAME>${escapeXml(args.partyLedger)}</PARTYNAME>`
    : "";
  const narration = args.narration ? `<NARRATION>${escapeXml(args.narration)}</NARRATION>` : "";
  const optional = args.isOptional ? "<ISOPTIONAL>Yes</ISOPTIONAL>" : "";

  return `
    <TALLYMESSAGE xmlns:UDF="TallyUDF">
      <VOUCHER${remoteAttr} VCHTYPE="${escapeXml(args.voucherType)}" ACTION="Create" OBJVIEW="${escapeXml(view)}">
        <DATE>${tallyDate(args.date)}</DATE>
        <VOUCHERTYPENAME>${escapeXml(args.voucherType)}</VOUCHERTYPENAME>
        ${vchNo}
        ${reference}
        ${party}
        <PERSISTEDVIEW>${escapeXml(view)}</PERSISTEDVIEW>
        <ISINVOICE>${isInvoice ? "Yes" : "No"}</ISINVOICE>
        ${optional}
        ${narration}
        ${ledgerXml}
        ${invXml}
      </VOUCHER>
    </TALLYMESSAGE>`;
}

/**
 * Cancel an existing voucher, identified by the REMOTEID it was created with.
 *
 * EXCER: VERIFIED on a live TallyPrime — `<VOUCHER REMOTEID="…" ACTION="Cancel">` cancels exactly
 * that voucher (ISCANCELLED becomes Yes), with no date or voucher number needed. Upstream cancelled
 * by TAGNAME="VoucherNumber", which is unsafe here: Optional vouchers share numbers, and a Sales
 * Order type may have no numbering at all.
 */
export function renderCancelVoucher(args: {
  voucherType: string;
  remoteId: string;
  narration?: string;
}): string {
  const narration = args.narration ? `<NARRATION>${escapeXml(args.narration)}</NARRATION>` : "";
  return `
    <TALLYMESSAGE xmlns:UDF="TallyUDF">
      <VOUCHER REMOTEID="${escapeXml(args.remoteId)}" VCHTYPE="${escapeXml(args.voucherType)}" ACTION="Cancel">
        ${narration}
      </VOUCHER>
    </TALLYMESSAGE>`;
}

/** Wrap one or more rendered <TALLYMESSAGE> blocks into a Vouchers import envelope. */
export function voucherImportEnvelope(body: string, company?: string): string {
  return buildImportEnvelope({ reportName: "Vouchers", body, staticVariables: { company } });
}

/** Wrap rendered master blocks (ledgers, stock items) into an All Masters import envelope. */
export function masterImportEnvelope(body: string, company?: string): string {
  return buildImportEnvelope({ reportName: "All Masters", body, staticVariables: { company } });
}

/**
 * Assert that a voucher balances, as Tally requires. In invoice mode the sales/purchase side is
 * carried by each inventory line's ACCOUNTINGALLOCATIONS, so those count too — checking only the
 * ledger lines let a voucher that double-counted sales pass here and fail in Tally.
 */
export function assertVoucherBalanced(ledgerEntries: LedgerEntry[], inventoryEntries: InventoryEntry[] = []): void {
  assertBalanced([
    ...ledgerEntries,
    ...inventoryEntries
      .filter((i) => i.accountingLedger)
      .map((i) => ({ ledger: i.accountingLedger as string, amount: i.amount })),
  ]);
}

/** Assert that a set of ledger amounts nets to zero. */
export function assertBalanced(entries: LedgerEntry[]): void {
  if (entries.length === 0) return;
  // EXCER: `NaN > 0.01` is false, so without this a NaN amount would pass as "balanced".
  const bad = entries.find((e) => !Number.isFinite(e.amount));
  if (bad) {
    throw new Error(`Voucher ledger entry for "${bad.ledger}" has a non-numeric amount (${bad.amount}).`);
  }
  const total = entries.reduce((sum, e) => sum + e.amount, 0);
  if (Math.abs(total) > 0.01) {
    throw new Error(
      `Voucher ledger entries do not balance: net = ${total.toFixed(2)}. ` +
        `Negative amounts are Debits, positive are Credits — they must sum to zero.`
    );
  }
}
