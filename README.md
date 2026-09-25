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

**Writes take 1–3 seconds. Reads lag:** master changes (customers, items) about 15 seconds, stock
moved by vouchers up to about a minute. That asymmetry is Tally's design, not ours: we can call
Tally whenever we like, but Tally can never call us, so reads are polling.

Full documentation is in [`docs/`](docs/): [prd](docs/prd.md) (what and why) ·
[architecture](docs/architecture.md) · [design](docs/design.md) (API and Tally XML) ·
[rules](docs/rules.md) (for changing the code) · [memory](docs/memory.md) (facts and traps).

---

## Layout

| Path | What it does |
|---|---|
| `src/index.ts` | Entry point: config, Tally client, server, poll loop, heartbeat; process safety nets |
| `src/server.ts` | The HTTP endpoints; push flow (check → write → read back); `/health` |
| `src/poll-loop.ts` | Two-stage "has anything changed?" polling, on both AlterID counters |
| `src/state-store.ts` | Persists the poll watermarks across restarts |
| `src/heartbeat.ts` | Liveness reporting to the website |
| `src/doctor.ts` | `npm run doctor`: read-only checks against a real Tally |
| `src/log.ts` | Timestamped logging; one audit line per push |
| `src/excer/contract.ts` | The wire contract with the website (zod schemas) |
| `src/excer/config.ts` | Agent config + every installation-specific Tally name |
| `src/excer/vouchers.ts` | The six Excer payloads → Tally XML; GST split; discount reconciliation |
| `src/excer/masters.ts` | Counters, stock items (stock, GST, HSN, selling price), customer ledgers |
| `src/excer/lookup.ts` | Find what we wrote: voucher by REMOTEID, ledger by name |
| `src/tally/client.ts` | POSTs XML to Tally, one request at a time; failure envelopes |
| `src/tally/xml.ts` | Collection-export and import envelopes, escaping, dates, result parsing |
| `src/tally/util.ts` | Value coercion; unwraps Tally's typed values |
| `src/tally/voucher-render.ts` | Generic voucher/ledger/inventory XML, with `REMOTEID` / `ISOPTIONAL` |
| `test/` | `npm test`: node:test against a fake Tally built from real responses |
| `install/` | Windows service installer; install and tunnel runbooks |
| `docs/` | Requirements, architecture, interfaces, coding rules, project memory |

---

## Setup

```bash
npm install
cp .env.example .env      # then edit it
npm run build
npm test                  # no Tally needed
npm run doctor            # verify against a real Tally BEFORE anything else
npm start
```

The server binds to `127.0.0.1` on purpose. The only route in is the tunnel. Binding `0.0.0.0`
would expose an agent that can write to the accounting books to the entire office LAN.

---

## The endpoints

