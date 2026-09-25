// Reading masters out of Tally: stock items and customer ledgers.
//
// AlterID-based incremental sync.
//
// Tally stamps every master with an ALTERID that increases whenever the record is edited. That
// gives us a two-stage poll:
//
//   1. `getLastAlterIds()` asks the Company object for its current max AlterID. This is a tiny
//      request that returns two numbers.
//   2. Only when that number has moved do we run the expensive query, and even then we ask for
//      `$AlterID > lastSeen` so we get just the changed rows.
//
// This matters more than it looks. Tally is single-threaded per company: a heavy export blocks
// the operator's UI. Polling full masters every 15s would make Tally visibly stutter for the
// accountant. Polling a counter costs nothing, so the 15s interval stays neighbourly.

import type { TallyClient } from "../tally/client.js";
import { buildExportCollectionEnvelope, escapeXml, parseTallyXmlAsStrings } from "../tally/xml.js";
import { asArray, n, s, text } from "../tally/util.js";
import type { TallyLedgerRow, TallyStockItemRow } from "./contract.js";

/* -------------------------------------------------------------------------- */
/*  Stage 1 — the cheap "has anything changed?" counter                        */
/* -------------------------------------------------------------------------- */

export interface LastAlterIds {
  masters: number;
  vouchers: number;
}

/**
 * UNVERIFIED: the Company object's AlterID field names (ALTMSTID / ALTVCHID) are the ones
 * TallyConnector's "AlterIdsReport" uses, but they have not been confirmed against this
 * client's Tally build. If these come back as 0 on a live system, inspect the raw XML and
 * adjust — the rest of the polling logic is unaffected.
 */
export async function getLastAlterIds(client: TallyClient, company?: string): Promise<LastAlterIds> {
  const xml = buildExportCollectionEnvelope({
    collectionName: "ExcerAlterIds",
    staticVariables: { company },
    tdlMessage: `
      <COLLECTION NAME="ExcerAlterIds" ISMODIFY="No">
        <TYPE>Company</TYPE>
        <FETCH>AltMstId</FETCH>
        <FETCH>AltVchId</FETCH>
      </COLLECTION>`,
  });
  const tree = parseTallyXmlAsStrings(await client.send(xml));
  const collection = tree?.ENVELOPE?.BODY?.DATA?.COLLECTION ?? tree?.ENVELOPE?.BODY?.DATA ?? {};
  const company0 = asArray(collection?.COMPANY)[0] ?? {};
  return {
    masters: n(company0?.ALTMSTID),
    vouchers: n(company0?.ALTVCHID),
  };
}

/* -------------------------------------------------------------------------- */
/*  Stage 2 — the actual rows, filtered by AlterID                             */
/* -------------------------------------------------------------------------- */

function alterIdFilter(sinceAlterId: number): { filterTag: string; systemTag: string } {
  if (sinceAlterId <= 0) return { filterTag: "", systemTag: "" };
  return {
    filterTag: "<FILTER>ExcerSinceAlter</FILTER>",
    systemTag: `<SYSTEM TYPE="Formulae" NAME="ExcerSinceAlter">$AlterID &gt; ${sinceAlterId}</SYSTEM>`,
  };
}

