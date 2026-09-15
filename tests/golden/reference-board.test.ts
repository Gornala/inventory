import { describe, expect, it } from "vitest";

import { readBomCsv } from "../../src/adapters/kicad/bom.js";
import { consolidate, type Finding } from "../../src/core/consolidate/findings.js";
import { analyzeBom } from "../../src/core/parse/spec.js";
import type { AnalyzedLine } from "../../src/core/types.js";
import { fixture } from "../fixtures/index.js";

const lines = analyzeBom(readBomCsv(fixture("kicad10", "transformer_test.bom.csv")));
const findings = consolidate(lines);

function ofKind<K extends Finding["kind"]>(kind: K): Extract<Finding, { kind: K }>[] {
  return findings.filter((f): f is Extract<Finding, { kind: K }> => f.kind === kind);
}

function withKey(key: string): AnalyzedLine[] {
  return lines.filter((l) => l.key === key);
}
function issues(code: string): AnalyzedLine[] {
  return lines.filter((l) => l.issues.some((i) => i.code === code));
}
function placements(ls: AnalyzedLine[]): number {
  return ls.reduce((n, l) => n + l.line.refs.length, 0);
}

describe("reference board: reading", () => {
  it("reads every grouped line", () => {
    expect(lines).toHaveLength(100);
  });

  it("expands reference ranges back to individual placements", () => {
    // 354 purchasable placements. The schematics hold 646 symbols in total;
    // the difference is power symbols, GND and parts excluded from the BOM.
    expect(placements(lines)).toBe(354);
  });

  it("agrees with the quantity KiCad exported on every line", () => {
    expect(issues("quantity-mismatch")).toHaveLength(0);
  });

  it("reads DNP without comparing against localised text", () => {
    // the export says "Nicht bestücken" on this machine
    const dnp = lines.filter((l) => l.line.dnp);
    expect(placements(dnp)).toBeGreaterThan(0);
    expect(dnp.some((l) => l.line.refs.includes("R2004"))).toBe(true);
  });
});

describe("reference board: consolidation findings", () => {
  it("merges 100n and 100nF into one part", () => {
    const found = withKey("C|100n|0603");
    expect(found.map((l) => l.line.value).sort()).toEqual(["100n", "100nF"]);
    expect(placements(found)).toBe(58); // 54 + 4, previously two BOM lines
  });

  it("merges 10u and 10uF into one part", () => {
    const found = withKey("C|10u|0805");
    expect(found.map((l) => l.line.value).sort()).toEqual(["10u", "10uF"]);
    expect(placements(found)).toBe(18); // 15 + 3
  });

  it("merges 5K6 and 5k6, which differ only in letter case", () => {
    const found = withKey("R|5.6k|0603");
    expect(found.map((l) => l.line.value).sort()).toEqual(["5K6", "5k6"]);
    expect(placements(found)).toBe(6); // 5 + 1
  });

  it("keeps one value in different packages apart, so it can be reported", () => {
    expect(placements(withKey("R|10k|0402"))).toBe(19);
    expect(placements(withKey("R|10k|0603"))).toBe(3);
    expect(placements(withKey("R|1k|0402"))).toBe(12);
    expect(placements(withKey("R|1k|0603"))).toBe(2);
  });

  it("does not merge the milliohm shunts, which are genuinely different", () => {
    expect(placements(withKey("R|100m|1206"))).toBe(1); // "0.1"
    expect(placements(withKey("R|10m|2512"))).toBe(1); // "10m"
    expect(placements(withKey("R|2m|2512"))).toBe(1);
    expect(placements(withKey("R|5m|2512"))).toBe(1);
  });

  it("merges 2u2 and 2U2 — a duplicate that is invisible by eye", () => {
    const found = withKey("C|2.2u|0603");
    expect(found.map((l) => l.line.value).sort()).toEqual(["2U2", "2u2"]);
    expect(placements(found)).toBe(11); // 8 + 3
  });

  it("buys one 0R part for the jumpers, even across two footprints", () => {
    // 0R on C_0603 and on R_0603 is the same purchase; the footprint error on
    // the first group is reported separately as a class mismatch.
    const found = withKey("R|0|0603");
    expect(found).toHaveLength(2);
    expect(placements(found)).toBe(10);
  });

  it("cuts the part count by consolidating spellings", () => {
    const keys = new Set(lines.map((l) => l.key));
    expect(lines.length).toBe(100);
    expect(keys.size).toBe(95); // five pairs of BOM lines were one part each
  });
});

