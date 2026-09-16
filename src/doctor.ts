// `npm run doctor` — the day-one validation pass.
//
// This exists because the single biggest unknown in this project is not our code, it is whether
// THIS client's Tally answers the way the documentation says it should. Run this on the office
// machine before writing or trusting anything else. It makes no writes.
//
// Every check prints what it proves, so a failure tells you which assumption was wrong.

import { TallyClient } from "./tally/client.js";
import { getLastAlterIds, fetchLedgers, fetchStockItems } from "./excer/masters.js";

function ok(label: string, detail = "") {
  console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ""}`);
}
function fail(label: string, err: unknown) {
  console.log(`  FAIL  ${label}`);
  console.log(`        ${err instanceof Error ? err.message : String(err)}`);
}

async function main() {
  const client = new TallyClient();
  console.log(`\nChecking Tally at ${client.config.url}`);
  console.log(`Company: ${client.config.defaultCompany ?? "(active company)"}\n`);

  let reachable = false;

  // 1. Is anything listening, and is it Tally?
  try {
    const ids = await getLastAlterIds(client, client.config.defaultCompany);
    reachable = true;
    if (ids.masters === 0 && ids.vouchers === 0) {
      console.log("  WARN  AlterID counters both returned 0.");
      console.log("        Either the company is empty, or the ALTMSTID/ALTVCHID field names");
      console.log("        differ on this Tally build. Incremental sync depends on these —");
      console.log("        inspect the raw XML before relying on the poll loop.");
    } else {
      ok("Tally reachable, AlterID counters readable", `masters=${ids.masters} vouchers=${ids.vouchers}`);
    }
  } catch (err) {
    fail("Tally reachable", err);
    console.log("\nStopping — nothing else can be checked until Tally answers.\n");
    process.exit(1);
  }

  // 2. Can we read stock items, and do the fields we need come back populated?
  try {
    const items = await fetchStockItems(client, 0, client.config.defaultCompany);
    ok("Stock items readable", `${items.length} item(s)`);
    const sample = items[0];
    if (!sample) {
      console.log("        (no stock items in this company — add one to verify field mapping)");
    } else {
      console.log(`        sample: ${JSON.stringify(sample, null, 2).replace(/\n/g, "\n        ")}`);
      if (!sample.guid) console.log("  WARN  GUID empty — tallyGuid linking will not work.");
      if (!sample.alterId) console.log("  WARN  AlterID empty — incremental sync will not work.");
      if (sample.baseRate === 0) console.log("  WARN  baseRate 0 — check the OpeningRate field name.");
      if (!sample.hsnCode) console.log("  NOTE  hsnCode empty — may live on the stock GROUP here.");
    }
  } catch (err) {
    fail("Stock items readable", err);
  }

  // 3. Can we read customer ledgers, filtered to the right group?
  try {
    const group = process.env.TALLY_GROUP_CUSTOMERS?.trim() || "Sundry Debtors";
    const ledgers = await fetchLedgers(client, 0, client.config.defaultCompany, group);
    ok(`Customer ledgers readable (group "${group}")`, `${ledgers.length} ledger(s)`);
    const sample = ledgers[0];
    if (sample) {
      console.log(`        sample: ${JSON.stringify(sample, null, 2).replace(/\n/g, "\n        ")}`);
      if (!sample.guid) console.log("  WARN  GUID empty — tallyGuid linking will not work.");
    } else {
      console.log(`        (no ledgers under "${group}" — is that the right group name here?)`);
    }
  } catch (err) {
    fail("Customer ledgers readable", err);
  }

  console.log("\nRead path checked. Writes are NOT tested here on purpose —");
  console.log("post your first voucher manually into a TEST company, never the live one.\n");
  process.exit(reachable ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
