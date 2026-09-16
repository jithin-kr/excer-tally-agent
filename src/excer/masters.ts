// Reading masters out of Tally: stock items and customer ledgers.
//
// EXCER ADDITION (not in upstream): AlterID-based incremental sync.
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
import { buildExportCollectionEnvelope, escapeXml } from "../tally/xml.js";
import { asArray, n, s } from "../tally/util.js";
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
  const tree = await client.sendAndParse(xml);
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
        <FETCH>OpeningRate</FETCH>
        <FETCH>IsDeleted</FETCH>
        ${filterTag}
      </COLLECTION>
      ${systemTag}`,
  });

  const tree = await client.sendAndParse(xml);
  const collection = tree?.ENVELOPE?.BODY?.DATA?.COLLECTION ?? tree?.ENVELOPE?.BODY?.DATA ?? {};
  return asArray(collection?.STOCKITEM).map((row: any) => ({
    guid: s(row?.GUID),
    name: s(row?.NAME ?? row?.["@_NAME"]),
    alias: s(row?.ALIAS) || null,
    alterId: n(row?.ALTERID),
    // ClosingBalance arrives as e.g. "42 Nos" — strip the unit.
    closingStockQty: n(String(s(row?.CLOSINGBALANCE)).replace(/[^\d.-]/g, "")),
    godown: null,
    baseUnit: s(row?.BASEUNITS) || "Nos",
    hsnCode: s(row?.HSNCODE) || null,
    gstRate: row?.GSTRATE !== undefined ? n(row.GSTRATE) : null,
    baseRate: n(String(s(row?.OPENINGRATE)).replace(/[^\d.-]/g, "")),
    active: s(row?.ISDELETED).toLowerCase() !== "yes",
  }));
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
  const groupFilter = `<SYSTEM TYPE="Formulae" NAME="ExcerCustomerGroup">$Parent = "${escapeXml(
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

  const tree = await client.sendAndParse(xml);
  const collection = tree?.ENVELOPE?.BODY?.DATA?.COLLECTION ?? tree?.ENVELOPE?.BODY?.DATA ?? {};
  return asArray(collection?.LEDGER).map((row: any) => {
    const addressLines = asArray(row?.["ADDRESS.LIST"]?.ADDRESS ?? row?.ADDRESS)
      .map((a: unknown) => s(a))
      .filter(Boolean);
    return {
      guid: s(row?.GUID),
      alterId: n(row?.ALTERID),
      ledgerName: s(row?.NAME ?? row?.["@_NAME"]),
      gstin: s(row?.PARTYGSTIN) || null,
      addressLine: addressLines.join(", ") || null,
      city: null,
      state: s(row?.LEDSTATENAME) || null,
      pincode: s(row?.PINCODE) || null,
      mobile: s(row?.LEDGERPHONE) || null,
      email: s(row?.EMAIL) || null,
      creditLimit: row?.CREDITLIMIT !== undefined ? n(row.CREDITLIMIT) : null,
      active: s(row?.ISDELETED).toLowerCase() !== "yes",
    };
  });
}
