// XML helpers for building Tally Prime request envelopes and parsing responses.
//
// All envelopes follow the structure documented at
// https://help.tallysolutions.com/understanding-tally-xml-tags/ and
// https://help.tallysolutions.com/xml-integration/ :
//
//   <ENVELOPE>
//     <HEADER>...</HEADER>
//     <BODY>
//       <DESC>...</DESC>           // for Export requests
//       <DATA>...</DATA>           // for raw Data
//       <IMPORTDATA>...</IMPORTDATA>  // for Import requests
//     </BODY>
//   </ENVELOPE>

import { XMLParser } from "fast-xml-parser";

/** Escape a string for safe inclusion in XML PCDATA / attributes. */
export function escapeXml(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Tally date format: YYYYMMDD (universal/uni-date format). */
export function tallyDate(input: string | Date): string {
  if (input instanceof Date) {
    const y = input.getFullYear().toString().padStart(4, "0");
    const m = (input.getMonth() + 1).toString().padStart(2, "0");
    const d = input.getDate().toString().padStart(2, "0");
    return `${y}${m}${d}`;
  }
  const s = input.trim();
  // already YYYYMMDD
  if (/^\d{8}$/.test(s)) return s;
  // ISO YYYY-MM-DD
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return `${iso[1]}${iso[2]}${iso[3]}`;
  // DD-MM-YYYY or DD/MM/YYYY
  const dmy = s.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})$/);
  if (dmy) {
    const d = dmy[1].padStart(2, "0");
    const m = dmy[2].padStart(2, "0");
    return `${dmy[3]}${m}${d}`;
  }
  // D-Mon-YYYY (e.g. 1-Apr-2024)
  const months: Record<string, string> = {
    jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
    jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
  };
  const dmon = s.match(/^(\d{1,2})[-\/ ]([A-Za-z]{3,})[-\/ ](\d{4})$/);
  if (dmon) {
    const mm = months[dmon[2].slice(0, 3).toLowerCase()];
    if (mm) return `${dmon[3]}${mm}${dmon[1].padStart(2, "0")}`;
  }
  const parsed = new Date(s);
  if (!Number.isNaN(parsed.getTime())) return tallyDate(parsed);
  throw new Error(`Cannot parse date: ${input}`);
}

export interface StaticVariables {
  /** Target company name. Mapped to SVCURRENTCOMPANY. */
  company?: string;
  /** Period start (any parseable date). Mapped to SVFROMDATE. */
  fromDate?: string | Date;
  /** Period end. Mapped to SVTODATE. */
  toDate?: string | Date;
  /** Export format — XML / HTML / JSON / ASCII. Defaults to XML. */
  exportFormat?: "XML" | "HTML" | "JSON" | "ASCII";
  /** Arbitrary extra static variables, key is the full tag name (e.g. "LedgerName"). */
  extra?: Record<string, string | number | boolean>;
}

function renderStaticVariables(vars: StaticVariables | undefined): string {
  if (!vars) return "";
  const lines: string[] = [];
  const format = vars.exportFormat ?? "XML";
  lines.push(`<SVEXPORTFORMAT>$$SysName:${format}</SVEXPORTFORMAT>`);
  if (vars.company) {
    lines.push(`<SVCURRENTCOMPANY>${escapeXml(vars.company)}</SVCURRENTCOMPANY>`);
  }
  if (vars.fromDate) {
    lines.push(`<SVFROMDATE TYPE="Date">${tallyDate(vars.fromDate)}</SVFROMDATE>`);
  }
  if (vars.toDate) {
    lines.push(`<SVTODATE TYPE="Date">${tallyDate(vars.toDate)}</SVTODATE>`);
  }
  if (vars.extra) {
    for (const [k, v] of Object.entries(vars.extra)) {
      lines.push(`<${k}>${escapeXml(v as any)}</${k}>`);
    }
  }
  return `<STATICVARIABLES>${lines.join("")}</STATICVARIABLES>`;
}

