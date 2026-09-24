# Project Memory

Context a new developer (or an AI coding agent) would otherwise have to rediscover the hard way.
Facts here are snapshots: **check them against the code before acting**. No secrets belong in
this file.

| | |
|---|---|
| **Last updated** | 2026-09-24 |
| **Project started** | 2026-09-16 (fork of `ShrutiSaagar/tally-prime-mcp`, MIT) |

---

## 1. The project in one paragraph

A Windows service on Excer Global's office PC that bridges their website (`excer-global`) and
TallyPrime. It turns website events into Tally vouchers, and sends Tally's stock and customer
changes back, through a Cloudflare Tunnel so nothing is exposed. See [prd.md](prd.md).

## 2. Where things are

| Thing | Where |
|---|---|
| Agent repo | GitHub `jithin-kr/excer-tally-agent`, branch **`main` only** (CI on every push) |
| Website repo | `excer-global`, sibling folder; GitHub `sarath-velvetek/Excer-Global`. Tally work on branch `fix/tally-agent-live-verification` (not yet merged); another developer works on `main` |
| Live e2e check | `scripts/tally-live-e2e.ts` in the website repo (throwaway DB + this agent + test company) |
| Handover PDF | `docs/Excer-Tally-Agent.pdf` (client-facing, dated 2026-09-16; predates the live-Tally verification — README is current) |
| Detailed record | `README.md` ("Verified against a live TallyPrime"); website `CLAUDE.md` §20–§22, §39 |
| Upstream licence notice | `NOTICE` — required by MIT for the five `src/tally/*` files |

## 3. Environments

- **No real client Tally yet.** Development testing used **TallyPrime Edit Log, Educational mode**,
  installed at `C:\Program Files\TallyPrimeEditLog`, data in `C:\Users\Public\TallyPrimeEditLog\data`.
- **Educational mode only accepts voucher dates on the 1st, 2nd and 31st** of a month. Use those
  when testing.
- Tally answers on port 9000 **only while it is open with a company loaded**. Enable it in Tally:
  F1 → Settings → Connectivity → Client/Server → "Both", port 9000. `tally.ini` showing
  `Client Server=None` means it is off.
- The XML interface **cannot create or open a company**; that is done in Tally's UI.
- Test company **`Jz`** (Kerala, GST on, order processing enabled via XML) holds mock masters and
  test vouchers: customers Kochi Traders (Kerala), Chennai Electricals (Tamil Nadu), Walk-in
  Customer, Thrissur Hardware (sub-group), Probe Ledger; items Copper Cable 2.5mm / 4mm (Mtr),
  MCB 32A (Nos), all 18% GST. Local testing ran the agent on port 7020 with `TALLY_COMPANY=Jz`
  and `TALLY_LEDGER_SALES=Sales`.

## 4. Git and GitHub

- Commits are authored as **jithin**; co-authored trailers on AI-assisted commits.
- The repo belongs to **`jithin-kr`**. The machine's default `gh` account is `jithin-jz`, which
  can read the public repo but not change its settings: use
  `GH_TOKEN=$(gh auth token --user jithin-kr) gh …`.
- Only `main` exists (the old `excer` branch was renamed to `main`; the upstream remote removed).
- The repo is **public** and contains the client's accounting rules; consider making it private.

## 5. Key decisions (newest first)

| Date | Decision |
|---|---|
| 2026-09-24 | Tally items appear on the website as hidden drafts; admin adds images/details and publishes; Tally can hide, never publish |
| 2026-09-24 | Cancel by REMOTEID, never by voucher number (Optional vouchers share numbers) |
| 2026-09-24 | Look up REMOTEID **before** writing; re-imports alter existing vouchers |
| 2026-09-24 | Success only when Tally reports something written |
| 2026-09-24 | Unknown GST rate / selling price is `null`, never 0; the website waits instead of guessing |
| 2026-09-24 | Selling price = set `STANDARDPRICELIST`, not `OpeningRate` (cost) |
| 2026-09-24 | Cable cuts are stock-neutral (OUT + IN), so cut metres aren't deducted twice |
| 2026-09-24 | Poll both `ALTMSTID` and `ALTVCHID`; persist watermarks |
| 2026-09-23 | Post vouchers as Optional; accountant converts = human review |
| 2026-09-23 | GST split: free-text state wins, GSTIN fallback, else refuse |

## 6. Traps (each one cost real debugging time)

- **Tally silently ignores what it doesn't understand.** A wrong tag is not an error: it is
  dropped (REMOTEID child element, `LEDSTATENAME`). Always read back what you wrote.
- **A rejected import can look like success**: all counts 0, the failure only in `EXCEPTIONS`,
  often with no message. Tally's messages can mislead (`The date 0-0-0 is Out of Range!` means
  "no voucher with that REMOTEID").
- **Fakes lie in the ways you assume.** Every test fake used `<RESPONSE>`; real Tally uses
  `<IMPORTRESULT>`. Capture real responses and test against those.
- **A test that passes with the fix removed tests nothing.** Re-run new tests with the fix
  disabled once.
- Computed Tally methods fall back silently: `$StandardPrice` → last sale's rate,
  `$StandardCost` → opening rate.
- `process.exit()` with open undici sockets trips a libuv assertion on Windows (exit code 127).

## 7. Open items

1. **Sales Order** is rejected (`Bad Order Number in Voucher!`) in every layout tried. Next step:
   enter one by hand in Tally (Ctrl+F8), export it, copy the structure.
2. Client questions: permission to install a service; stock ownership (website vs Tally).
3. The client's real voucher-type/ledger/group names for `.env`.
4. Whether the client sets GST/HSN per item or per stock group (group → `gstRate` null).
