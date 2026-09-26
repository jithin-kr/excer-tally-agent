import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createAgentServer, isAuthorized, looksLikeDuplicate } from "../src/server.js";
import { createPollState } from "../src/poll-loop.js";
import { parseImportResult } from "../src/tally/xml.js";
import { agentConfig, collection, collectionId, fakeClient } from "./helpers.js";

/** Wrap import counts the way real TallyPrime does: <ENVELOPE><BODY><DATA><IMPORTRESULT>. */
const importResult = (inner: string) =>
  `<ENVELOPE><HEADER><VERSION>1</VERSION><STATUS>1</STATUS></HEADER><BODY><DATA><IMPORTRESULT>${inner}</IMPORTRESULT></DATA></BODY></ENVELOPE>`;
const created = importResult(`<CREATED>1</CREATED><LASTVCHID>987</LASTVCHID>`);
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
async function startAgent(respond: (xml: string) => string | Promise<string>) {
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
  return { address: server.address(), call, push, requests, close: () => new Promise((r) => server.close(r)) };
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
    assert.equal(body.tallyResult.created, 1);
    assert.equal(body.tallyResult.raw, undefined); // counts only, not Tally's whole XML reply
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

test("parseImportResult reads real TallyPrime's <IMPORTRESULT> counts", () => {
  const r = parseImportResult(importResult("<CREATED>11</CREATED><ERRORS>2</ERRORS><IGNORED>1</IGNORED>"));
  assert.deepEqual([r.created, r.errors, r.ignored], [11, 2, 1]);
});

test("looksLikeDuplicate: ignored-only is a duplicate; 'already exists' is not", () => {
  assert.equal(looksLikeDuplicate(parseImportResult(importResult("<IGNORED>1</IGNORED>"))), true);
  assert.equal(
    looksLikeDuplicate(parseImportResult(`<ENVELOPE><BODY><DATA><LINEERROR>Ledger 'Acme' already exists</LINEERROR><IMPORTRESULT><ERRORS>1</ERRORS></IMPORTRESULT></DATA></BODY></ENVELOPE>`)),
    false
  );
  assert.equal(looksLikeDuplicate(parseImportResult(importResult("<CREATED>1</CREATED>"))), false);
});

test("a malformed request URL gets a 400 and the agent keeps running", async () => {
  const { createConnection } = await import("node:net");
  const agent = await startAgent(() => collection(""));
  try {
    const raw = await new Promise<string>((resolve, reject) => {
      const address = agent.address as AddressInfo;
      const sock = createConnection(address.port, "127.0.0.1", () => {
        sock.write("GET http://[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
      });
      let out = "";
      sock.on("data", (d) => (out += d));
      sock.on("end", () => resolve(out));
      sock.on("error", reject);
    });
    assert.match(raw, /^HTTP\/1\.1 400/);
    assert.equal((await agent.call("/health", {}, null)).status, 200); // still alive
  } finally {
    await agent.close();
  }
});

test("two simultaneous pushes of the same order import it ONCE", async () => {
  let imports = 0;
  // Tally takes a moment to answer, so the second push arrives while the first is mid-flight.
  // Each answer reflects Tally's state when the request ARRIVES, then takes a moment to return —
  // like real Tally, which answers queued requests in order.
  const slow = <T>(v: T) => new Promise<T>((r) => setTimeout(() => r(v), 40));
  const agent = await startAgent((xml) => {
    if (collectionId(xml) === "Vouchers") {
      imports += 1;
      return slow(created);
    }
    return slow(collection(imports > 0 ? voucherRow : ""));
  });
  try {
    const [a, b] = await Promise.all([agent.push(salesOrder), agent.push(salesOrder)]);
    assert.equal(imports, 1);
    assert.equal(a.body.success && b.body.success, true);
    assert.equal([a.body.duplicate, b.body.duplicate].filter(Boolean).length, 1);
  } finally {
    await agent.close();
  }
});

const cancelOrder = {
  type: "push_cancel_sales_order",
  remoteId: "excer-cancel-1",
  referencedSalesOrderRemoteId: "excer-so-1",
  cancellationDate: "2026-09-24",
  reason: null,
};
const cancelledRow = `<VOUCHER><GUID>guid-abc</GUID><VOUCHERNUMBER>0012</VOUCHERNUMBER><ISCANCELLED>Yes</ISCANCELLED></VOUCHER>`;

test("cancel: a live order is cancelled by its REMOTEID (live Tally answers ALTERED 1)", async () => {
  const agent = await startAgent((xml) =>
    collectionId(xml) === "Vouchers" ? importResult(`<ALTERED>1</ALTERED>`) : collection(voucherRow)
  );
  try {
    const { status, body } = await agent.push(cancelOrder);
    assert.equal(status, 200);
    assert.equal(body.success, true);
    const cancelXml = agent.requests.find((x) => collectionId(x) === "Vouchers") ?? "";
    assert.match(cancelXml, /REMOTEID="excer-so-1"[^>]*ACTION="Cancel"/);
  } finally {
    await agent.close();
  }
});

test("cancel: looks the order up on its own day first — a whole-year scan took 12-20s on real books", async () => {
  const lookups: string[] = [];
  const agent = await startAgent((xml) => {
    if (collectionId(xml) === "Vouchers") return importResult(`<ALTERED>1</ALTERED>`);
    lookups.push(/<SVFROMDATE[^>]*>(\d+)</.exec(xml)?.[1] ?? "whole year");
    return collection(voucherRow);
  });
  try {
    const { status } = await agent.push({ ...cancelOrder, salesOrderDate: "2026-09-01" });
    assert.equal(status, 200);
    assert.deepEqual(lookups, ["20260901"]); // found on the day: no whole-year scan
  } finally {
    await agent.close();
  }
});

test("cancel: an order not found on the given day is still found by the whole-year search", async () => {
  const lookups: string[] = [];
  const agent = await startAgent((xml) => {
    if (collectionId(xml) === "Vouchers") return importResult(`<ALTERED>1</ALTERED>`);
    const day = /<SVFROMDATE[^>]*>(\d+)</.exec(xml)?.[1];
    lookups.push(day ?? "whole year");
    return collection(day ? "" : voucherRow); // the date was wrong; the order exists
  });
  try {
    const { status, body } = await agent.push({ ...cancelOrder, salesOrderDate: "2026-09-02" });
    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.deepEqual(lookups, ["20260902", "whole year"]);
  } finally {
    await agent.close();
  }
});

test("cancel: an order not in Tally is a clear 422, and nothing is sent", async () => {
  const agent = await startAgent((xml) => {
    if (collectionId(xml) === "Vouchers") throw new Error("must not send a cancel");
    return collection("");
  });
  try {
    const { status, body } = await agent.push(cancelOrder);
    assert.equal(status, 422);
    assert.match(body.error, /No Sales Order with REMOTEID "excer-so-1"/);
  } finally {
    await agent.close();
  }
});

test("cancel: an already-cancelled order makes a retried cancel a duplicate, not a second write", async () => {
  const agent = await startAgent((xml) => {
    if (collectionId(xml) === "Vouchers") throw new Error("must not re-cancel");
    return collection(cancelledRow);
  });
  try {
    const { status, body } = await agent.push(cancelOrder);
    assert.equal(status, 200);
    assert.equal(body.duplicate, true);
  } finally {
    await agent.close();
  }
});

test("real TallyPrime rejection (LINEERROR inside IMPORTRESULT, counted as EXCEPTIONS) is a 422", async () => {
  // Verbatim shape of a live TallyPrime Edit Log response, 2026-09-24.
  const rejected = importResult(
    `<LINEERROR>Bad Order Number in Voucher!</LINEERROR><CREATED>0</CREATED><ERRORS>0</ERRORS><EXCEPTIONS>1</EXCEPTIONS>`
  );
  const agent = await startAgent((xml) => (collectionId(xml) === "Vouchers" ? rejected : collection("")));
  try {
    const { status, body } = await agent.push(salesOrder);
    assert.equal(status, 422);
    assert.equal(body.success, false);
    assert.match(body.error, /Bad Order Number/);
  } finally {
    await agent.close();
  }
});

test("an all-zero import result with no error is NOT reported as posted", async () => {
  const agent = await startAgent((xml) =>
    collectionId(xml) === "Vouchers" ? importResult("<CREATED>0</CREATED>") : collection("")
  );
  try {
    const { status, body } = await agent.push(salesOrder);
    assert.equal(status, 422);
    assert.match(body.error, /wrote nothing/);
  } finally {
    await agent.close();
  }
});