/* -------------------------------------------------------------------------- */
/*  EXPORT envelopes                                                          */
/* -------------------------------------------------------------------------- */

export interface ExportDataOptions {
  /** Report / data ID — e.g. "Trial Balance", "Day Book", "List of Accounts". */
  reportId: string;
  staticVariables?: StaticVariables;
  /** Raw TDL message body — inserted inside <TDL><TDLMESSAGE>...</TDLMESSAGE></TDL>. */
  tdlMessage?: string;
  /** Optional FETCH list (for OBJECT export). */
  fetchList?: string[];
}

export function buildExportEnvelope(opts: ExportDataOptions): string {
  const desc = [
    renderStaticVariables(opts.staticVariables),
    opts.fetchList && opts.fetchList.length
      ? `<FETCHLIST>${opts.fetchList.map((f) => `<FETCH>${escapeXml(f)}</FETCH>`).join("")}</FETCHLIST>`
      : "",
    opts.tdlMessage ? `<TDL><TDLMESSAGE>${opts.tdlMessage}</TDLMESSAGE></TDL>` : "",
  ].filter(Boolean).join("");

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<ENVELOPE>`,
    `<HEADER>`,
    `<VERSION>1</VERSION>`,
    `<TALLYREQUEST>Export</TALLYREQUEST>`,
    `<TYPE>Data</TYPE>`,
    `<ID>${escapeXml(opts.reportId)}</ID>`,
    `</HEADER>`,
    `<BODY><DESC>${desc}</DESC></BODY>`,
    `</ENVELOPE>`,
  ].join("");
}

export interface ExportCollectionOptions {
  collectionName: string;
  staticVariables?: StaticVariables;
  tdlMessage?: string;
}

export function buildExportCollectionEnvelope(opts: ExportCollectionOptions): string {
  const desc = [
    renderStaticVariables(opts.staticVariables),
    opts.tdlMessage ? `<TDL><TDLMESSAGE>${opts.tdlMessage}</TDLMESSAGE></TDL>` : "",
  ].filter(Boolean).join("");

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<ENVELOPE>`,
    `<HEADER>`,
    `<VERSION>1</VERSION>`,
    `<TALLYREQUEST>Export</TALLYREQUEST>`,
    `<TYPE>Collection</TYPE>`,
    `<ID>${escapeXml(opts.collectionName)}</ID>`,
    `</HEADER>`,
    `<BODY><DESC>${desc}</DESC></BODY>`,
    `</ENVELOPE>`,
  ].join("");
}

export interface ExportObjectOptions {
  /** Object subtype, e.g. "Ledger", "Group", "StockItem", "Voucher". */
  subType: string;
  /** Identifier (usually the name). */
  id: string;
  /** Identifier qualifier — default "Name". */
  idType?: string;
  fetchList?: string[];
  staticVariables?: StaticVariables;
}

export function buildExportObjectEnvelope(opts: ExportObjectOptions): string {
  const desc = [
    renderStaticVariables(opts.staticVariables),
    opts.fetchList && opts.fetchList.length
      ? `<FETCHLIST>${opts.fetchList.map((f) => `<FETCH>${escapeXml(f)}</FETCH>`).join("")}</FETCHLIST>`
      : "",
  ].filter(Boolean).join("");

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<ENVELOPE>`,
    `<HEADER>`,
    `<VERSION>1</VERSION>`,
    `<TALLYREQUEST>Export</TALLYREQUEST>`,
    `<TYPE>Object</TYPE>`,
    `<SUBTYPE>${escapeXml(opts.subType)}</SUBTYPE>`,
    `<ID TYPE="${escapeXml(opts.idType ?? "Name")}">${escapeXml(opts.id)}</ID>`,
    `</HEADER>`,
    `<BODY><DESC>${desc}</DESC></BODY>`,
    `</ENVELOPE>`,
  ].join("");
}

/* -------------------------------------------------------------------------- */
/*  IMPORT envelope                                                           */
/* -------------------------------------------------------------------------- */

export interface ImportOptions {
  /** "All Masters" for ledger/group/stock-item etc., or "Vouchers" for vouchers. */
  reportName: "All Masters" | "Vouchers" | string;
  /** Pre-rendered XML body — typically one or more <TALLYMESSAGE> blocks. */
  body: string;
  staticVariables?: StaticVariables;
}

export function buildImportEnvelope(opts: ImportOptions): string {
  const desc = renderStaticVariables(opts.staticVariables);
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<ENVELOPE>`,
    `<HEADER>`,
    `<VERSION>1</VERSION>`,
    `<TALLYREQUEST>Import</TALLYREQUEST>`,
    `<TYPE>Data</TYPE>`,
    `<ID>${escapeXml(opts.reportName)}</ID>`,
    `</HEADER>`,
    `<BODY>`,
    `<DESC>${desc}</DESC>`,
    `<DATA>${opts.body}</DATA>`,
    `</BODY>`,
    `</ENVELOPE>`,
  ].join("");
}

