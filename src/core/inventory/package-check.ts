import type { PartRollup } from "../consolidate/findings.js";
import { chipSizes } from "../footprint/name.js";
import type { Issue } from "../types.js";
import type { Resolution } from "./types.js";

/**
 * Metric chip code → imperial.
 *
 * Written out rather than derived from the millimetre table: 0805 is 2.0 ×
 * 1.25 mm and its metric code is `2012`, not the `2013` that rounding gives,
 * and 1210 is `3225` while 1206 is `3216` from the same 3.2 mm width. These are
 * the EIA pairs KiCad uses in its own names (`R_0805_2012Metric`,
 * `C_2220_5750Metric`), and a table is the honest way to hold them.
 */
const metricToImperial: Record<string, string> = {
  "0603": "0201", // and note the collision: metric 0603 is imperial 0201
  "1005": "0402",
  "1608": "0603",
  "2012": "0805",
  "3216": "1206",
  "3225": "1210",
  "4532": "1812",
  "5025": "2010",
  "5750": "2220",
  "6332": "2512",
};

/** What a package field says when nothing said it. */
const unknown = new Set(["", "?", "-", "n/a", "none"]);

/**
 * Reduces a package to something two people would write the same way.
 *
 * The board's side comes out of a footprint name (`0603`); yours is typed, and
 * `0603`, ` 0603 `, `1608`, `1608Metric` and `R0603` all mean the same part.
 * Anything that is not a chip code is compared as written, case-folded — a
 * `SOIC-8` is a `SOIC-8` and the tool has no table for those.
 */
export function normalisePackage(value: string): string {
  const bare = value.trim().toLowerCase().replace(/\s+/g, "");
  if (unknown.has(bare)) return "";

  const chip = /^(?:[rcl]|fb)?(\d{4})(?:metric)?$/.exec(bare);
  if (chip === null) return bare;

  const code = chip[1] as string;
  // Imperial wins the `0603` collision: it is what a person means when they
  // write four digits with no unit, and what every footprint name uses first.
  if (chipSizes[code] !== undefined) return code;
  return metricToImperial[code] ?? code;
}

/**
 * The part you buy against the pads the board has.
 *
 * This is the one check that needs the catalog: everything else the tool knows
 * comes from the schematic, and the schematic cannot say that you went and
 * bought 0603 resistors for an 0402 land pattern. It only fires where you have
 * recorded a package — a blank means "not checked", which is honest, rather
 * than a guess dressed up as a verdict.
 */
export function packageIssues(
  parts: readonly PartRollup[],
  resolutions: readonly Resolution[],
): Issue[] {
  const byKey = new Map(resolutions.map((r) => [r.key, r]));
  const issues: Issue[] = [];

  for (const part of parts) {
    const bought = byKey.get(part.key)?.part;
    const declared = bought?.package;
    if (bought === undefined || declared === undefined || declared.trim() === "") continue;

    const wanted = normalisePackage(part.pkg);
    const have = normalisePackage(declared);
    if (wanted === "" || have === "" || wanted === have) continue;

    issues.push({
      code: "package-mismatch",
      severity: "error",
      message:
        `${bought.mpn} is ${declared}, but ${part.key} has a ${part.pkg} land pattern — ` +
        "the part will not fit the pads",
      refs: part.refs,
    });
  }

  return issues;
}
