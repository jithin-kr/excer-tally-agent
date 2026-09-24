// Value coercion for parsed Tally XML.

/**
 * EXCER: unwrap a typed Tally value. A targeted FETCH answers `<GUID TYPE="String">abc</GUID>`,
 * which the parser (attributes on) turns into `{ "#text": "abc", "@_TYPE": "String" }`. Without
 * this, GUIDs became JSON strings and every AlterID/counter parsed as 0 — found against a live
 * TallyPrime on 2026-09-24. An element with a type but no text (`<X TYPE="String"/>`) is empty.
 */
function unwrap(v: unknown): unknown {
  if (v !== null && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    if ("#text" in o) return o["#text"];
    if (Object.keys(o).every((k) => k.startsWith("@_"))) return "";
  }
  return v;
}

/** Coerce any Tally value (which may already be a Number/Boolean from the parser) to a string. */
export function s(v: unknown): string {
  v = unwrap(v);
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** Coerce to number, handling Tally's empty / whitespace cases. */
export function n(v: unknown): number {
  v = unwrap(v);
  if (v === null || v === undefined || v === "") return 0;
  const num = Number(v);
  return Number.isNaN(num) ? 0 : num;
}

/** Normalize an array-ish XML node so we can iterate safely. */
export function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v === null || v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}
