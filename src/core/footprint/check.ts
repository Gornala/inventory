import type { Severity } from "../types.js";
import type { Measurement } from "./measure.js";
import { chipSizes, type DeclaredFootprint } from "./name.js";

export type FootprintFindingCode =
  | "pitch-mismatch"
  | "pin-count-mismatch"
  | "exposed-pad-missing"
  | "extra-thermal-pad"
  | "mounting-mismatch"
  | "symbol-pin-mismatch"
  | "body-vs-pads";

export type FootprintFinding = {
  code: FootprintFindingCode;
  severity: Severity;
  message: string;
};

/**
 * Pitch and pad count are exact facts and disagreeing about them is an error.
 * Absolute sizes are advisory: a land pattern is deliberately larger than the
 * package body by an IPC-density-dependent margin, so comparing "body 7 mm" to
 * "pads span 7.9 mm" and calling it a defect produces a checker nobody trusts.
 */
const pitchTolerance = 0.02; // mm — generous against rounding in names

export function checkFootprint(
  declared: DeclaredFootprint,
  measured: Measurement,
): FootprintFinding[] {
  const findings: FootprintFinding[] = [];

  if (declared.pitch !== undefined && measured.pitch !== undefined) {
    const delta = Math.abs(declared.pitch - measured.pitch);
    if (delta > pitchTolerance) {
      findings.push({
        code: "pitch-mismatch",
        severity: "error",
        message:
          `name says ${declared.pitch} mm pitch, pads measure ` +
          `${measured.pitch.toFixed(3)} mm (${delta.toFixed(3)} mm out)`,
      });
    }
  }

  if (declared.pinCount !== undefined) {
    // Distinct numbers, not pad instances: a power MOSFET spreads one drain
    // across several pads that all carry the same number.
    const signal = measured.distinctPads - measured.exposedPads.length;
    if (signal === declared.pinCount + 1) {
      // The conventional layout for a thermal pad given a pin number of its
      // own: USON-8 with a ninth centre pad. True, and not a defect.
      findings.push({
        code: "extra-thermal-pad",
        severity: "info",
        message:
          `name says ${declared.pinCount} pins and there are ${signal} numbered pads — ` +
          `the extra one is normally a thermal pad numbered as a pin`,
      });
    } else if (signal !== declared.pinCount) {
      findings.push({
        code: "pin-count-mismatch",
        severity: "error",
        message:
          `name says ${declared.pinCount} pins, footprint has ${signal} numbered pads` +
          (measured.exposedPads.length > 0 ? ` plus ${measured.exposedPads.length} exposed` : ""),
      });
    }
  }

  if (declared.exposedPad !== undefined && measured.exposedPads.length === 0) {
    findings.push({
      code: "exposed-pad-missing",
      severity: "error",
      message: "name claims an exposed pad, none measured",
    });
  }
  // There is deliberately no "unexpected exposed pad" finding. Large pads are
  // ordinary: MOSFET drain paddles, USB shield tabs, connector mounting ears.
  // Without the symbol's pins there is no way to tell intent, and reporting it
  // produced six findings on the reference board, none of them defects.

  // Advisory only, and only for chip packages, where the nominal body size is
  // a fixed number rather than an IPC allowance.
  const nominal = declared.chip ? chipSizes[declared.chip.imperial] : undefined;
  if (nominal && measured.span.x > 0) {
    if (measured.span.x < nominal.x) {
      findings.push({
        code: "body-vs-pads",
        severity: "warning",
        message:
          `pads span ${measured.span.x} mm across, narrower than the ` +
          `${nominal.x} mm nominal ${declared.chip?.imperial ?? ""} body`,
      });
    }
  }

  return findings;
}

/** Symbol pins against footprint pads — needs no footprint library at all. */
export function checkPinNumbers(
  symbolPins: readonly string[],
  padNumbers: readonly string[],
): FootprintFinding[] {
  if (symbolPins.length === 0 || padNumbers.length === 0) return [];

  const pads = new Set(padNumbers);
  const missing = [...new Set(symbolPins)].filter((p) => !pads.has(p));
  if (missing.length === 0) return [];

  return [
    {
      code: "symbol-pin-mismatch",
      severity: "error",
      message:
        `${missing.length} symbol pin(s) have no matching pad: ` +
        missing.slice(0, 8).join(", ") +
        (missing.length > 8 ? " …" : ""),
    },
  ];
}