/* -------------------------------------------------------------------------- */
/*  Response parsing                                                          */
/* -------------------------------------------------------------------------- */

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  allowBooleanAttributes: true,
  parseAttributeValue: true,
  parseTagValue: true,
  trimValues: true,
  removeNSPrefix: true,
});

export function parseTallyXml(xml: string): any {
  return parser.parse(xml);
}

// EXCER ADDITION: the parser above turns "0012" into 12, which is wrong for identifiers — a
// voucher numbered "0012" must be cancelled as "0012". Use this one when reading ids and numbers
// that are really strings.
const stringParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  allowBooleanAttributes: true,
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
  removeNSPrefix: true,
});

export function parseTallyXmlAsStrings(xml: string): any {
  return stringParser.parse(xml);
}

export interface ImportResult {
  created: number;
  altered: number;
  deleted: number;
  combined: number;
  ignored: number;
  errors: number;
  cancelled: number;
  lastVchId: number;
  lastMId: number;
  lineError?: string;
  raw: string;
}

/** Parse the <RESPONSE>...</RESPONSE> block Tally returns for Import requests. */
export function parseImportResult(xml: string): ImportResult {
  const tree = parser.parse(xml);
  const env = tree?.ENVELOPE ?? tree;
  const resp =
    env?.BODY?.DATA?.RESPONSE ??
    env?.RESPONSE ??
    env?.BODY?.DATA ??
    {};
  const lineError =
    env?.BODY?.DATA?.LINEERROR ??
    env?.LINEERROR ??
    undefined;
  return {
    created: Number(resp.CREATED ?? 0) || 0,
    altered: Number(resp.ALTERED ?? 0) || 0,
    deleted: Number(resp.DELETED ?? 0) || 0,
    combined: Number(resp.COMBINED ?? 0) || 0,
    ignored: Number(resp.IGNORED ?? 0) || 0,
    errors: Number(resp.ERRORS ?? 0) || 0,
    cancelled: Number(resp.CANCELLED ?? 0) || 0,
    lastVchId: Number(resp.LASTVCHID ?? 0) || 0,
    lastMId: Number(resp.LASTMID ?? 0) || 0,
    lineError: lineError ? String(lineError) : undefined,
    raw: xml,
  };
}

/** Detect a Tally failure envelope (<STATUS>0</STATUS>). */
export function isFailureEnvelope(xml: string): { failed: boolean; reason?: string } {
  try {
    const tree = parser.parse(xml);
    const env = tree?.ENVELOPE ?? tree;
    const status = env?.HEADER?.STATUS;
    if (status !== undefined && Number(status) === 0) {
      const data = env?.BODY?.DATA;
      let reason: string | undefined;
      if (typeof data === "string") reason = data;
      else if (data?.LINEERROR) reason = String(data.LINEERROR);
      else if (data?.["STATUS.LIST"]?.STATUS?.DESC) reason = String(data["STATUS.LIST"].STATUS.DESC);
      return { failed: true, reason };
    }
  } catch {
    // fall through
  }
  return { failed: false };
}
