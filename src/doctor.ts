// `npm run doctor` — the day-one validation pass.
//
// This exists because the single biggest unknown in this project is not our code, it is whether
// THIS client's Tally answers the way the documentation says it should. Run this on the office
// machine before writing or trusting anything else. It makes no writes.
//
// Every check prints what it proves, so a failure tells you which assumption was wrong.

import { TallyClient } from "./tally/client.js";
import { getLastAlterIds, fetchLedgers, fetchMasterNames, fetchStockItems } from "./excer/masters.js";
import { loadTallyNames, type TallyNames } from "./excer/config.js";
import { findLedgerByName, findVoucherByRemoteId } from "./excer/lookup.js";
import { getGlobalDispatcher } from "undici";

/**
 * End the run with an exit code WITHOUT process.exit(): exiting while undici still holds
 * keep-alive sockets to Tally trips a libuv assertion on Windows ("UV_HANDLE_CLOSING"), which
 * replaced our exit code with 127 — and the installer decides what to do from that code.
 */
async function finish(code: number): Promise<void> {
  process.exitCode = code;
  await getGlobalDispatcher().close().catch(() => undefined);
}

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
  let countersOk = true;

  // 1. Is anything listening, and is it Tally?
  try {
    const ids = await getLastAlterIds(client, client.config.defaultCompany);
    reachable = true;
    if (!ids.companyOpen) {
      console.log(`  FAIL  Tally answers, but the company "${client.config.defaultCompany ?? "(active)"}" is not open.`);
      console.log("        Open it in Tally (log in if it asks), then run this again. Check TALLY_COMPANY");
      console.log("        matches the name shown in Tally exactly.");
      return finish(1);
    }
    if (ids.masters === 0 && ids.vouchers === 0) {
      // A FAIL, not a warning: the poll loop refuses to run with zero counters (otherwise it
      // would do a full export every 15s), so the agent cannot sync until this is fixed.
      countersOk = false;
      console.log("  FAIL  AlterID counters both returned 0.");
      console.log("        Either the company is empty, or the ALTMSTID/ALTVCHID field names");
      console.log("        differ on this Tally build. The poll loop will not run until this");
      console.log("        is fixed — inspect the raw XML and adjust getLastAlterIds().");
    } else {
      ok("Tally reachable, AlterID counters readable", `masters=${ids.masters} vouchers=${ids.vouchers}`);
    }
  } catch (err) {
    fail("Tally reachable", err);
    console.log("\nStopping — nothing else can be checked until Tally answers.\n");
    return finish(1);
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
      if (sample.baseRate === null) {
        console.log("  NOTE  no standard selling price on this item — its website base price won't sync.");
      }
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

  // 4. Do the idempotency / read-back lookups run? (Read-only: an id that cannot exist.)
  //    Proves the queries are accepted; whether they FIND a real voucher is only provable by the
  //    first push into a test company — its log line must show a vch= number, not "?".
  try {
    const probe = await findVoucherByRemoteId(
      client,
      "excer-doctor-probe-does-not-exist",
      new Date().toISOString().slice(0, 10),
      client.config.defaultCompany
    );
    if (probe) console.log("  WARN  Voucher lookup matched a probe id — the $RemoteID filter is being ignored.");
    else ok("Voucher lookup by REMOTEID accepted");
  } catch (err) {
    fail("Voucher lookup by REMOTEID", err);
  }
  try {
    const probe = await findLedgerByName(client, "excer-doctor-probe-does-not-exist", client.config.defaultCompany);
    if (probe) console.log("  WARN  Ledger lookup matched a probe name — the $Name filter is being ignored.");
    else ok("Ledger lookup by name accepted");
  } catch (err) {
    fail("Ledger lookup by name", err);
  }

  // 5. Does every name in .env exist in THIS company? A wrong one fails every voucher that uses
  //    it ("Ledger 'Sales Accounts' does not exist!": a group name, found on the client's books).
  let namesOk = true;
  try {
    const missing = await missingTallyNames(client, loadTallyNames());
    if (missing.length === 0) ok("Configured Tally names exist (voucher types, ledgers, group, godown)");
    else {
      namesOk = false;
      console.log("  FAIL  Configured Tally names missing in this company:");
      for (const m of missing) console.log(`        ${m}`);
      console.log(
        "        Fix them in .env (TALLY_VT_*, TALLY_LEDGER_*, TALLY_LEDGERS_BY_RATE, TALLY_GROUP_CUSTOMERS, TALLY_GODOWN)."
      );
    }
  } catch (err) {
    namesOk = false;
    fail("Configured Tally names exist", err);
  }

  console.log("\nRead path checked. Writes are NOT tested here on purpose —");
  console.log("post your first voucher manually into a TEST company, never the live one.\n");
  await finish(reachable && countersOk && namesOk ? 0 : 1);
}

/** Each configured name that this company does not have, as `SETTING (kind): "name"` lines. */
async function missingTallyNames(client: TallyClient, names: TallyNames): Promise<string[]> {
  const company = client.config.defaultCompany;
  // One after another: Tally serves one request at a time anyway (TallyClient queues them).
  const voucherTypes = await fetchMasterNames(client, "VoucherType", company);
  const ledgers = await fetchMasterNames(client, "Ledger", company);
  const groups = await fetchMasterNames(client, "Group", company);
  const godowns = names.godown ? await fetchMasterNames(client, "Godown", company) : new Set<string>();

  const want: Array<[setting: string, name: string | undefined, have: Set<string>]> = [
    ["TALLY_VT_SALES_ORDER (voucher type)", names.salesOrderVoucherType, voucherTypes],
    ["TALLY_VT_DELIVERY_NOTE (voucher type)", names.deliveryNoteVoucherType, voucherTypes],
    ["TALLY_VT_CREDIT_NOTE (voucher type)", names.creditNoteVoucherType, voucherTypes],
    ["TALLY_VT_STOCK_JOURNAL (voucher type)", names.stockJournalVoucherType, voucherTypes],
    ["TALLY_LEDGER_SALES (ledger)", names.salesLedger, ledgers],
    ["TALLY_LEDGER_CGST (ledger)", names.cgstLedger, ledgers],
    ["TALLY_LEDGER_SGST (ledger)", names.sgstLedger, ledgers],
    ["TALLY_LEDGER_IGST (ledger)", names.igstLedger, ledgers],
    ["TALLY_LEDGER_DISCOUNT (ledger)", names.discountLedger, ledgers],
    ["TALLY_GROUP_CUSTOMERS (group)", names.customerParentGroup, groups],
    ["TALLY_GODOWN (godown)", names.godown, godowns],
  ];
  for (const [rate, l] of Object.entries(names.ledgersByRate ?? {})) {
    for (const kind of ["sales", "cgst", "sgst", "igst"] as const) {
      want.push([`TALLY_LEDGERS_BY_RATE ${rate}% ${kind} (ledger)`, l[kind], ledgers]);
    }
  }
  return want
    .filter(([, name, have]) => name !== undefined && !have.has(name))
    .map(([setting, name]) => {
      // The mistake that failed every voucher on the client's books: a group named as a ledger.
      const hint = setting.endsWith("(ledger)") && groups.has(name!) ? " (that is a group, not a ledger)" : "";
      return `${setting}: "${name}"${hint}`;
    });
}

main().catch(async (err) => {
  console.error(err);
  await finish(1);
});
