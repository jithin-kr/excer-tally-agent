// The poll watermarks, persisted across restarts.
//
// Without this, every reboot, crash-restart or Windows Update started the sync from AlterID 0 — a
// full export of every stock item and customer ledger, the heavy query the whole two-stage design
// exists to avoid. The file is tiny and written atomically (write a temp file, then rename), so a
// power cut mid-write leaves the previous watermark intact rather than a half-written file.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { errorMessage, log } from "./log.js";

export interface Watermarks {
  lastMasterAlterId: number;
  lastVoucherAlterId: number;
}

interface StoredState extends Watermarks {
  /** The company these watermarks belong to. AlterIDs from another company mean nothing. */
  company: string | null;
}

const EMPTY: Watermarks = { lastMasterAlterId: 0, lastVoucherAlterId: 0 };

export function loadWatermarks(path: string, company: string | null): Watermarks {
  let stored: Partial<StoredState>;
  try {
    stored = JSON.parse(readFileSync(path, "utf8"));
  } catch (err: any) {
    if (err?.code !== "ENOENT") {
      log.warn("state", `could not read ${path} (${errorMessage(err)}) — starting a full sync`);
    }
    return { ...EMPTY };
  }
  if ((stored.company ?? null) !== company) {
    log.warn("state", `watermarks in ${path} belong to a different company — starting a full sync`);
    return { ...EMPTY };
  }
  return {
    lastMasterAlterId: Number(stored.lastMasterAlterId) || 0,
    lastVoucherAlterId: Number(stored.lastVoucherAlterId) || 0,
  };
}

export function saveWatermarks(path: string, company: string | null, marks: Watermarks): void {
  const body: StoredState = { company, ...marks };
  const tmp = `${path}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, JSON.stringify(body, null, 2));
    renameSync(tmp, path);
  } catch (err) {
    // Not fatal: the in-memory watermark is still correct, the next restart just re-syncs more.
    log.warn("state", `could not save ${path}: ${errorMessage(err)}`);
  }
}
