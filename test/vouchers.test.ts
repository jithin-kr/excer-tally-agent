import { test } from "node:test";
import assert from "node:assert/strict";
import { buildVoucherXml, salesOrderNumber, splitGst, taxByRate } from "../src/excer/vouchers.js";
import { parseLedgersByRate, type TallyNames } from "../src/excer/config.js";
import { pushRequestSchema, type PushRequest } from "../src/excer/contract.js";
import { assertBalanced } from "../src/tally/voucher-render.js";
import { names } from "./helpers.js";

/* ── splitGst ─────────────────────────────────────────────────────────── */

test("splitGst: Kerala buyer is intra-state, CGST + SGST", () => {
  assert.deepEqual(splitGst(180, { gstin: null, state: "Kerala" }, names), { cgst: 90, sgst: 90, igst: 0 });
});

test("splitGst: state match ignores case and whitespace", () => {
  assert.equal(splitGst(100, { gstin: null, state: "  kerala " }, names).igst, 0);
});

test("splitGst: other-state buyer is IGST", () => {
  assert.deepEqual(splitGst(180, { gstin: null, state: "Tamil Nadu" }, names), { cgst: 0, sgst: 0, igst: 180 });
});

test("splitGst: falls back to the GSTIN state code when no state is on file", () => {
  assert.equal(splitGst(100, { gstin: "32ABCDE1234F1Z5", state: null }, names).igst, 0); // 32 = Kerala
  assert.equal(splitGst(100, { gstin: "33ABCDE1234F1Z5", state: null }, names).igst, 100); // 33 = TN
});

test("splitGst: free-text state wins over a conflicting GSTIN", () => {
  assert.equal(splitGst(100, { gstin: "33ABCDE1234F1Z5", state: "Kerala" }, names).igst, 0);
});

test("splitGst: odd paisa still sums exactly to the total", () => {
  const split = splitGst(495.91, { gstin: null, state: "Kerala" }, names);
  assert.equal(Math.round((split.cgst + split.sgst) * 100), 49591);
});

test("splitGst: nothing to go on throws instead of guessing", () => {
  assert.throws(() => splitGst(100, { gstin: null, state: null }, names), /Cannot determine/);
  assert.throws(() => splitGst(100, { gstin: "00XXXX", state: null }, names), /Cannot determine/);
});

/* ── payload validation ───────────────────────────────────────────────── */

function salesOrder(overrides: Record<string, unknown> = {}) {
  return {
    type: "push_sales_order",
    remoteId: "excer-so-1",
    orderDate: "2026-09-24",
    buyer: { ledgerGuid: null, ledgerName: "Acme Traders", gstin: null, state: "Kerala" },
    deliveryAddress: "Kochi",
    lineItems: [
      { itemName: "Cable 2.5mm", itemGuid: null, quantity: 10, unit: "Mtr", rate: 100, taxableValue: 1000, gstRate: 18 },
    ],
    subtotal: 1000,
    discountAmount: 0,
    taxableValue: 1000,
    taxTotal: 180,
    grandTotal: 1180,
    notes: null,
    ...overrides,
  };
}

test("schema: a well-formed sales order parses", () => {
  assert.equal(pushRequestSchema.safeParse(salesOrder()).success, true);
});

test("schema: missing grandTotal is rejected (it used to become NaN in the XML)", () => {
  const { grandTotal, ...rest } = salesOrder();
  assert.equal(pushRequestSchema.safeParse(rest).success, false);
});

test("schema: unknown type is rejected", () => {
  assert.equal(pushRequestSchema.safeParse(salesOrder({ type: "push_something" })).success, false);
});

test("schema: remoteId with a double quote is rejected (it would break the TDL lookup)", () => {
  assert.equal(pushRequestSchema.safeParse(salesOrder({ remoteId: 'a"b' })).success, false);
});

test("schema: nullable fields may be null or absent", () => {
  const item = { itemName: "X", quantity: 1, rate: 1, taxableValue: 1, unit: null };
  assert.equal(pushRequestSchema.safeParse(salesOrder({ lineItems: [item], notes: undefined })).success, true);
});

