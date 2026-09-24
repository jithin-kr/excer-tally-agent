import { test } from "node:test";
import assert from "node:assert/strict";
import { buildVoucherXml, splitGst } from "../src/excer/vouchers.js";
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
  assert.match(xml, /<REMOTEID>excer-so-1<\/REMOTEID>/);
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
  assert.throws(() => build(salesOrder({ grandTotal: 1200 })), /do not balance/);
});

test("sales order XML: party and item names are XML-escaped", () => {
  const xml = build(salesOrder({ buyer: { ledgerGuid: null, ledgerName: "A & B <Traders>", gstin: null, state: "Kerala" } }));
  assert.match(xml, /A &amp; B &lt;Traders&gt;/);
});

test("cancel XML: refuses without a voucher number", () => {
  const cancel = {
    type: "push_cancel_sales_order",
    remoteId: "excer-cancel-1",
    referencedSalesOrderRemoteId: "excer-so-1",
    cancellationDate: "2026-09-24",
    reason: null,
  };
  assert.throws(() => build(cancel), /salesOrderVoucherNumber is missing/);
  assert.match(build({ ...cancel, salesOrderVoucherNumber: "0012" }), /TAGVALUE="0012"/);
});

test("assertBalanced: a NaN amount is not 'balanced'", () => {
  assert.throws(() => assertBalanced([{ ledger: "X", amount: Number.NaN }]), /non-numeric/);
});
