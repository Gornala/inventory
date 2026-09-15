import { describe, expect, it } from "vitest";

import type { PartRollup } from "../../src/core/consolidate/findings.js";
import { normalisePackage, packageIssues } from "../../src/core/inventory/package-check.js";
import type { CatalogPart, Resolution } from "../../src/core/inventory/types.js";

function part(key: string, pkg: string, refs = ["R1"]): PartRollup {
  return {
    key,
    label: `RES 10K OHM ${pkg}`,
    cls: "resistor",
    value: "10k",
    pkg,
    placements: refs.length,
    refs,
    sources: [],
    issueCount: 0,
    resolved: false,
    fields: {},
  };
}

function bought(key: string, mpn: string, pkg?: string): Resolution {
  const catalogPart: CatalogPart = {
    id: mpn.toLowerCase(),
    mpn,
    manufacturer: "",
    ...(pkg === undefined ? {} : { package: pkg }),
    addedAt: "2026-09-08T00:00:00.000Z",
  };
  return {
    key,
    assignment: { key, partId: catalogPart.id, decidedAt: "x", by: "user" },
    part: catalogPart,
    suggestedMpn: undefined,
  };
}

describe("naming a package the same way twice", () => {
  it("folds the ways people write a chip size", () => {
    // the board's side comes out of a footprint name; yours is typed
    expect(normalisePackage("0603")).toBe("0603");
    expect(normalisePackage(" 0603 ")).toBe("0603");
    expect(normalisePackage("R0603")).toBe("0603");
    expect(normalisePackage("C0603")).toBe("0603");
  });

  it("knows the metric twin of an imperial code", () => {
    // 1608 is 1.6 × 0.8 mm, which is what 0603 is — people write either
    expect(normalisePackage("1608")).toBe("0603");
    expect(normalisePackage("1608Metric")).toBe("0603");
    expect(normalisePackage("2012")).toBe("0805");
    expect(normalisePackage("1005")).toBe("0402");
  });

  it("leaves anything that is not a chip code as written", () => {
    // there is no table for these, so they are compared as typed
    expect(normalisePackage("SOIC-8")).toBe("soic-8");
    expect(normalisePackage("QFN-56")).toBe("qfn-56");
    expect(normalisePackage("")).toBe("");
  });
});

describe("the part you buy against the pads on the board", () => {
  it("catches an 0603 part bought for an 0402 land pattern", () => {
    const issues = packageIssues(
      [part("R|10k|0402", "0402", ["R1", "R2"])],
      [bought("R|10k|0402", "RC0603FR-0710KL", "0603")],
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe("package-mismatch");
    expect(issues[0]?.severity).toBe("error");
    expect(issues[0]?.message).toContain("will not fit the pads");
    // and it says where to go and look
    expect(issues[0]?.refs).toEqual(["R1", "R2"]);
  });

  it("says nothing when they agree, however they are spelled", () => {
    expect(
      packageIssues([part("R|10k|0603", "0603")], [bought("R|10k|0603", "AAA-1", "1608Metric")]),
    ).toEqual([]);
  });

  it("says nothing about a package you have not recorded", () => {
    // a blank means "you did not say", not "it is fine": the check that
    // guesses is worse than the check that waits
    expect(packageIssues([part("R|10k|0402", "0402")], [bought("R|10k|0402", "AAA-1")])).toEqual(
      [],
    );
    expect(
      packageIssues([part("R|10k|0402", "0402")], [bought("R|10k|0402", "AAA-1", "  ")]),
    ).toEqual([]);
  });

  it("says nothing about a part with no MPN yet", () => {
    expect(
      packageIssues(
        [part("R|10k|0402", "0402")],
        [{ key: "R|10k|0402", assignment: undefined, part: undefined, suggestedMpn: undefined }],
      ),
    ).toEqual([]);
  });

  it("compares packages it has no table for, as written", () => {
    expect(
      packageIssues(
        [part("U|RP2040|QFN-56", "QFN-56")],
        [bought("U|RP2040|QFN-56", "RP2040", "QFN-56")],
      ),
    ).toEqual([]);
    expect(
      packageIssues(
        [part("U|RP2040|QFN-56", "QFN-56")],
        [bought("U|RP2040|QFN-56", "RP2040", "SOIC-8")],
      ),
    ).toHaveLength(1);
  });

  it("says nothing when the board's own package is unknown", () => {
    // `?` is what a line with no footprint keys as; there is nothing to compare
    expect(packageIssues([part("R|10k|?", "?")], [bought("R|10k|?", "AAA-1", "0402")])).toEqual([]);
  });
});