test("schema: credit note without a party ledger is rejected", () => {
  const credit = {
    type: "push_credit_note",
    remoteId: "excer-cn-1",
    referencedRemoteId: "excer-so-1",
    returnDate: "2026-09-24",
    lineItems: [{ itemName: "X", itemGuid: null, quantity: 1, rate: 100, taxableValue: 100, gstRate: 18 }],
    totalCreditAmount: 118,
    reason: null,
  };
  assert.equal(pushRequestSchema.safeParse(credit).success, false);
  assert.equal(pushRequestSchema.safeParse({ ...credit, buyerLedgerName: "Acme", buyerState: "Kerala" }).success, true);
});

/* ── XML ──────────────────────────────────────────────────────────────── */

function build(body: unknown, optional = true): string {
  const req = pushRequestSchema.parse(body) as PushRequest;
  return buildVoucherXml(req, names, "Test Co", optional);
}

test("sales order XML: stamps REMOTEID, Optional, and the intra-state tax ledgers", () => {
  const xml = build(salesOrder());
  // REMOTEID must be a <VOUCHER> ATTRIBUTE — as an element, live Tally silently drops it.
  assert.match(xml, /<VOUCHER REMOTEID="excer-so-1" /);
  assert.doesNotMatch(xml, /<REMOTEID>/);
  assert.match(xml, /<ISOPTIONAL>Yes<\/ISOPTIONAL>/);
  assert.match(xml, /<LEDGERNAME>CGST<\/LEDGERNAME>/);
  assert.match(xml, /<LEDGERNAME>SGST<\/LEDGERNAME>/);
  assert.doesNotMatch(xml, /<LEDGERNAME>IGST<\/LEDGERNAME>/);
  assert.match(xml, /<DATE>20260924<\/DATE>/);
  assert.doesNotMatch(xml, /NaN/);
});

test("sales order XML: Optional flag can be turned off", () => {
  assert.doesNotMatch(build(salesOrder(), false), /ISOPTIONAL/);
});

test("sales order XML: totals that do not reconcile are refused", () => {
  assert.throws(() => build(salesOrder({ grandTotal: 1200 })), /do not reconcile/);
});

test("sales order XML: party and item names are XML-escaped", () => {
  const xml = build(salesOrder({ buyer: { ledgerGuid: null, ledgerName: "A & B <Traders>", gstin: null, state: "Kerala" } }));
  assert.match(xml, /A &amp; B &lt;Traders&gt;/);
});

test("cancel XML: targets the Sales Order by its REMOTEID — no voucher number or date needed", () => {
  const xml = build({
    type: "push_cancel_sales_order",
    remoteId: "excer-cancel-1",
    referencedSalesOrderRemoteId: "excer-so-1",
    cancellationDate: "2026-09-24",
    reason: "Customer changed mind",
  });
  assert.match(xml, /<VOUCHER REMOTEID="excer-so-1" VCHTYPE="Sales Order" ACTION="Cancel">/);
  // Voucher numbers are not unique for Optional vouchers (verified live), so never cancel by one.
  assert.doesNotMatch(xml, /TAGNAME|TAGVALUE/);
});

test("assertBalanced: a NaN amount is not 'balanced'", () => {
  assert.throws(() => assertBalanced([{ ledger: "X", amount: Number.NaN }]), /non-numeric/);
});

/* ── invoice layout, as verified against a live TallyPrime ───────────── */

/** The ledger names posted in one list of the rendered XML, in order. */
function ledgersIn(xml: string, list: string): string[] {
  // Split on the opening tag rather than build a regex from `list`, which contains a ".".
  return xml
    .split(`<${list}>`)
    .slice(1)
    .map((chunk) => /<LEDGERNAME>([^<]+)<\/LEDGERNAME>/.exec(chunk)?.[1] ?? "");
}

