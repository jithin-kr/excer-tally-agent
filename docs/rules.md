# Coding Rules

These are the rules for changing this codebase. Each one exists because breaking it caused, or
would cause, a real defect in someone's accounting books; the reason is given so the rule is not
"simplified" away. Most were learned against a live TallyPrime (see [memory.md](memory.md) §6).

**CI enforces:** typecheck, build, `npm test`, a boot smoke test, and `npm audit` at high. A red
build does not merge.

---

## 1. Boundaries

1. **`src/tally/` stays generic** — XML envelopes, rendering, parsing. Anything that knows about
   Excer's payloads, ledgers or GST lives in `src/excer/`.
2. **Every installation-specific Tally name comes from config** (`excer/config.ts`). Never
   hard-code a voucher type, ledger or group name.
3. **The wire contract is `excer/contract.ts`.** Types are inferred from the zod schemas; change the
   schema, not a hand-written interface. A change here needs the matching change in the website's
   `features/tally/mapping.ts`.

## 2. Writing to Tally

4. **Validate every request with zod before building XML.** A cast checks nothing: a missing
   `grandTotal` once became `<AMOUNT>NaN</AMOUNT>`.
5. **`REMOTEID` is an attribute of `<VOUCHER>`.** As a child element Tally drops it.
6. **Look up before you write.** A re-import with a known REMOTEID *alters* the voucher, which
   would overwrite an accountant's edits. Duplicate = success, nothing written.
7. **Success means Tally says it wrote something** (created / altered / combined / cancelled > 0)
   and reported no `EXCEPTIONS`, `ERRORS` or `LINEERROR`. Never infer success from "no error".
8. **Never identify a voucher by its number.** Optional vouchers share numbers. Use REMOTEID or GUID.
9. **Balance the whole voucher** — ledger lines *and* item allocations (`assertVoucherBalanced`).
   Checking only ledger lines let a double-counted sale through.
10. **Invoice layout:** `LEDGERENTRIES.LIST`, sales only through item allocations, goods out =
    credit, goods in = debit.
11. **Units are Tally's own names or absent.** Never pass the website's "m"/"pcs"; never default
    to "nos".
12. **Refuse rather than guess** anything that lands in the books: unknown state for the GST
    split, totals that don't reconcile, a missing party ledger. Throw with a message that says
    what to fix.

## 3. Reading from Tally

13. **Unknown is `null`, never `0`.** A 0% GST rate or ₹0 price means something; "not set" must
    not look like it.
14. **Read TallyPrime 3+ dated lists** (`LEDMAILINGDETAILS`, `LEDGSTREGDETAILS`, `GSTDETAILS`,
    `HSNDETAILS`, `STANDARDPRICELIST`), taking the latest entry, with the flat field as fallback.
15. **Don't trust computed methods for data** (`$StandardPrice`, `$StandardCost`): they fall back
    to other values silently.
16. **Identifiers are strings.** Use `parseTallyXmlAsStrings` so "0012" stays "0012"; unwrap typed
    values with `s()` / `n()`.
17. **Customer group filter uses `$$IsBelongsTo`**, not `$Parent =`, so sub-groups are included.

## 4. Load on Tally and robustness

18. **All Tally traffic goes through `TallyClient`** (one request at a time). Don't open a second
    client or call `fetch` to port 9000 directly.
19. **`/health` and the heartbeat never query Tally**; they report poll state.
20. **Never advance a watermark before the website accepts the batch.** At-least-once is safe
    (the website upserts); skipping is not.
21. **Every async entry point catches its own errors**: request handler, timers, poll, heartbeat.
    One bad request must not stop the service.
22. **Every outbound call has a timeout.**
23. **Don't `process.exit()` with sockets open**; set `process.exitCode` and close the undici
    dispatcher.

## 5. Testing

24. **Test against real Tally shapes.** When a live response surprises you, paste its structure
    into a test (`test/*.test.ts` has several, marked "verbatim").
25. **Check a new test fails without the fix** before relying on it.
26. **Before trusting a change to a voucher layout, run it against a Tally test company**, read
    the voucher back, and check its postings. Never test in a live company.

## 6. Documentation

27. **Mark what is verified.** The README's "Verified against a live TallyPrime" section is the
    record; move an item there only after it passed against a real Tally.
28. **Keep these docs and the website's CLAUDE.md §39 in step** when the contract changes.
