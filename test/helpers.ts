// Shared fixtures: a fake Tally that answers by collection name, and a baseline config.

import type { AgentConfig, TallyNames } from "../src/excer/config.js";
import type { TallyClient } from "../src/tally/client.js";
import { parseTallyXml } from "../src/tally/xml.js";

export const names: TallyNames = {
  salesOrderVoucherType: "Sales Order",
  deliveryNoteVoucherType: "Delivery Note",
  creditNoteVoucherType: "Credit Note",
  stockJournalVoucherType: "Stock Journal",
  salesLedger: "Sales Accounts",
  cgstLedger: "CGST",
  sgstLedger: "SGST",
  igstLedger: "IGST",
  discountLedger: "Discount Allowed",
  customerParentGroup: "Sundry Debtors",
  homeState: "Kerala",
};

export function agentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    port: 7010,
    apiKey: "test-key",
    appBaseUrl: "https://app.test",
    appToken: "tok",
    pollIntervalMs: 15_000,
    heartbeatIntervalMs: 30_000,
    stockRefreshMinIntervalMs: 60_000,
    stateFile: "unused",
    agentId: "test-agent",
    postVouchersAsOptional: true,
    tallyNames: names,
    ...overrides,
  };
}

export function collection(inner: string): string {
  return `<ENVELOPE><BODY><DATA><COLLECTION>${inner}</COLLECTION></DATA></BODY></ENVELOPE>`;
}

export function counters(masters: number, vouchers: number): string {
  return collection(`<COMPANY><ALTMSTID>${masters}</ALTMSTID><ALTVCHID>${vouchers}</ALTVCHID></COMPANY>`);
}

export function stockItem(guid: string, alterId: number, qty: number): string {
  return `<STOCKITEM NAME="${guid}"><GUID>${guid}</GUID><ALTERID>${alterId}</ALTERID><CLOSINGBALANCE>${qty} Nos</CLOSINGBALANCE></STOCKITEM>`;
}

/**
 * A stand-in TallyClient. `respond` sees each request's XML and returns Tally's answer; every
 * request is recorded so tests can assert on what was (and was not) asked.
 */
export function fakeClient(respond: (xml: string) => string, company = "Test Co") {
  const requests: string[] = [];
  const client = {
    config: { url: "http://fake-tally:9000", defaultCompany: company, host: "fake", port: 9000, timeoutMs: 1000 },
    async send(xml: string) {
      requests.push(xml);
      return respond(xml);
    },
    async sendAndParse(xml: string) {
      return parseTallyXml(await client.send(xml));
    },
  } as unknown as TallyClient;
  return { client, requests };
}

export function collectionId(xml: string): string {
  return /<ID>([^<]+)<\/ID>/.exec(xml)?.[1] ?? "";
}