test("invoice layout: LEDGERENTRIES.LIST, and sales ONLY via the item allocations (no double count)", () => {
  const xml = build(salesOrder());
  assert.doesNotMatch(xml, /ALLLEDGERENTRIES\.LIST/);
  assert.deepEqual(ledgersIn(xml, "LEDGERENTRIES.LIST"), ["Acme Traders", "CGST", "SGST"]);
  assert.deepEqual(ledgersIn(xml, "ACCOUNTINGALLOCATIONS.LIST"), ["Sales Accounts"]);
});

test("discount: pre-discount lines get a Discount line; post-discount lines do not", () => {
  // Line 1000 (pre-discount), discount 100, taxable 900, tax 162, grand 1062.
  const pre = build(salesOrder({ subtotal: 1000, discountAmount: 100, taxableValue: 900, taxTotal: 162, grandTotal: 1062 }));
  assert.ok(ledgersIn(pre, "LEDGERENTRIES.LIST").includes("Discount Allowed"));
  // Same order, but the app already netted the discount into the line (900).
  const netLine = [{ itemName: "Cable 2.5mm", itemGuid: null, quantity: 10, unit: "Mtr", rate: 90, taxableValue: 900, gstRate: 18 }];
  const post = build(salesOrder({ lineItems: netLine, subtotal: 1000, discountAmount: 100, taxableValue: 900, taxTotal: 162, grandTotal: 1062 }));
  assert.ok(!ledgersIn(post, "LEDGERENTRIES.LIST").includes("Discount Allowed"));
});

test("credit note: returned goods are a DEBIT (goods come back in), party is a credit", () => {
  const xml = build({
    type: "push_credit_note", remoteId: "excer-cn-1", referencedRemoteId: "excer-so-1", returnDate: "2026-04-02",
    lineItems: [{ itemName: "Cable 2.5mm", itemGuid: null, quantity: 10, rate: 60, taxableValue: 600, gstRate: 18 }],
    totalCreditAmount: 708, reason: null, buyerLedgerName: "Acme Traders", buyerState: "Kerala",
  });
  const inv = xml.slice(xml.indexOf("<ALLINVENTORYENTRIES.LIST>"));
  assert.match(inv, /<ISDEEMEDPOSITIVE>Yes<\/ISDEEMEDPOSITIVE>/);
  assert.match(inv, /<AMOUNT>-600\.00<\/AMOUNT>/);
  // No unit sent -> bare quantity, so Tally uses the item's own unit (never a guessed "nos").
  assert.match(inv, /<ACTUALQTY>10<\/ACTUALQTY>/);
  assert.doesNotMatch(xml, / nos</i);
});

/* ── ledgers per GST rate (the client's books: one sales + tax set per rate) ── */

// Exactly as the client's company names them, odd spacing and all (verified 2026-09-26).
const CLIENT_RATES = "18=Sales@18%|CGST@9%|SGST@9%|IGST @18%; 12=Sales@12%|CGST @6%|SGST @6%|IGST 12%; 5=Sales@5%|CGST 2.5%|SGST 2.5%|IGST @ 5%";
const rated: TallyNames = { ...names, ledgersByRate: parseLedgersByRate(CLIENT_RATES) };

function buildRated(body: unknown): string {
  return buildVoucherXml(pushRequestSchema.parse(body) as PushRequest, rated, "Test Co", true);
}

/** [ledger, amount] pairs posted in one list of the rendered XML, in order. */
function postingsIn(xml: string, list: string): Array<[string, number]> {
  return xml
    .split(`<${list}>`)
    .slice(1)
    .map((chunk) => [
      /<LEDGERNAME>([^<]+)<\/LEDGERNAME>/.exec(chunk)?.[1] ?? "",
      Number(/<AMOUNT>([^<]+)<\/AMOUNT>/.exec(chunk)?.[1]),
    ]);
}

const line = (itemName: string, taxableValue: number, gstRate: number | null) => ({
  itemName, itemGuid: null, quantity: 1, unit: "Pcs", rate: taxableValue, taxableValue, gstRate,
});

