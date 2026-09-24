import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { TallyClient } from "../src/tally/client.js";

test("TallyClient never has two requests in flight, and one failure does not block the next", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  let calls = 0;
  const server = createServer((req, res) => {
    calls += 1;
    const fail = calls === 2;
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    req.resume();
    setTimeout(() => {
      inFlight -= 1;
      res.writeHead(fail ? 500 : 200);
      res.end("<ENVELOPE></ENVELOPE>");
    }, 30);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const client = new TallyClient({ host: "127.0.0.1", port, url: `http://127.0.0.1:${port}`, timeoutMs: 2000 });
  try {
    const results = await Promise.allSettled([client.send("<a/>"), client.send("<b/>"), client.send("<c/>")]);
    assert.equal(maxInFlight, 1);
    assert.deepEqual(results.map((r) => r.status), ["fulfilled", "rejected", "fulfilled"]);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