describe("reference board: defect findings", () => {
  it("catches every resistor wearing a capacitor footprint", () => {
    const mismatched = issues("class-mismatch");
    const refs = mismatched.flatMap((l) => l.line.refs);
    expect(refs).toHaveLength(20);
    // a warning, not an error: same-size chip land patterns are interchangeable
    expect(
      mismatched.every((l) =>
        l.issues.every((i) => i.code !== "class-mismatch" || i.severity === "warning"),
      ),
    ).toBe(true);
    expect(refs).toContain("R2004");
    expect(refs).toContain("R4014");
    expect(refs).toContain("R5007");
  });

  it("does not flag a regulator in a SOT package as a transistor", () => {
    const falsePositives = issues("class-mismatch").filter((l) =>
      l.line.footprint.includes("Package_TO_SOT_SMD"),
    );
    expect(falsePositives).toHaveLength(0);
  });

  it("does not cry wolf over bare resistor values", () => {
    // the board has bare 0, 1, 4, 10 — all on resistors, where a bare number
    // means ohms and is perfectly clear. Ambiguity is a capacitor problem.
    const ambiguous = issues("ambiguous-bare-value");
    expect(ambiguous.every((l) => l.spec.cls !== "resistor")).toBe(true);
    expect(ambiguous).toHaveLength(0);
  });

  it("reads part numbers already in the value field as answers, not defects", () => {
    const mpns = issues("pre-resolved");
    expect(mpns.flatMap((l) => l.line.refs)).toEqual(
      expect.arrayContaining(["L4003", "L6001", "L7001", "L11001", "C5006"]),
    );
    expect(mpns.every((l) => l.spec.kind === "specific")).toBe(true);
    expect(mpns.every((l) => l.resolved)).toBe(true);
  });

  it("summarises the board without surprises", () => {
    const byCode: Record<string, number> = {};
    const bySeverity: Record<string, number> = {};
    for (const line of lines) {
      for (const issue of line.issues) {
        byCode[issue.code] = (byCode[issue.code] ?? 0) + 1;
        bySeverity[issue.severity] = (bySeverity[issue.severity] ?? 0) + 1;
      }
    }
    expect({ byCode, bySeverity }).toMatchSnapshot();
  });
});

describe("reference board: the consolidation report", () => {
  it("offers four free merges", () => {
    const merges = ofKind("duplicate-spelling");
    expect(merges.map((f) => f.key).sort()).toEqual([
      "C|100n|0603",
      "C|10u|0805",
      "C|2.2u|0603",
      "R|5.6k|0603",
    ]);
    expect(merges.reduce((n, f) => n + f.linesSaved, 0)).toBe(4);
  });

  it("finds the 10k spread across two packages — the original question", () => {
    const tenK = ofKind("multi-package").find((f) => f.value === "10k" && f.cls === "resistor");
    expect(tenK?.groups.map((g) => `${g.pkg}x${g.placements}`)).toEqual(["0402x19", "0603x3"]);
    expect(tenK?.suggested).toBe("0402");
    expect(tenK?.tied).toBe(false);
  });

  it("finds every value bought in more than one size", () => {
    expect(
      ofKind("multi-package")
        .map((f) => f.value)
        .sort(),
    ).toEqual(["0", "10", "10k", "10n", "1k", "33n"]);
  });

  it("does not pretend to choose when two sizes are equally common", () => {
    const ten = ofKind("multi-package").find((f) => f.value === "10" && f.cls === "resistor");
    expect(ten?.tied).toBe(true); // 0402 x4 and 0805 x4
  });

  it("catches the 49.9k / 50k / 51k trio", () => {
    const near = ofKind("near-value");
    expect(near).toHaveLength(1);
    expect(near[0]?.members.map((m) => m.value)).toEqual(["49.9k", "50k", "51k"]);
    expect(near[0]?.spreadPercent).toBeCloseTo(2.2, 1);
    expect(near[0]?.members.flatMap((m) => m.refs).sort()).toEqual(["R11001", "R7016", "R7018"]);
  });

  it("lists only substitutable singletons, not every part used once", () => {
    const single = ofKind("singleton");
    expect(single).toHaveLength(22);
    // 51 keys are used once; the other 29 are ICs, connectors and modules
    expect(single.every((f) => f.cls !== "ic" && f.cls !== "connector")).toBe(true);
  });

  it("summarises the findings without surprises", () => {
    const byKind: Record<string, number> = {};
    for (const f of findings) byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;
    expect(byKind).toMatchSnapshot();
  });
});
