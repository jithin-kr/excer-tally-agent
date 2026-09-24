# excer-tally-agent

On-premises agent bridging the Excer Global Next.js app to TallyPrime's XML gateway.

An HTTP API for posting vouchers, an AlterID poll loop for reading masters back, and a heartbeat —
running on the client's premises, next to Tally.

---

## Why this exists

Tally is a Windows desktop application. It has **no cloud API, no webhooks, and no outbound push
of any kind**. Its only general-purpose integration surface is XML over HTTP on port 9000, and
that port must never be exposed to the internet — it has no authentication and no TLS.

So the app cannot talk to Tally directly. This agent runs on the client's premises next to Tally
and is reachable from the app through a Cloudflare Tunnel, which is an **outbound** connection
from their network. No firewall changes, no port forwarding, no static IP.

```
 CLIENT PREMISES (LAN)                        VERCEL
 ┌──────────────────────────────┐            ┌────────────────────────────┐
 │  TallyPrime :9000            │            │  Next.js app               │
 │      ▲ XML/HTTP (localhost)  │            │                            │
 │  ┌───┴──────────────────┐    │ Cloudflare │  lib/tally/connector.ts ───┼─► push
 │  │  excer-tally-agent   │◄───┼──Tunnel────┼──                          │
 │  │  :7010 (127.0.0.1)   │    │            │  /api/tally/pull       ◄───┼── deltas
 │  │  • HTTP server       │────┼─ HTTPS out ┼─►/api/tally/heartbeat  ◄───┼── liveness
 │  │  • AlterID poll loop │    │            │                            │
 │  │  • heartbeat         │    │            │  TallyJob queue (Postgres) │
 │  └──────────────────────┘    │            └────────────────────────────┘
 └──────────────────────────────┘
```

**Read is ~15 seconds behind. Write is 1–3 seconds.** That asymmetry is Tally's design, not ours:
we can call Tally whenever we like, but Tally can never call us, so reads are polling.

---

## Layout

| Path | What it does |
|---|---|
| `src/tally/client.ts` | POSTs XML to Tally (one request at a time), parses failure envelopes |
| `src/tally/xml.ts` | Export/Import envelopes, date + escaping helpers |
| `src/tally/util.ts` | Tally value coercion (`"42 Nos"` → `42`) |
| `src/tally/voucher-render.ts` | Generic voucher/ledger/inventory XML, with `REMOTEID` / `ISOPTIONAL` |
| `src/excer/contract.ts` | The wire contract with the Next.js app |
| `src/excer/config.ts` | Agent config + all installation-specific Tally names |
| `src/excer/vouchers.ts` | The six Excer payloads → Tally XML |
| `src/excer/masters.ts` | AlterID-based incremental read |
| `src/excer/lookup.ts` | Find a written voucher/ledger: duplicate check + real voucher number |
| `src/server.ts` | The two HTTP endpoints the app calls |
| `src/poll-loop.ts` | Two-stage "has anything changed?" polling, on both AlterID counters |
| `src/state-store.ts` | Persists the poll watermarks across restarts |
| `src/log.ts` | Timestamped logging; one audit line per push |
| `test/` | `npm test` — node:test against a fake Tally, no Tally needed |
| `src/heartbeat.ts` | Liveness reporting |
| `src/doctor.ts` | Day-one validation against a real Tally |

---

## Setup

```bash
npm install
cp .env.example .env      # then edit it
npm run build
npm run doctor            # verify against a real Tally BEFORE anything else
npm start
```

The server binds to `127.0.0.1` on purpose. The only route in is the tunnel. Binding `0.0.0.0`
would expose an agent that can write to the accounting books to the entire office LAN.

---

## The endpoints

