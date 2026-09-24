// Finding records we have already written to Tally.
//
// EXCER ADDITION. Two jobs:
//
//   1. Idempotency BEFORE writing. Checking "does a voucher with this REMOTEID already exist?"
//      before sending means a retry never reaches Tally's import at all. That matters because a
//      re-import carrying a known REMOTEID may *alter* the existing voucher rather than be
//      ignored — and altering it would, for example, flip a voucher the accountant has already
//      converted to Regular back to Optional.
//
//   2. Real identifiers AFTER writing. Tally's import response reports LASTVCHID, which is its
//      internal master id — NOT the voucher number. Cancelling by voucher number with that value
//      could cancel a different order. So after a successful import we read the voucher back by
//      REMOTEID and return its actual GUID and VOUCHERNUMBER.
//
// VERIFIED against a live TallyPrime Edit Log (2026-09-24): the REMOTEID we send as a <VOUCHER>
// attribute reads back as `$RemoteGUID` (NOT `$RemoteID`, which never matches); a ledger's
// REMOTEALTGUID reads back as `$RemoteAltGUID`. The SVFROMDATE/SVTODATE scope did not restrict the
// voucher lookup on that build — it found the voucher from another date — so the lookup is safe
// even if a date is off, at the cost of scanning the company's vouchers.

import type { TallyClient } from "../tally/client.js";
import { buildExportCollectionEnvelope, escapeXml, parseTallyXmlAsStrings } from "../tally/xml.js";
import { asArray, s } from "../tally/util.js";

/**
 * Quote a value for a TDL formula. TDL string literals have no escape for `"`, so a value
 * containing one cannot be matched safely — refuse it rather than build a broken filter.
 */
function tdlString(value: string): string {
  if (value.includes('"')) {
    throw new Error(`Cannot look up ${JSON.stringify(value)} in Tally: it contains a double quote.`);
  }
  return `"${escapeXml(value)}"`;
}

function collectionRows(xml: string, tag: string): any[] {
  const tree = parseTallyXmlAsStrings(xml);
  const collection = tree?.ENVELOPE?.BODY?.DATA?.COLLECTION ?? tree?.ENVELOPE?.BODY?.DATA ?? {};
  return asArray(collection?.[tag]);
}

export interface VoucherIdentity {
  guid: string;
  /**
   * Informational only — NOT an identifier. Verified live: Tally gives Optional vouchers
   * non-unique numbers (two Optional credit notes were both "6"), and a Sales Order type can have
   * no numbering at all. Anything that must find a voucher again uses its REMOTEID.
   */
  voucherNumber: string | null;
  cancelled: boolean;
}

/**
 * Find a voucher by the REMOTEID we stamped on it. `date`, when known, is passed as the report
 * period; on the verified build it did not narrow the search, so a missing or wrong date is safe.
 */
export async function findVoucherByRemoteId(
  client: TallyClient,
  remoteId: string,
  date: string | null,
  company?: string
): Promise<VoucherIdentity | null> {
  const xml = buildExportCollectionEnvelope({
    collectionName: "ExcerVoucherByRemoteId",
    staticVariables: { company, ...(date ? { fromDate: date, toDate: date } : {}) },
    tdlMessage: `
      <COLLECTION NAME="ExcerVoucherByRemoteId" ISMODIFY="No">
        <TYPE>Voucher</TYPE>
        <FETCH>GUID</FETCH>
        <FETCH>VoucherNumber</FETCH>
        <FETCH>RemoteGUID</FETCH>
        <FETCH>IsCancelled</FETCH>
        <FILTER>ExcerMatchRemoteId</FILTER>
      </COLLECTION>
      <SYSTEM TYPE="Formulae" NAME="ExcerMatchRemoteId">$RemoteGUID = ${tdlString(remoteId)}</SYSTEM>`,
  });
  const row = collectionRows(await client.send(xml), "VOUCHER")[0];
  if (!row) return null;
  return {
    guid: s(row.GUID ?? row["@_GUID"]),
    voucherNumber: s(row.VOUCHERNUMBER) || null,
    cancelled: s(row.ISCANCELLED).toLowerCase() === "yes",
  };
}

export interface LedgerIdentity {
  guid: string;
  /** The REMOTEALTGUID we stamped when creating it; empty for ledgers created inside Tally. */
  remoteAltGuid: string;
}

/** Find a ledger by name. Tally ledger names are unique (case-insensitively) within a company. */
export async function findLedgerByName(
  client: TallyClient,
  name: string,
  company?: string
): Promise<LedgerIdentity | null> {
  const xml = buildExportCollectionEnvelope({
    collectionName: "ExcerLedgerByName",
    staticVariables: { company },
    tdlMessage: `
      <COLLECTION NAME="ExcerLedgerByName" ISMODIFY="No">
        <TYPE>Ledger</TYPE>
        <FETCH>GUID</FETCH>
        <FETCH>Name</FETCH>
        <FETCH>RemoteAltGUID</FETCH>
        <FILTER>ExcerMatchLedgerName</FILTER>
      </COLLECTION>
      <SYSTEM TYPE="Formulae" NAME="ExcerMatchLedgerName">$Name = ${tdlString(name)}</SYSTEM>`,
  });
  const row = collectionRows(await client.send(xml), "LEDGER")[0];
  if (!row) return null;
  return {
    guid: s(row.GUID ?? row["@_GUID"]),
    remoteAltGuid: s(row.REMOTEALTGUID ?? row["@_REMOTEALTGUID"]),
  };
}
