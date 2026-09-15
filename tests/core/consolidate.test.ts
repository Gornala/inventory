import { describe, expect, it } from "vitest";

import {
  compareColumns,
  consolidate,
  partsByKey,
  type Finding,
} from "../../src/core/consolidate/findings.js";
import { analyzeBom } from "../../src/core/parse/spec.js";
import type { BomLine } from "../../src/core/types.js";

function bom(...rows: Array<Partial<BomLine> & { refs: string[] }>): BomLine[] {
  return rows.map((r) => ({
    value: "10k",
    footprint: "Resistor_SMD:R_0603_1608Metric",
    datasheet: undefined,
    description: undefined,
    quantity: r.refs.length,
    dnp: false,
    fields: {},
    source: "test",
    ...r,
  }));
}

function findingsOf(lines: BomLine[], percent?: number): Finding[] {
  return consolidate(analyzeBom(lines), percent === undefined ? {} : { nearValuePercent: percent });
}

function kinds(findings: Finding[], kind: Finding["kind"]): Finding[] {
  return findings.filter((f) => f.kind === kind);
}

describe("duplicate spellings", () => {
  it("reports two spellings of one part and the lines it saves", () => {
    const found = kinds(
      findingsOf(
        bom(
          { refs: ["C1", "C2"], value: "100n", footprint: "Capacitor_SMD:C_0603_1608Metric" },
          { refs: ["C3"], value: "100nF", footprint: "Capacitor_SMD:C_0603_1608Metric" },
        ),
      ),
      "duplicate-spelling",
    );
    expect(found).toHaveLength(1);
    const f = found[0];
    if (f?.kind !== "duplicate-spelling") throw new Error("wrong kind");
    expect(f.key).toBe("C|100n|0603");
    expect(f.linesSaved).toBe(1);
    expect(f.placements).toBe(3);
    expect(f.spellings.map((s) => s.value)).toEqual(["100n", "100nF"]); // most used first
  });

  it("says nothing when one spelling is used consistently", () => {
    const found = findingsOf(bom({ refs: ["R1", "R2"], value: "10k" }));
    expect(kinds(found, "duplicate-spelling")).toHaveLength(0);
  });
});

describe("one value in several packages", () => {
  it("groups by package and suggests the most used one", () => {
    const found = kinds(
      findingsOf(
        bom(
          { refs: ["R1", "R2", "R3"], value: "10k", footprint: "Resistor_SMD:R_0402_1005Metric" },
          { refs: ["R4"], value: "10k", footprint: "Resistor_SMD:R_0603_1608Metric" },
        ),
      ),
      "multi-package",
    );
    const f = found[0];
    if (f?.kind !== "multi-package") throw new Error("wrong kind");
    expect(f.value).toBe("10k");
    expect(f.suggested).toBe("0402");
    expect(f.tied).toBe(false);
    expect(f.linesSaved).toBe(1);
    expect(f.groups.map((g) => `${g.pkg}×${g.placements}`)).toEqual(["0402×3", "0603×1"]);
  });

  it("admits when it has no basis to prefer a size", () => {
    const found = kinds(
      findingsOf(
        bom(
          { refs: ["R1", "R2"], value: "10", footprint: "Resistor_SMD:R_0402_1005Metric" },
          { refs: ["R3", "R4"], value: "10", footprint: "Resistor_SMD:R_0805_2012Metric" },
        ),
      ),
      "multi-package",
    );
    const f = found[0];
    if (f?.kind !== "multi-package") throw new Error("wrong kind");
    expect(f.tied).toBe(true);
  });

  it("does not compare packages across different classes", () => {
    const found = findingsOf(
      bom(
        { refs: ["R1"], value: "10", footprint: "Resistor_SMD:R_0402_1005Metric" },
        { refs: ["C1"], value: "10u", footprint: "Capacitor_SMD:C_0805_2012Metric" },
      ),
    );
    expect(kinds(found, "multi-package")).toHaveLength(0);
  });
});

