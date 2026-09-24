// Generic Tally voucher/XML rendering.
//
// Includes third-party MIT-licensed code — see NOTICE. The XML structure below is drawn from
// https://help.tallysolutions.com/sample-xml/ and is the part we least want to reinvent.
// Excer-specific voucher construction lives in `src/excer/vouchers.ts`, which builds the
// `VoucherInput` objects this module renders.
//
// EXCER ADDITION: `remoteId` — stamped onto the voucher as <REMOTEID>. This is what makes a
// retried push idempotent: Tally rejects a second import carrying a REMOTEID it has already
// seen, and `src/server.ts` translates that rejection into `{ duplicate: true }` rather than an
// error. See CLAUDE.md §20.4 / §21.2 in the main repo.
//
// UNVERIFIED: the exact <REMOTEID> tag placement has not been confirmed against a live Tally.
// TallyConnector's captured fixtures use <REMOTEALTGUID> for *masters*; <REMOTEID> is the
// documented voucher field. Verify both during the one-day validation pass before trusting
// duplicate suppression.
//
// EXCER ADDITION: `isOptional` — stamped onto the voucher as <ISOPTIONAL>Yes</ISOPTIONAL>, which
// Tally posts to its "Optional Vouchers" register instead of the regular books. Added 2026-09-23
// when the main app's push became fully automatic (CLAUDE.md §21/§22): an unattended push can no
// longer rely on an admin's button-press as the review step, so Optional makes Tally itself the
// review gate — an accountant converts each voucher to Regular inside Tally before it affects any
// balance or report. UNVERIFIED against a live Tally, same as <REMOTEID> above.

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
    .enum(["Accounting Voucher View", "Invoice Voucher View", "Inventory Voucher View"])
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

export function renderLedgerEntry(e: LedgerEntry): string {
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
    <ALLLEDGERENTRIES.LIST>
      <LEDGERNAME>${escapeXml(e.ledger)}</LEDGERNAME>
      <ISDEEMEDPOSITIVE>${isDr ? "Yes" : "No"}</ISDEEMEDPOSITIVE>
      ${e.isPartyLedger ? "<ISPARTYLEDGER>Yes</ISPARTYLEDGER>" : ""}
      <AMOUNT>${e.amount.toFixed(2)}</AMOUNT>
      ${billLines}
    </ALLLEDGERENTRIES.LIST>`;
}

export function renderInventoryEntry(i: InventoryEntry): string {
  const unit = i.unit ?? "nos";
  const isDeemed = i.isDeemedPositive ?? false;
  const rateBlock =
    i.rate !== undefined ? `<RATE>${i.rate.toFixed(2)}/${escapeXml(unit)}</RATE>` : "";
  const destination = i.destinationGodown
    ? `<DESTINATIONGODOWNNAME>${escapeXml(i.destinationGodown)}</DESTINATIONGODOWNNAME>`
    : "";
  const batch = `
    <BATCHALLOCATIONS.LIST>
      <GODOWNNAME>${escapeXml(i.godown ?? "Main Location")}</GODOWNNAME>
      <BATCHNAME>${escapeXml(i.batch ?? "Primary Batch")}</BATCHNAME>
      ${destination}
      <AMOUNT>${i.amount.toFixed(2)}</AMOUNT>
      <ACTUALQTY>${i.quantity} ${escapeXml(unit)}</ACTUALQTY>
      <BILLEDQTY>${i.quantity} ${escapeXml(unit)}</BILLEDQTY>
    </BATCHALLOCATIONS.LIST>`;
  const accAllocation = i.accountingLedger
    ? `<ACCOUNTINGALLOCATIONS.LIST>
        <LEDGERNAME>${escapeXml(i.accountingLedger)}</LEDGERNAME>
        <ISDEEMEDPOSITIVE>${isDeemed ? "Yes" : "No"}</ISDEEMEDPOSITIVE>
        <AMOUNT>${i.amount.toFixed(2)}</AMOUNT>
      </ACCOUNTINGALLOCATIONS.LIST>`
    : "";
  return `
    <ALLINVENTORYENTRIES.LIST>
      <STOCKITEMNAME>${escapeXml(i.stockItem)}</STOCKITEMNAME>
      <ISDEEMEDPOSITIVE>${isDeemed ? "Yes" : "No"}</ISDEEMEDPOSITIVE>
      ${rateBlock}
      <AMOUNT>${i.amount.toFixed(2)}</AMOUNT>
      <ACTUALQTY>${i.quantity} ${escapeXml(unit)}</ACTUALQTY>
      <BILLEDQTY>${i.quantity} ${escapeXml(unit)}</BILLEDQTY>
      ${batch}
      ${accAllocation}
    </ALLINVENTORYENTRIES.LIST>`;
}

export function renderVoucher(args: VoucherInput): string {
  const view = args.view ?? (args.isInvoice ? "Invoice Voucher View" : "Accounting Voucher View");
  const isInvoice = args.isInvoice ?? view === "Invoice Voucher View";

  const ledgerXml = args.ledgerEntries.map(renderLedgerEntry).join("");
  const invXml = (args.inventoryEntries ?? []).map(renderInventoryEntry).join("");
  const remote = args.remoteId ? `<REMOTEID>${escapeXml(args.remoteId)}</REMOTEID>` : "";
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
      <VOUCHER VCHTYPE="${escapeXml(args.voucherType)}" ACTION="Create" OBJVIEW="${escapeXml(view)}">
        ${remote}
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

/** Cancel an existing voucher, identified by its Tally voucher number. */
export function renderCancelVoucher(args: {
  voucherType: string;
  date: string;
  voucherNumber: string;
  narration?: string;
}): string {
  const narration = args.narration ? `<NARRATION>${escapeXml(args.narration)}</NARRATION>` : "";
  const tagValue = escapeXml(args.voucherNumber);
  return `
    <TALLYMESSAGE xmlns:UDF="TallyUDF">
      <VOUCHER DATE="${tallyDate(args.date)}" TAGNAME="VoucherNumber" TAGVALUE="${tagValue}" Action="Cancel" VCHTYPE="${escapeXml(args.voucherType)}">
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

/** Assert that a voucher's ledger entries balance, as Tally requires. */
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
