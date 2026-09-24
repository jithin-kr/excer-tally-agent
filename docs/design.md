# Interface Design

| | |
|---|---|
| **Scope** | The agent has no UI. Its "design" is its interfaces: the HTTP API, the Tally XML it writes and reads, and what operators see |
| **Source of truth** | `src/excer/contract.ts` (API), `src/excer/vouchers.ts` + `src/tally/voucher-render.ts` (XML) |
| **Last reviewed** | 2026-09-24 |

Every Tally layout below was **verified against a live TallyPrime Edit Log** unless marked ❌.

---

## 1. HTTP API (called by the website through the tunnel)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/health` | none / `x-api-key` | No key: `{ ok, agentId, tallyReachable }`. With key: + company, last poll, last error, watermarks |
| `GET` | `/api/export/masters?sinceAlterId=N` | `x-api-key` | Stock items + customer ledgers changed since N |
| `POST` | `/api/import/voucher` | `x-api-key` | One document; body = payload fields + `type` |

### Response contract for `POST /api/import/voucher`

| Status | Body | Meaning | Website should |
|---|---|---|---|
| 200 | `{ success: true, guid, voucherNumber? }` | Written | Mark done; store `guid` |
| 200 | `{ success: true, duplicate: true, guid }` | Already in Tally | Mark done |
| 400 | `{ success: false, error, issues[] }` | Payload malformed | Stop retrying; fix the builder |
| 409 | `{ success: false, error }` | Ledger name owned by another customer | Stop retrying; a human decides |
| 422 | `{ success: false, error }` | Tally rejected it / data not ready | Retry after the data is fixed |
| 502 | `{ success: false, error }` | Tally unreachable | Retry |

`voucherNumber` is **informational**: Optional vouchers share numbers. Identify documents by
REMOTEID or GUID only.

### Outbound calls (agent → website), `Authorization: Bearer <EXCER_APP_TOKEN>`

| Path | When | Body |
|---|---|---|
| `/api/tally/pull` | Counters moved | `{ agentId, sinceAlterId, stockItems[], ledgers[] }` |
| `/api/tally/heartbeat` | Every 30s | `{ agentId, agentVersion, tallyReachable, tallyCompany, lastAlterId, lastPollAt, lastError, sentAt }` |

Stock item row: `guid, name, alias, alterId, closingStockQty, baseUnit, hsnCode, gstRate, baseRate, active`.
`gstRate` / `baseRate` are **null when unknown — never 0**. `baseRate` is the ex-GST selling price.

## 2. Voucher layouts written to Tally

Sign convention everywhere: **negative = Debit, positive = Credit**; every voucher, including
item allocations, nets to zero.

| Document | View | Ledger lines | Item lines |
|---|---|---|---|
| Sales Order ❌ | Invoice | party Dr, discount Dr, tax Cr | Cr, sales allocation |
| Delivery Note | Invoice | party Dr | Cr, sales allocation (non-accounting type) |
| Credit Note | Invoice | party Cr, tax Dr | **Dr** (goods back in), sales allocation |
| Stock Journal | Consumption | — | `OUT` + `IN` of the same length (stock-neutral) |
| Cancel | — | `<VOUCHER REMOTEID="…" ACTION="Cancel">` | — |
| New ledger | master | `LEDMAILINGDETAILS` + `LEDGSTREGDETAILS` (dated), flat tags too | — |

Layout rules that Tally enforces (each broke a real import):
- `REMOTEID` is a **`<VOUCHER>` attribute**, not a child element.
- Invoice view uses `LEDGERENTRIES.LIST`; accounting view `ALLLEDGERENTRIES.LIST`.
- The sales ledger appears **only** in item `ACCOUNTINGALLOCATIONS`, never also as a ledger line.
- Units are Tally's own names ("Mtr"); no unit = bare quantity in the item's base unit.
- Discount: posted only if line values are pre-discount, worked out from the totals.

## 3. Values read from Tally (TallyPrime 3+)

| Field | Where it really is | Not |
|---|---|---|
| Customer state, address, pincode | `LEDMAILINGDETAILS.LIST` (latest `APPLICABLEFROM`) | `LEDSTATENAME` (ignored) |
| Customer GSTIN | `LEDGSTREGDETAILS.LIST` | `PARTYGSTIN` |
| Item GST rate | `GSTDETAILS.LIST → STATEWISEDETAILS → RATEDETAILS` (IGST = full rate) | `GSTRate` (empty) |
| Item HSN | `HSNDETAILS.LIST` | `HSNCode` |
| Selling price | latest `STANDARDPRICELIST.LIST` | `OpeningRate` (cost), `$StandardPrice` (falls back to last sale) |
| Our voucher key | `$RemoteGUID` | `$RemoteID` (never matches) |
| Import result | `<DATA><IMPORTRESULT>`, rejections as `EXCEPTIONS`, `LINEERROR` inside | `<RESPONSE>` |

Targeted `FETCH` answers typed values (`<X TYPE="String">…</X>`); `util.ts` unwraps them.

## 4. What operators see

- **Log line per write**: `… [push] push_credit_note <remoteId> -> 200 created guid=… vch=6`.
- **Poll**: first 3 failures, then every 100th; a recovery line.
- **`npm run doctor`**: PASS / WARN / NOTE / FAIL per assumption; exit code 0 only when the agent
  can work.
- **Admin panel** (website): connected / Tally unreachable / disconnected, from heartbeats.
- Tally: agent vouchers appear in the **Optional** register until an accountant converts them.