export async function fetchStockItems(
  client: TallyClient,
  sinceAlterId = 0,
  company?: string
): Promise<TallyStockItemRow[]> {
  const { filterTag, systemTag } = alterIdFilter(sinceAlterId);
  const xml = buildExportCollectionEnvelope({
    collectionName: "ExcerStockItems",
    staticVariables: { company },
    tdlMessage: `
      <COLLECTION NAME="ExcerStockItems" ISMODIFY="No">
        <TYPE>StockItem</TYPE>
        <FETCH>GUID</FETCH>
        <FETCH>Name</FETCH>
        <FETCH>Alias</FETCH>
        <FETCH>AlterID</FETCH>
        <FETCH>ClosingBalance</FETCH>
        <FETCH>BaseUnits</FETCH>
        <FETCH>HSNCode</FETCH>
        <FETCH>GSTRate</FETCH>
        <FETCH>GSTDetails</FETCH>
        <FETCH>HSNDetails</FETCH>
        <FETCH>StandardPriceList</FETCH>
        <FETCH>IsDeleted</FETCH>
        ${filterTag}
      </COLLECTION>
      ${systemTag}`,
  });

  const tree = parseTallyXmlAsStrings(await client.send(xml));
  const collection = tree?.ENVELOPE?.BODY?.DATA?.COLLECTION ?? tree?.ENVELOPE?.BODY?.DATA ?? {};
  return asArray(collection?.STOCKITEM).map((row: any) => ({
    guid: s(row?.GUID),
    name: text(row?.["@_NAME"] ?? row?.NAME),
    alias: text(row?.ALIAS) || null,
    alterId: n(row?.ALTERID),
    // ClosingBalance arrives as e.g. "42 Nos" — strip the unit.
    closingStockQty: n(String(s(row?.CLOSINGBALANCE)).replace(/[^\d.-]/g, "")),
    godown: null,
    baseUnit: s(row?.BASEUNITS) || "Nos",
    hsnCode: s(latestDated(row?.["HSNDETAILS.LIST"])?.HSNCODE) || s(row?.HSNCODE) || null,
    gstRate: itemGstRate(row),
    // The standard selling price SET on the item (latest STANDARDPRICELIST entry), ex-GST, or null.
    // Verified live — neither alternative is a selling price:
    //   OpeningRate     = opening-stock valuation (cost) rate
    //   $StandardPrice  = computed; with no list set it falls back to the LAST SALE's rate
    baseRate: rateOrNull(latestByDate(row?.["STANDARDPRICELIST.LIST"])?.RATE),
    active: s(row?.ISDELETED).toLowerCase() !== "yes",
  }));
}

/** The latest entry of a list dated by <DATE> (e.g. STANDARDPRICELIST.LIST), or null. */
function latestByDate(list: unknown): any | null {
  const entries = asArray(list as any).filter((e) => e && typeof e === "object" && s(e.DATE));
  if (entries.length === 0) return null;
  return entries.reduce((a, b) => (s(b.DATE) > s(a.DATE) ? b : a));
}

/** A Tally rate like "60.00/Mtr" as a number, or null when empty. */
function rateOrNull(v: unknown): number | null {
  const digits = s(v).split("/")[0].replace(/[^\d.-]/g, "");
  return digits === "" ? null : n(digits);
}

/**
 * A stock item's total GST rate (18 for 18%), or null when it is not known.
 *
 * TallyPrime 3+ keeps it in the dated GSTDETAILS.LIST -> STATEWISEDETAILS.LIST ->
 * RATEDETAILS.LIST, one row per duty head; the flat GSTRate field comes back EMPTY (verified live
 * 2026-09-24). IGST carries the full rate; CGST + SGST/UTGST add up to it.
 *
 * null — never 0 — when no rate is set on the item (e.g. it inherits GST from its stock group):
 * the website must treat "unknown" differently from "0%", or every such sale is posted tax-free.
 */
function itemGstRate(row: any): number | null {
  const gst = latestDated(row?.["GSTDETAILS.LIST"]);
  if (gst) {
    const taxability = s(gst.TAXABILITY).toLowerCase();
    if (taxability === "exempt" || taxability === "nil rated") return 0;
    const rates = asArray(gst["STATEWISEDETAILS.LIST"])
      .flatMap((sw: any) => asArray(sw?.["RATEDETAILS.LIST"]))
      .filter((r: any) => s(r?.GSTRATE).trim() !== "");
    const head = (r: any) => s(r?.GSTRATEDUTYHEAD).toLowerCase();
    const igst = rates.find((r: any) => head(r).includes("igst") || head(r).includes("integrated"));
    if (igst) return n(igst.GSTRATE);
    const split = rates.filter((r: any) => /cgst|sgst|utgst|central|state/.test(head(r)));
    if (split.length > 0) return split.reduce((sum: number, r: any) => sum + n(r.GSTRATE), 0);
  }
  // Older builds: a flat field. Only trust it when it actually holds a value.
  return s(row?.GSTRATE).trim() !== "" ? n(row.GSTRATE) : null;
}

/**
 * Pick the entry in force from a dated Tally list (LEDMAILINGDETAILS.LIST, LEDGSTREGDETAILS.LIST):
 * the one with the latest APPLICABLEFROM. Dates are YYYYMMDD, so string order is date order.
 */