describe("near values", () => {
  it("catches values a couple of percent apart", () => {
    const found = kinds(
      findingsOf(
        bom(
          { refs: ["R1"], value: "1k" },
          { refs: ["R2"], value: "1.02k" },
          { refs: ["R3"], value: "10k" },
        ),
      ),
      "near-value",
    );
    expect(found).toHaveLength(1);
    const f = found[0];
    if (f?.kind !== "near-value") throw new Error("wrong kind");
    expect(f.members.map((m) => m.value)).toEqual(["1k", "1.02k"]);
    expect(f.spreadPercent).toBeCloseTo(2, 1);
  });

  it("chains a run of close values into one finding", () => {
    // the reference board's 49.9k / 50k / 51k
    const found = kinds(
      findingsOf(
        bom(
          { refs: ["R1"], value: "49.9k" },
          { refs: ["R2"], value: "50k" },
          { refs: ["R3"], value: "51k" },
        ),
      ),
      "near-value",
    );
    expect(found).toHaveLength(1);
    const f = found[0];
    if (f?.kind !== "near-value") throw new Error("wrong kind");
    expect(f.members).toHaveLength(3);
    expect(f.spreadPercent).toBeCloseTo(2.2, 1);
  });

  it("respects the tolerance it is given", () => {
    const lines = bom({ refs: ["R1"], value: "10k" }, { refs: ["R2"], value: "11k" });
    expect(kinds(findingsOf(lines, 2), "near-value")).toHaveLength(0);
    expect(kinds(findingsOf(lines, 15), "near-value")).toHaveLength(1);
  });

  it("does not treat one value in two packages as a near value", () => {
    const found = findingsOf(
      bom(
        { refs: ["R1"], value: "10k", footprint: "Resistor_SMD:R_0402_1005Metric" },
        { refs: ["R2"], value: "10k", footprint: "Resistor_SMD:R_0603_1608Metric" },
      ),
    );
    expect(kinds(found, "near-value")).toHaveLength(0);
    expect(kinds(found, "multi-package")).toHaveLength(1);
  });

  it("ignores 0R, which has no meaningful neighbourhood", () => {
    const found = findingsOf(bom({ refs: ["R1"], value: "0" }, { refs: ["R2"], value: "1" }));
    expect(kinds(found, "near-value")).toHaveLength(0);
  });
});

describe("singletons", () => {
  it("reports a generic value used once", () => {
    const found = kinds(
      findingsOf(bom({ refs: ["R1"], value: "82k" }, { refs: ["R2", "R3"], value: "10k" })),
      "singleton",
    );
    expect(found).toHaveLength(1);
    const f = found[0];
    if (f?.kind !== "singleton") throw new Error("wrong kind");
    expect(f.ref).toBe("R1");
  });

  it("ignores specific parts — one MCU on a board is not a finding", () => {
    const found = kinds(
      findingsOf(
        bom({
          refs: ["U1"],
          value: "RP2040",
          footprint: "Package_DFN_QFN:QFN-56-1EP_7x7mm_P0.4mm_EP3.2x3.2mm",
        }),
      ),
      "singleton",
    );
    expect(found).toHaveLength(0);
  });
});

describe("mixed footprints", () => {
  it("reports one part reached through two footprints", () => {
    const found = kinds(
      findingsOf(
        bom(
          { refs: ["R1"], value: "0", footprint: "Resistor_SMD:R_0603_1608Metric" },
          { refs: ["R2"], value: "0", footprint: "Capacitor_SMD:C_0603_1608Metric" },
        ),
      ),
      "mixed-footprint",
    );
    expect(found).toHaveLength(1);
  });
});

describe("the BOM's own columns, per part", () => {
  it("carries every field a part's lines mention", () => {
    const [part] = partsByKey(
      analyzeBom(
        bom({
          refs: ["C1"],
          value: "100n",
          footprint: "Capacitor_SMD:C_0603_1608Metric",
          description: "Unpolarized capacitor",
          fields: { Volrtage: "50V", Tolerance: "10%" },
        }),
      ),
    );
    expect(part?.fields).toEqual({
      Tolerance: "10%",
      Volrtage: "50V",
      Description: "Unpolarized capacitor",
    });
  });

  it("keeps both values when two spellings of one part disagree", () => {
    // 100n and 100nF merge into one purchase, and only one of them was ever
    // given a voltage. Picking a winner would hide the inconsistency that made
    // the two lines worth merging in the first place.
    const [part] = partsByKey(
      analyzeBom(
        bom(
          { refs: ["C1", "C2"], value: "100n", footprint: "Capacitor_SMD:C_0603_1608Metric" },
          {
            refs: ["C3"],
            value: "100nF",
            footprint: "Capacitor_SMD:C_0603_1608Metric",
            fields: { Volrtage: "50V" },
          },
          {
            refs: ["C4"],
            value: "100N",
            footprint: "Capacitor_SMD:C_0603_1608Metric",
            fields: { Volrtage: "16V" },
          },
        ),
      ),
    );
    expect(part?.fields["Volrtage"]).toBe("50V · 16V");
  });

  it("drops a field nobody filled in", () => {
    const [part] = partsByKey(analyzeBom(bom({ refs: ["R1"], fields: { MPN: "   " } })));
    expect(part?.fields).toEqual({});
  });

  it("orders the columns with the prose last", () => {
    // custom fields are what a designer maintains and reads first; Description
    // and Datasheet are long and belong at the far end of the row
    expect(
      ["Datasheet", "Volrtage", "Description", "capacity", "Capacity"].sort(compareColumns),
    ).toEqual(["Capacity", "capacity", "Volrtage", "Description", "Datasheet"]);
  });
});