Both mirror the dev fixture at `src/app/api/dev-fake-tally/` in the main repo, so pointing
`TALLY_CONNECTOR_BASE_URL` at this agent instead of at the fixture is a pure config change.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/health` | none / `x-api-key` | Liveness. Without the key: `{ ok, agentId, tallyReachable }` only (it is public through the tunnel). With the key: company, last poll, last error, watermarks. Never queries Tally itself — it reports the poll loop's last result |
| `GET` | `/api/export/masters?sinceAlterId=N` | `x-api-key` | Stock items + customer ledgers |
| `POST` | `/api/import/voucher` | `x-api-key` | Post one of the six voucher types |

### Idempotency

Every voucher carries `<REMOTEID>`, built by `buildTallyRemoteId()` in the main app. Before
writing, the agent looks the REMOTEID up in Tally (`src/excer/lookup.ts`); if the voucher is
already there it returns `{ duplicate: true }` **without re-importing** — which the app treats as
**success**, because the voucher it wanted does exist in Tally. Checking first matters because a
re-import carrying a known REMOTEID may *alter* the existing voucher rather than be ignored, e.g.
flipping one the accountant already converted to Regular back to Optional.

New customer ledgers are checked by name. Same name + same REMOTEALTGUID is a duplicate; same name
belonging to a **different** customer is a `409` — never reported as success.

### Voucher numbers

After a successful write the agent reads the voucher back and returns its real `GUID` and
`VOUCHERNUMBER`. It used to return Tally's `LASTVCHID`, which is an internal id, not the voucher
number — and the app sends that value back to cancel, so cancelling could hit a different order.
If the read-back finds nothing, `voucherNumber` is omitted and the push log says so; cancelling
that order then fails with a clear error rather than guessing.

### Payload validation

Every push body is validated with zod (`pushRequestSchema`, `src/excer/contract.ts`) before any
XML is built. A malformed payload is a `400` listing each bad field. (Before this, a missing
`grandTotal` became `NaN`, passed the balance check, and rendered `<AMOUNT>NaN</AMOUNT>`.)

### Polling: two counters

`ALTMSTID` moves when a master is edited; `ALTVCHID` moves when a voucher is entered. Stock levels
change through **vouchers** — a purchase raises closing stock without editing the item master — so
the loop watches both. A voucher change re-reads every item's closing balance, at most once per
`STOCK_REFRESH_MIN_INTERVAL_MS` (default 60s). Watermarks are saved to `AGENT_STATE_FILE`, so a
restart does not re-export everything. A counter going **backwards** (company restored from backup)
triggers a full re-sync; both counters reading **0** stops the loop with an error, instead of a full
export every tick. All Tally requests go through one queue — Tally serves one at a time.

---

## The GST split decision — made 2026-09-23

`splitGst()` in `src/excer/vouchers.ts` was deliberately left unimplemented (it threw) until a
Stage 1 test with the main app — no real Tally, just proving the wiring — surfaced that this
blocks *every* taxed order, not an edge case, the moment a real connector exists. The client made
the call the same day:

Indian GST splits **CGST + SGST** for a sale inside your own state and **IGST** for a sale to
another state. Excer is in Kerala. The function receives the tax total, what we know about the
buyer (`gstin` and/or `state`), and the configured `homeState`.

1. **Free-text `state` always wins when present** — even when it disagrees with what the GSTIN's
   state code would imply. The GSTIN is used only to *derive* a state when no free-text state is
   on file at all (via the CBIC two-digit state code table in `vouchers.ts`).
2. **Both missing, or an unrecognised GSTIN code with no state** → throws. Blocks the push until
   someone fixes the customer's address/GSTIN in the admin panel — discovered today, not misfiled
   in the client's books and discovered by an accountant months later. The job retries
   automatically once the record is fixed (`MAX_AUTO_RETRY_ATTEMPTS`, main repo CLAUDE.md §22.10).
3. **Rounding**: SGST is computed as the remainder (`taxTotal - cgst`), not independently rounded,
   so the two halves always sum to exactly `taxTotal` regardless of an odd paisa — verified with a
   ₹495.90 tax total (the real order that surfaced this) splitting to ₹247.95 / ₹247.95 exactly.

The doc comment on the function repeats this in place. The cases (both decisions, the fallback,
the conflict, rounding, and both throw paths) are in `test/vouchers.test.ts` — run `npm test`.

---

## Required changes in the main app — DONE (2026-09-23)

Found while building the agent against the existing payload builders in
`src/features/tally/mapping.ts`. All five are now done on the excer-global side (see its
CLAUDE.md §22.5 for the file-level detail); only #5 needs a further deployment step once a tunnel
hostname exists.

1. ✅ **`buildCancelVoucherPayload` includes the voucher number.** Tally cancels a voucher by its
   **voucher number**, not by REMOTEID. `salesOrderVoucherNumber` is now sent, read from
   `Order.tallyVoucherNumber`.
2. ✅ **`buildDeliveryNotePayload` sends `buyerLedgerName` and `referencedVoucherNumber`.** A
   delivery note still posts against the customer and references its sales order.
3. ✅ **`buildCreditNotePayload` sends `buyerLedgerName` and `buyerGstin`.** The ledger name to
   post against, and the GSTIN so the tax reversal can pick CGST+SGST vs IGST.
4. ✅ **Two new routes exist**: `POST /api/tally/pull` (accepts master deltas) and
   `POST /api/tally/heartbeat` (accepts liveness). Both bearer-authenticated
   (`TALLY_AGENT_TOKEN` on the app side must match this agent's `EXCER_APP_TOKEN`), and both
   were added to the app's proxy's public-route allowlist so an unauthenticated call gets a real
   401 instead of a 307 to `/login`.
5. ⬜ **`connector.ts`**: still needs `TALLY_CONNECTOR_BASE_URL` pointed at the tunnel hostname
   once one exists — a deployment step, not code. Mock mode still works for local development.

None of this has been run against this agent talking to a real Tally, or against a real tunnel
deployment — see "Not yet verified against a real Tally" below, which is unchanged by this.

---

## Not yet verified against a real Tally

This agent has **never been run against a live Tally installation**. It typechecks, builds, serves, and rejects bad input correctly. That is all it
currently proves.

Verify each of these before trusting the agent with real books:

- [ ] `<REMOTEID>` is accepted on vouchers and does suppress duplicates. TallyConnector's captured
      fixtures use `<REMOTEALTGUID>` for **masters**; `<REMOTEID>` is the documented **voucher**
      field. We may need both.
- [ ] The Company object exposes `ALTMSTID` / `ALTVCHID`. **Incremental sync depends entirely on
      this.** `npm run doctor` fails if they come back as 0, and the poll loop refuses to run.
- [ ] `ALTVCHID` moves when a voucher is entered, and a purchase voucher's stock change shows up on
      the website within ~15s–60s.
- [ ] The REMOTEID lookup (`$RemoteID` filter, `src/excer/lookup.ts`) finds a voucher we pushed —
      **including an Optional one**. Proof: the first test-company push's log line shows
      `vch=<number>`, not `vch=?`, and pushing the same payload again logs `duplicate`.
- [ ] The ledger lookup returns `REMOTEALTGUID` for a ledger we created (otherwise a retried
      new-customer push is a 409 instead of a duplicate).
- [ ] `$AlterID > n` works as a collection `FILTER` on this Tally build.
- [ ] Stock Journal XML — cable cuts may need `SOURCELIST`/`DESTINATIONLIST` rather than the flat
      `ALLINVENTORYENTRIES.LIST` this renders.
- [ ] Field names on stock items: `OpeningRate` for base price, whether `HSNCode` lives on the
      item or the stock **group**.
- [ ] Every name in `.env.example`'s bottom section — voucher types, ledgers, the customer group.
      The defaults are Tally's out-of-the-box names and are very likely wrong here.
- [ ] `<ISOPTIONAL>Yes</ISOPTIONAL>` (added 2026-09-23, `TALLY_POST_VOUCHERS_AS_OPTIONAL`) actually
      posts to the Optional Vouchers register instead of being silently ignored — and whether
      Tally's Cancel action applies cleanly to an Optional voucher the accountant hasn't converted
      to Regular yet. This flag exists because the main app's push is now fully automatic rather
      than triggered by an admin clicking a button, so Optional is the new human-review gate — see
      the main repo's CLAUDE.md §22.9.

Post your first voucher into a **test company**, never the live one.

---

## Still blocked on the client

Neither is a code problem, and both outrank everything above:

1. **May we install a Windows Service on the Tally machine?** If not, this whole approach needs
   rethinking. Find out first.
2. **Who owns stock — Tally, the app, or both reconciled?** (CLAUDE.md §20.5, options A/B/C.)
   Today the app deducts stock on dispatch. Once we also post Delivery Notes, both systems deduct
   the same goods unless this is decided deliberately.

---

## Licence

MIT — see `LICENSE`. The files under `src/tally/` include code used under a third-party MIT
licence; its notice is kept in `NOTICE`, as that licence requires.