The website's dev fixture (`src/app/api/dev-fake-tally/`) serves the same paths, so pointing
`TALLY_CONNECTOR_BASE_URL` at this agent instead is a config change. Status codes and response
bodies are specified in [docs/design.md](docs/design.md).

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/health` | none / `x-api-key` | Liveness. Without the key: `{ ok, agentId, tallyReachable }` only (it is public through the tunnel). With the key: company, last poll, last error, watermarks. Never queries Tally itself — it reports the poll loop's last result |
| `GET` | `/api/export/masters?sinceAlterId=N` | `x-api-key` | Stock items + customer ledgers |
| `GET` | `/api/export/outstandings` | `x-api-key` | Every Sundry Debtor with a balance, live (Dr positive), for the website's Outstandings report |
| `POST` | `/api/import/voucher` | `x-api-key` | Post one of the six voucher types |

### Idempotency

Every voucher carries a REMOTEID — built by `buildTallyRemoteId()` in the main app — stamped as an
**attribute** of `<VOUCHER>`. (As a child element, Tally silently discards it and stamps its own
GUID — verified live.) Tally stores it, readable back as `$RemoteGUID`.

Before writing, the agent looks the REMOTEID up (`src/excer/lookup.ts`). If the voucher is already
there it returns `{ duplicate: true }` **without re-importing** — success, because the voucher the
app wanted exists. Checking first is essential, not defensive: a re-import with a known REMOTEID
**alters** that voucher (verified live: `ALTERED 1`), which would overwrite an accountant's edits.
Pushes are also run one at a time, so two retries of the same job can't both pass the check.

New customer ledgers are checked by name. Same name + same REMOTEALTGUID is a duplicate; same name
belonging to a **different** customer is a `409` — never reported as success.

### Identifiers and cancelling

After a write the agent reads the voucher back and returns its real `GUID` (and `voucherNumber`,
informational only). Voucher numbers **cannot identify a voucher**: Tally gives Optional vouchers
non-unique numbers (two Optional credit notes were both "6", later both "7"), and a Sales Order
type may have no numbering at all. So a cancel targets the Sales Order by its **REMOTEID**
(`<VOUCHER REMOTEID="…" ACTION="Cancel">` — verified live, no date or number needed). The agent
first checks the order exists (else a clear `422`) and isn't already cancelled (else `duplicate`).

### Success means Tally wrote something

Live TallyPrime reports import results in `<IMPORTRESULT>`, counts a rejected voucher under
`EXCEPTIONS` (not `ERRORS`), and puts `LINEERROR` inside it. A result is success only if Tally
created, altered, combined or cancelled something; anything else is a `422` with Tally's reason.

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
   someone fixes the customer's address/GSTIN in the admin panel — found at once, not misfiled
   in the client's books and discovered by an accountant months later. The website rebuilds the
   payload on every retry, so the job goes through once the record is fixed.
3. **Rounding**: SGST is computed as the remainder (`taxTotal - cgst`), not independently rounded,
   so the two halves always sum to exactly `taxTotal` regardless of an odd paisa — verified with a
   ₹495.90 tax total (the real order that surfaced this) splitting to ₹247.95 / ₹247.95 exactly.

The doc comment on the function repeats this in place. The cases (both decisions, the fallback,
the conflict, rounding, and both throw paths) are in `test/vouchers.test.ts` — run `npm test`.

---

## The website's side

Changes in excer-global on branch `fix/tally-agent-live-verification` (CLAUDE.md §39–§40), pushed
and passing its CI (unit + integration tests); merge it to deploy:

1. ✅ Pull/heartbeat routes, bearer-authenticated (`TALLY_AGENT_TOKEN` = this agent's
   `EXCER_APP_TOKEN`), constant-time token check.
2. ✅ **GST-inclusive prices are split, not added to.** Our prices include GST; the Sales Order
   payload used to add GST on top (every taxed order ~18% too high in Tally), and the Credit Note
   sent the inclusive refund as the taxable value (no GST reversed). A line whose GST rate is
   unknown blocks the push with a clear message instead of going out tax-free.
3. ✅ **Units are Tally's own** (`Product.tallyBaseUnit`), never "m"/"pcs", which Tally rejects;
   null sends a bare quantity (Tally uses the item's base unit — verified live).
4. ✅ Sales Order / Credit Note payloads are **rebuilt from current data on every push attempt**, so
   fixing a customer's state or a product's GST rate lets the next retry succeed.
5. ✅ `400`/`409` are permanent (no auto-retry); `422`/`502` retry. Timeout on agent calls.
6. ✅ A successful push with no GUID stamps the REMOTEID, so dependent jobs are never stranded.
7. ✅ The pull is batched (one query per master kind), writes only what changed, and counts
   unlinked Tally items instead of logging each as an error — the agent re-sends all stock after
   stock-moving vouchers. Fractional stock is rounded down (`stockLevel` is an Int). The base
   price = Tally's standard selling price + GST, touched only when the item master changed.
8. ✅ **Tally products appear on the website** as hidden drafts ("From Tally" category) with
   Tally's stock, price, GST, HSN and unit; the admin adds images/details and publishes. Tally can
   hide a product but never publish one, so admin edits survive every sync.
9. ✅ **Live end-to-end run** (`scripts/tally-live-e2e.ts` there): website routes + push loop +
   this agent + a TallyPrime test company — 16/16, apart from the Sales Order below.
10. ⬜ Deployment: merge the branch; point `TALLY_CONNECTOR_BASE_URL` at the tunnel hostname.

---

## Verified against a live TallyPrime (2026-09-24)

TallyPrime Edit Log (Educational mode), test company, through the agent end to end, plus payloads
built by the website's own mapping code:

- ✅ Counters (`ALTMSTID`/`ALTVCHID`), `$AlterID > n` filters, incremental + voucher-driven
  stock sync to the website within 5–60s; heartbeat.
- ✅ Typed values (`<X TYPE="…">`) unwrapped — they used to parse as JSON garbage / 0.
- ✅ Customers: state/address in dated `LEDMAILINGDETAILS.LIST`, GSTIN in `LEDGSTREGDETAILS.LIST`
  (flat tags are silently ignored by this TallyPrime); sub-group customers included
  (`$$IsBelongsTo`, not `$Parent =`); create / retry-duplicate / name-clash `409`.
- ✅ Stock items: GST rate from `GSTDETAILS.LIST` (flat `GSTRate` is empty), HSN from
  `HSNDETAILS.LIST`, selling price from the set `STANDARDPRICELIST` — not `OpeningRate` (cost)
  nor `$StandardPrice` (falls back to the last sale's rate).
- ✅ Credit Note (CGST+SGST and IGST), Delivery Note, Stock Journal: created, correct postings read
  back, retries caught before writing. Invoice layout = `LEDGERENTRIES.LIST` + sales only via
  the item allocations; returns are debits; Stock Journal needs `INVENTORYENTRIESOUT/IN.LIST`.
- ✅ `ISOPTIONAL` posts Optional vouchers, which don't touch stock until converted.
- ✅ Cancel by REMOTEID.
- ❌ **Sales Order: still rejected — `Bad Order Number in Voucher!`** in every layout tried, even
  after enabling order processing. Needs one Sales Order entered by hand in Tally to copy its
  exact XML. Until then Sales Orders fail as a clear `422` (retried), never as a false success.

Still to check on the client's real Tally: every name in `.env.example`'s bottom section, and
whether GST rates/HSN are set on items or inherited from stock groups (inherited → `gstRate` null →
orders with those items wait for the rate, by design).

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
