import type { AnalyzedLine, Severity } from "../types.js";
import { checkFootprint, type FootprintFinding } from "./check.js";
import { measure, type MeasuredPad, type Measurement } from "./measure.js";
import { parseFootprintName, type DeclaredFootprint } from "./name.js";

export type FootprintAudit = {
  /** `Library:Name` as written on the symbol. */
  reference: string;
  /** Which parts use it, and how many placements. */
  keys: string[];
  refs: string[];
  placements: number;
  declared: DeclaredFootprint;
  measured: Measurement | undefined;
  /** Set when the footprint could not be found in any library. */
  unresolved: boolean;
  /** False when the footprint has neither paste nor a hole: nothing to solder. */
  mountable: boolean;
  findings: FootprintFinding[];
};

/** Supplies pads for a footprint reference, or undefined if it cannot be found. */
export type PadSource = (reference: string) => readonly MeasuredPad[] | undefined;

/**
 * Audits every distinct footprint a BOM uses. Distinct, not per placement:
 * measuring `C_0603_1608Metric` 58 times would say the same thing 58 times.
 */
export function auditFootprints(lines: readonly AnalyzedLine[], pads: PadSource): FootprintAudit[] {
  const used = new Map<string, { keys: Set<string>; refs: string[] }>();
  for (const line of lines) {
    const reference = line.line.footprint.trim();
    if (reference === "") continue;
    const slot = used.get(reference) ?? { keys: new Set<string>(), refs: [] };
    slot.keys.add(line.key);
    slot.refs.push(...line.line.refs);
    used.set(reference, slot);
  }

  const audits: FootprintAudit[] = [];
  for (const [reference, slot] of used) {
    const declared = parseFootprintName(reference);
    const found = pads(reference);

    if (!found) {
      audits.push({
        reference,
        keys: [...slot.keys].sort(),
        refs: slot.refs,
        placements: slot.refs.length,
        declared,
        measured: undefined,
        unresolved: true,
        mountable: true, // unknown, so give it the benefit of the doubt
        findings: [
          {
            code: "pin-count-mismatch",
            severity: "warning",
            message: "footprint not found in any library — cannot verify it",
          },
        ],
      });
      continue;
    }

    const measured = measure(found);
    audits.push({
      reference,
      keys: [...slot.keys].sort(),
      refs: slot.refs,
      placements: slot.refs.length,
      declared,
      measured,
      unresolved: false,
      mountable: measured.mounting !== "nothing-to-solder",
      findings: checkFootprint(declared, measured),
    });
  }

  return audits.sort((a, b) => b.placements - a.placements);
}

export function countFootprintFindings(
  audits: readonly FootprintAudit[],
): Record<Severity, number> {
  const counts: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  for (const audit of audits) {
    for (const finding of audit.findings) counts[finding.severity] += 1;
  }
  return counts;
}