function latestDated(list: unknown): any | null {
  const entries = asArray(list as any).filter((e) => e && typeof e === "object");
  if (entries.length === 0) return null;
  return entries.reduce((a, b) => (s(b.APPLICABLEFROM) > s(a.APPLICABLEFROM) ? b : a));
}

export async function fetchLedgers(
  client: TallyClient,
  sinceAlterId = 0,
  company?: string,
  parentGroup = "Sundry Debtors"
): Promise<TallyLedgerRow[]> {
  const { filterTag, systemTag } = alterIdFilter(sinceAlterId);
  // Restricting to the customer parent group is what keeps bank/cash/suppliers out of the
  // customer sync — CLAUDE.md §21.5 #9 flagged exactly this on the vendor's flat ledger export.
  // $$IsBelongsTo, not `$Parent =`: customers are often kept in sub-groups ("Sundry Debtors -
  // Kerala"), and `$Parent =` matches direct children only — verified on a live TallyPrime, where
  // it silently dropped a sub-group customer.
  const groupFilter = `<SYSTEM TYPE="Formulae" NAME="ExcerCustomerGroup">$$IsBelongsTo:"${escapeXml(
    parentGroup
  )}"</SYSTEM>`;

  const xml = buildExportCollectionEnvelope({
    collectionName: "ExcerLedgers",
    staticVariables: { company },
    tdlMessage: `
      <COLLECTION NAME="ExcerLedgers" ISMODIFY="No">
        <TYPE>Ledger</TYPE>
        <FETCH>GUID</FETCH>
        <FETCH>Name</FETCH>
        <FETCH>Parent</FETCH>
        <FETCH>AlterID</FETCH>
        <FETCH>LedMailingDetails</FETCH>
        <FETCH>LedGSTRegDetails</FETCH>
        <FETCH>PartyGSTIN</FETCH>
        <FETCH>LedStateName</FETCH>
        <FETCH>Address</FETCH>
        <FETCH>Pincode</FETCH>
        <FETCH>LedgerPhone</FETCH>
        <FETCH>Email</FETCH>
        <FETCH>CreditLimit</FETCH>
        <FETCH>IsDeleted</FETCH>
        <FILTER>ExcerCustomerGroup</FILTER>
        ${filterTag}
      </COLLECTION>
      ${groupFilter}
      ${systemTag}`,
  });

  const tree = parseTallyXmlAsStrings(await client.send(xml));
  const collection = tree?.ENVELOPE?.BODY?.DATA?.COLLECTION ?? tree?.ENVELOPE?.BODY?.DATA ?? {};
  return asArray(collection?.LEDGER).map((row: any) => {
    // TallyPrime 3+ keeps address/state and GST registration in dated lists; older builds used
    // flat fields. Read the current entry of the new lists, falling back to the old fields.
    const mailing = latestDated(row?.["LEDMAILINGDETAILS.LIST"]);
    const gstReg = latestDated(row?.["LEDGSTREGDETAILS.LIST"]);
    const addressSource = mailing?.["ADDRESS.LIST"] ?? row?.["ADDRESS.LIST"];
    const addressLines = asArray(addressSource?.ADDRESS ?? row?.ADDRESS)
      .map((a: unknown) => text(a))
      .filter(Boolean);
    return {
      guid: s(row?.GUID),
      alterId: n(row?.ALTERID),
      ledgerName: text(row?.["@_NAME"] ?? row?.NAME),
      gstin: s(gstReg?.GSTIN) || s(row?.PARTYGSTIN) || null,
      addressLine: addressLines.join(", ") || null,
      city: text(mailing?.CITY) || null,
      state: s(mailing?.STATE) || s(row?.LEDSTATENAME) || null,
      pincode: s(mailing?.PINCODE) || s(row?.PINCODE) || null,
      mobile: s(row?.LEDGERPHONE) || null,
      email: s(row?.EMAIL) || null,
      creditLimit: row?.CREDITLIMIT !== undefined ? n(row.CREDITLIMIT) : null,
      active: s(row?.ISDELETED).toLowerCase() !== "yes",
    };
  });
}