test("ledgers by rate: parses the client's names exactly, spaces inside kept", () => {
  const map = parseLedgersByRate(CLIENT_RATES)!;
  assert.deepEqual(map["18"], { sales: "Sales@18%", cgst: "CGST@9%", sgst: "SGST@9%", igst: "IGST @18%" });
  assert.equal(map["5"].igst, "IGST @ 5%");
  assert.equal(parseLedgersByRate("  "), undefined);
  // A blank position keeps the single ledger of that kind.
  assert.deepEqual(parseLedgersByRate("18=Sales@18%|||")!["18"], { sales: "Sales@18%", cgst: undefined, sgst: undefined, igst: undefined });
  assert.throws(() => parseLedgersByRate("18=Sales@18%|CGST@9%"), /Invalid TALLY_LEDGERS_BY_RATE/);
  assert.throws(() => parseLedgersByRate("eighteen=a|b|c|d"), /Invalid TALLY_LEDGERS_BY_RATE/);
});

test("ledgers by rate: each Delivery Note line posts to its own rate's sales ledger", () => {
  const xml = buildRated({
    type: "push_delivery_note", remoteId: "dn-r", referencedSalesOrderRemoteId: "so-r", dispatchDate: "2026-09-01",
    lineItems: [line("Cable", 1000, 18), line("Pipe", 500, 5), line("Odd", 100, 28), line("Unknown", 100, null)],
    buyerLedgerName: "Acme Traders",
  });
  // 28% is not configured and one line has no rate: both fall back to the single sales ledger.
  assert.deepEqual(ledgersIn(xml, "ACCOUNTINGALLOCATIONS.LIST"), ["Sales@18%", "Sales@5%", "Sales Accounts", "Sales Accounts"]);
});

test("ledgers by rate: a mixed-rate Kerala order posts each rate's CGST/SGST, balanced to the paisa", () => {
  // 1000 @18% (tax 180) + 500 @5% (tax 25) = tax 205.
  const xml = buildRated(salesOrder({
    lineItems: [line("Cable", 1000, 18), line("Pipe", 500, 5)],
    subtotal: 1500, taxableValue: 1500, taxTotal: 205, grandTotal: 1705,
  }));
  assert.deepEqual(postingsIn(xml, "LEDGERENTRIES.LIST"), [
    ["Acme Traders", -1705], ["CGST 2.5%", 12.5], ["SGST 2.5%", 12.5], ["CGST@9%", 90], ["SGST@9%", 90],
  ]);
  assert.deepEqual(ledgersIn(xml, "ACCOUNTINGALLOCATIONS.LIST"), ["Sales@18%", "Sales@5%"]);
});

test("ledgers by rate: an order discount is shared across the rates, and it still balances", () => {
  // 10% off: taxable 900 @18% + 450 @5% -> tax 162 + 22.50 = 184.50; lines are pre-discount.
  const xml = buildRated(salesOrder({
    lineItems: [line("Cable", 1000, 18), line("Pipe", 500, 5)],
    subtotal: 1500, discountAmount: 150, taxableValue: 1350, taxTotal: 184.5, grandTotal: 1534.5,
  }));
  const posted = new Map(postingsIn(xml, "LEDGERENTRIES.LIST"));
  assert.equal(posted.get("CGST@9%"), 81);
  assert.equal(posted.get("CGST 2.5%"), 11.25);
  assert.equal(posted.get("Discount Allowed"), -150);
});

test("ledgers by rate: an out-of-state credit note reverses each rate's own IGST", () => {
  const xml = buildRated({
    type: "push_credit_note", remoteId: "cn-r", referencedRemoteId: "so-r", returnDate: "2026-09-01",
    lineItems: [
      { itemName: "Cable", itemGuid: null, quantity: 1, rate: 1000, taxableValue: 1000, gstRate: 18 },
      { itemName: "Pipe", itemGuid: null, quantity: 1, rate: 500, taxableValue: 500, gstRate: 12 },
    ],
    totalCreditAmount: 1740, reason: null, buyerLedgerName: "Acme Traders", buyerState: "Tamil Nadu",
  });
  assert.deepEqual(postingsIn(xml, "LEDGERENTRIES.LIST"), [["Acme Traders", 1740], ["IGST 12%", -60], ["IGST @18%", -180]]);
  assert.deepEqual(ledgersIn(xml, "ACCOUNTINGALLOCATIONS.LIST"), ["Sales@18%", "Sales@12%"]);
});

