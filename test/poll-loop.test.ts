import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPollState, pollOnce } from "../src/poll-loop.js";
import { loadWatermarks, saveWatermarks } from "../src/state-store.js";
import { agentConfig, collection, collectionId, counters, fakeClient, stockItem } from "./helpers.js";

let dir: string;
let posted: any[];
const realFetch = globalThis.fetch;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "excer-agent-"));
  posted = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    posted.push(JSON.parse(String(init.body)));
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  rmSync(dir, { recursive: true, force: true });
});

/** A fake Tally with fixed counters; records whether the stock fetch was full or filtered. */
function tally(masters: number, vouchers: number) {
  return fakeClient((xml) => {
    switch (collectionId(xml)) {
      case "ExcerAlterIds":
        return counters(masters, vouchers);
      case "ExcerStockItems":
        return collection(stockItem("item-1", 3, 42));
      default:
        return collection("");
    }
  });
}

const isFullStockFetch = (xml: string) =>
  collectionId(xml) === "ExcerStockItems" && !xml.includes("ExcerSinceAlter");

test("nothing moved: only the counter is read", async () => {
  const { client, requests } = tally(10, 20);
  const state = createPollState({ lastMasterAlterId: 10, lastVoucherAlterId: 20 });
  assert.equal(await pollOnce(agentConfig({ stateFile: join(dir, "s.json") }), client, state), false);
  assert.equal(requests.length, 1);
  assert.equal(state.tallyReachable, true);
});

test("voucher counter moved: stock balances are re-read in FULL (item AlterIDs do not move)", async () => {
  const { client, requests } = tally(10, 21);
  const state = createPollState({ lastMasterAlterId: 10, lastVoucherAlterId: 20 });
  assert.equal(await pollOnce(agentConfig({ stateFile: join(dir, "s.json") }), client, state), true);
  assert.ok(requests.some(isFullStockFetch));
  assert.equal(posted[0].stockItems[0].closingStockQty, 42);
  assert.equal(state.lastVoucherAlterId, 21);
});

test("voucher refresh is rate-limited, and a skipped change is not lost", async () => {
  const { client, requests } = tally(10, 21);
  const state = createPollState({ lastMasterAlterId: 10, lastVoucherAlterId: 20 });
  state.lastStockRefreshAt = Date.now(); // just refreshed
  assert.equal(await pollOnce(agentConfig({ stateFile: join(dir, "s.json") }), client, state), false);
  assert.equal(requests.length, 1);
  assert.equal(state.lastVoucherAlterId, 20); // still pending for a later tick
});

test("counter went backwards (restored backup): full re-sync instead of stalling forever", async () => {
  const { client, requests } = tally(5, 8);
  const state = createPollState({ lastMasterAlterId: 900, lastVoucherAlterId: 800 });
  await pollOnce(agentConfig({ stateFile: join(dir, "s.json") }), client, state);
  assert.ok(requests.some(isFullStockFetch));
  assert.equal(state.lastMasterAlterId, 5);
  assert.equal(state.lastVoucherAlterId, 8);
});

test("both counters 0: refuses to poll rather than full-export every tick", async () => {
  const { client, requests } = tally(0, 0);
  const state = createPollState({ lastMasterAlterId: 0, lastVoucherAlterId: 0 });
  await assert.rejects(pollOnce(agentConfig({ stateFile: join(dir, "s.json") }), client, state), /both read 0/);
  assert.equal(requests.length, 1);
});

test("company not open (Tally at its login screen): unreachable, with a plain reason — not a field-name hint", async () => {
  // Verified live: at the login screen Tally lists no open company, so every query answers empty.
  const { client } = fakeClient(() => collection(""));
  const state = createPollState({ lastMasterAlterId: 5, lastVoucherAlterId: 7 });
  await assert.rejects(pollOnce(agentConfig({ stateFile: join(dir, "s.json") }), client, state), /is not open/);
  assert.equal(state.tallyReachable, false);
  assert.equal(state.lastMasterAlterId, 5); // nothing skipped: sync resumes where it left off
});

test("several companies open: the counters are the configured company's, not the first row's", async () => {
  const { client } = fakeClient((xml) =>
    collectionId(xml) === "ExcerAlterIds"
      ? collection(
          `<COMPANY NAME="Other Co"><ALTMSTID>999</ALTMSTID><ALTVCHID>999</ALTVCHID></COMPANY>` +
            `<COMPANY NAME="Test Co"><ALTMSTID>5</ALTMSTID><ALTVCHID>7</ALTVCHID></COMPANY>`
        )
      : collection("")
  );
  const state = createPollState({ lastMasterAlterId: 5, lastVoucherAlterId: 7 });
  assert.equal(await pollOnce(agentConfig({ stateFile: join(dir, "s.json") }), client, state), false); // unchanged
  assert.equal(state.tallyReachable, true);
});

test("configured company closed while another is open: not open, not the other company's counters", async () => {
  const { client } = fakeClient(() =>
    collection(`<COMPANY NAME="Other Co"><ALTMSTID>999</ALTMSTID><ALTVCHID>999</ALTVCHID></COMPANY>`)
  );
  const state = createPollState({ lastMasterAlterId: 5, lastVoucherAlterId: 7 });
  await assert.rejects(pollOnce(agentConfig({ stateFile: join(dir, "s.json") }), client, state), /"Test Co" is not open/);
});

test("no app URL: watermarks do not advance, so nothing is skipped later", async () => {
  const { client } = tally(10, 21);
  const state = createPollState({ lastMasterAlterId: 1, lastVoucherAlterId: 1 });
  await pollOnce(agentConfig({ appBaseUrl: undefined, stateFile: join(dir, "s.json") }), client, state);
  assert.equal(state.lastMasterAlterId, 1);
  assert.equal(state.lastVoucherAlterId, 1);
});

test("app rejects the batch: watermarks do not advance (at-least-once)", async () => {
  globalThis.fetch = (async () => new Response("", { status: 500 })) as typeof fetch;
  const { client } = tally(10, 21);
  const state = createPollState({ lastMasterAlterId: 10, lastVoucherAlterId: 20 });
  await assert.rejects(pollOnce(agentConfig({ stateFile: join(dir, "s.json") }), client, state), /HTTP 500/);
  assert.equal(state.lastVoucherAlterId, 20);
});

test("watermarks survive a restart, and are discarded for a different company", async () => {
  const file = join(dir, "state", "poll.json");
  const { client } = tally(10, 21);
  const state = createPollState({ lastMasterAlterId: 0, lastVoucherAlterId: 0 });
  await pollOnce(agentConfig({ stateFile: file }), client, state);
  assert.deepEqual(loadWatermarks(file, "Test Co"), { lastMasterAlterId: 10, lastVoucherAlterId: 21 });
  assert.deepEqual(loadWatermarks(file, "Other Co"), { lastMasterAlterId: 0, lastVoucherAlterId: 0 });
  assert.deepEqual(loadWatermarks(join(dir, "missing.json"), null), { lastMasterAlterId: 0, lastVoucherAlterId: 0 });
  saveWatermarks(file, null, { lastMasterAlterId: 1, lastVoucherAlterId: 2 });
  assert.deepEqual(loadWatermarks(file, null), { lastMasterAlterId: 1, lastVoucherAlterId: 2 });
});
