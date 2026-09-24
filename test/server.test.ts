import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createAgentServer, isAuthorized, looksLikeDuplicate } from "../src/server.js";
import { createPollState } from "../src/poll-loop.js";
import { parseImportResult } from "../src/tally/xml.js";
import { agentConfig, collection, collectionId, fakeClient } from "./helpers.js";

const created = `<RESPONSE><CREATED>1</CREATED><LASTVCHID>987</LASTVCHID></RESPONSE>`;
const voucherRow = `<VOUCHER><GUID>guid-abc</GUID><VOUCHERNUMBER>0012</VOUCHERNUMBER></VOUCHER>`;

const salesOrder = {
  type: "push_sales_order",
  remoteId: "excer-so-1",
  orderDate: "2026-09-24",
  buyer: { ledgerGuid: null, ledgerName: "Acme", gstin: null, state: "Kerala" },
  deliveryAddress: "Kochi",
  lineItems: [{ itemName: "X", itemGuid: null, quantity: 1, rate: 100, taxableValue: 100, gstRate: 18 }],
  subtotal: 100,
  discountAmount: 0,
  taxableValue: 100,
  taxTotal: 18,
  grandTotal: 118,
  notes: null,
};

/** Start the agent against a fake Tally; returns a fetch bound to it plus the recorded requests. */
async function startAgent(respond: (xml: string) => string) {
  const { client, requests } = fakeClient(respond);
  const poll = createPollState({ lastMasterAlterId: 5, lastVoucherAlterId: 7 });
  poll.tallyReachable = true;
  const server = createAgentServer(agentConfig(), client, poll);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const call = async (path: string, init: RequestInit = {}, key: string | null = "test-key") => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (key) headers["x-api-key"] = key;
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers });
    return { status: res.status, body: (await res.json()) as any };
  };
  const push = (body: unknown) => call("/api/import/voucher", { method: "POST", body: JSON.stringify(body) });
  return { call, push, requests, close: () => new Promise((r) => server.close(r)) };
}

test("push: new voucher is written, then read back for its REAL voucher number", async () => {
  let written = false;
  const agent = await startAgent((xml) => {
    if (collectionId(xml) === "Vouchers") {
      written = true;
      return created;
    }
    // The lookup finds nothing before the write, and the voucher after it.
    return collection(written ? voucherRow : "");
  });
  try {
    const { status, body } = await agent.push(salesOrder);
    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.equal(body.voucherNumber, "0012"); // not "987" (LASTVCHID), and leading zeros kept
    assert.equal(body.guid, "guid-abc");
  } finally {
    await agent.close();
  }
});

test("push: a voucher already in Tally is a duplicate and is NOT re-imported", async () => {
  const agent = await startAgent((xml) => {
    if (collectionId(xml) === "Vouchers") throw new Error("must not import");
    return collection(voucherRow);
  });
  try {
    const { status, body } = await agent.push(salesOrder);
    assert.equal(status, 200);
    assert.equal(body.duplicate, true);
    assert.equal(body.voucherNumber, "0012");
    assert.ok(agent.requests.every((x) => collectionId(x) !== "Vouchers"));
  } finally {
    await agent.close();
  }
});

test("push: a new ledger whose name belongs to a DIFFERENT customer is a 409, not success", async () => {
  const agent = await startAgent(() =>
    collection(`<LEDGER><GUID>g1</GUID><REMOTEALTGUID>someone-else</REMOTEALTGUID></LEDGER>`)
  );
  try {
    const { status } = await agent.push({
      type: "push_new_ledger",
      remoteId: "excer-cust-1",
      customerName: "Acme",
      gstin: null,
      address: null,
      state: "Kerala",
      phone: null,
    });
    assert.equal(status, 409);
  } finally {
    await agent.close();
  }
});

test("push: invalid payload is a 400 and Tally is never contacted", async () => {
  const agent = await startAgent(() => {
    throw new Error("must not reach Tally");
  });
  try {
    const { grandTotal, ...broken } = salesOrder;
    const { status, body } = await agent.push(broken);
    assert.equal(status, 400);
    assert.ok(body.issues.some((i: string) => i.startsWith("grandTotal")));
    assert.equal(agent.requests.length, 0);
  } finally {
    await agent.close();
  }
});

test("health: public view is minimal; details need the key; neither queries Tally", async () => {
  const agent = await startAgent(() => {
    throw new Error("health must not query Tally");
  });
  try {
    const anon = await agent.call("/health", {}, null);
    assert.deepEqual(anon.body, { ok: true, agentId: "test-agent", tallyReachable: true });
    const full = await agent.call("/health");
    assert.equal(full.body.company, "Test Co");
    assert.equal(full.body.lastVoucherAlterId, 7);
    assert.equal(agent.requests.length, 0);
  } finally {
    await agent.close();
  }
});

test("auth: wrong or missing key is 401", async () => {
  const agent = await startAgent(() => collection(""));
  try {
    assert.equal((await agent.call("/api/export/masters", {}, "nope")).status, 401);
    assert.equal((await agent.call("/api/export/masters", {}, null)).status, 401);
  } finally {
    await agent.close();
  }
});

test("isAuthorized: exact match only", () => {
  assert.equal(isAuthorized("k", "k"), true);
  assert.equal(isAuthorized("k ", "k"), false);
  assert.equal(isAuthorized(["k"], "k"), false);
  assert.equal(isAuthorized(undefined, "k"), false);
});

test("looksLikeDuplicate: ignored-only is a duplicate; 'already exists' is not", () => {
  assert.equal(looksLikeDuplicate(parseImportResult("<RESPONSE><IGNORED>1</IGNORED></RESPONSE>")), true);
  assert.equal(
    looksLikeDuplicate(parseImportResult("<RESPONSE><ERRORS>1</ERRORS></RESPONSE><LINEERROR>Ledger 'Acme' already exists</LINEERROR>")),
    false
  );
  assert.equal(looksLikeDuplicate(parseImportResult("<RESPONSE><CREATED>1</CREATED></RESPONSE>")), false);
});