test("taxByRate: shares always add up to the tax total, even with an odd paisa", () => {
  const shares = taxByRate(100.01, [
    { taxableValue: 333.33, gstRate: 18 }, { taxableValue: 333.33, gstRate: 12 }, { taxableValue: 333.34, gstRate: 5 },
  ]);
  assert.equal(Math.round(shares.reduce((sum, s) => sum + s.tax, 0) * 100), 10001);
  assert.deepEqual(shares.map((s) => s.rate), [5, 12, 18]);
});

test("taxByRate: a taxed line with no GST rate is refused, not posted to a guessed ledger", () => {
  assert.throws(() => taxByRate(18, [{ taxableValue: 100, gstRate: null }]), /no GST rate/);
});

test("without ledgers by rate, everything posts to the single ledgers as before", () => {
  const xml = build(salesOrder({ lineItems: [line("Cable", 1000, 18), line("Pipe", 500, 5)], subtotal: 1500, taxableValue: 1500, taxTotal: 205, grandTotal: 1705 }));
  assert.deepEqual(postingsIn(xml, "LEDGERENTRIES.LIST"), [["Acme Traders", -1705], ["CGST", 102.5], ["SGST", 102.5]]);
});

/* ── Sales Order order numbers (the fix for "Bad Order Number in Voucher!") ── */

test("sales order XML: every line is filed under the order number, due on the order date", () => {
  const xml = build(salesOrder({ remoteId: "push_sales_order:1a2b3c4d-0000-4000-8000-000000000000" }));
  // As in the client's own Sales Orders: ORDERNO + ORDERDUEDATE in each batch allocation.
  const batch = xml.slice(xml.indexOf("<BATCHALLOCATIONS.LIST>"), xml.indexOf("</BATCHALLOCATIONS.LIST>"));
  assert.match(batch, /<ORDERNO>1A2B3C4D<\/ORDERNO>/);
  assert.match(batch, /<ORDERDUEDATE>20260924<\/ORDERDUEDATE>/);
  assert.match(xml, /<REFERENCE>1A2B3C4D<\/REFERENCE>/);
});

test("salesOrderNumber: the payload's own number wins; else the website's short order id", () => {
  assert.equal(salesOrderNumber({ orderNumber: " WEB-1042 ", remoteId: "push_sales_order:abc" }), "WEB-1042");
  assert.equal(salesOrderNumber({ orderNumber: null, remoteId: "push_sales_order:1a2b3c4d-e5f6" }), "1A2B3C4D");
  assert.equal(salesOrderNumber({ orderNumber: undefined, remoteId: "plain-id" }), "PLAIN-ID");
});

test("delivery note XML: no order number — it is not an order voucher", () => {
  const xml = build({
    type: "push_delivery_note", remoteId: "dn-1", referencedSalesOrderRemoteId: "so-1", dispatchDate: "2026-09-01",
    lineItems: [line("Cable", 1000, 18)], buyerLedgerName: "Acme Traders",
  });
  assert.doesNotMatch(xml, /ORDERNO|ORDERDUEDATE/);
});

test("cancel XML: never an empty <VOUCHER> — with no reason Tally refused it ('empty' object)", () => {
  const xml = build({
    type: "push_cancel_sales_order", remoteId: "c-2", referencedSalesOrderRemoteId: "so-2",
    cancellationDate: "2026-09-01", reason: null,
  });
  assert.match(xml, /<NARRATION>Cancelled on the Excer website<\/NARRATION>/);
});
