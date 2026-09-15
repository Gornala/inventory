import { describe, expect, it } from "vitest";

import {
  analyzeLine,
  applyBuyChoices,
  applyMountability,
  notBoughtReason,
} from "../../src/core/parse/spec.js";
import type { BomLine } from "../../src/core/types.js";

function line(partial: Partial<BomLine>): BomLine {
  return {
    refs: ["R1"],
    value: "10k",
    footprint: "Resistor_SMD:R_0603_1608Metric",
    datasheet: undefined,
    description: undefined,
    quantity: partial.refs?.length ?? 1,
    dnp: false,
    fields: {},
    source: "test",
    ...partial,
  };
}

const codes = (l: BomLine): string[] => analyzeLine(l).issues.map((i) => i.code);

describe("analyzeLine: keys", () => {
  it("builds a generic key from class, value and package", () => {
    expect(analyzeLine(line({})).key).toBe("R|10k|0603");
  });

  it("builds a specific key from the value as written", () => {
    const l = line({
      refs: ["U1"],
      value: "RP2040",
      footprint: "Package_DFN_QFN:QFN-56-1EP_7x7mm_P0.4mm_EP3.2x3.2mm",
    });
    expect(analyzeLine(l).key).toBe("U|RP2040|QFN-56-1EP_7x7mm_P0.4mm_EP3.2x3.2mm");
  });

  it("ignores the land-pattern variant, which is the same purchase", () => {
    const plain = analyzeLine(
      line({ refs: ["C1"], value: "10u", footprint: "Capacitor_SMD:C_1210_3225Metric" }),
    );
    const hand = analyzeLine(
      line({
        refs: ["C2"],
        value: "10u",
        footprint: "Capacitor_SMD:C_1210_3225Metric_Pad1.33x2.70mm_HandSolder",
      }),
    );
    expect(hand.key).toBe(plain.key);
  });

  it("takes the class from the designator, not the footprint", () => {
    // an R on a capacitor footprint is a resistor with a bad footprint,
    // not a capacitor
    const l = line({ refs: ["R1"], value: "0", footprint: "Capacitor_SMD:C_0603_1608Metric" });
    expect(analyzeLine(l).spec.cls).toBe("resistor");
    expect(analyzeLine(l).key).toBe("R|0|0603");
  });
});

describe("analyzeLine: what is not a part", () => {
  it("leaves a test point out of the parts list", () => {
    const l = analyzeLine(
      line({ refs: ["TP1"], value: "TestPoint", footprint: "TestPoint:TestPoint_Pad_1.0x1.0mm" }),
    );
    expect(l.excluded).toMatch(/test point/);
  });

  it("leaves a mounting hole out", () => {
    const l = analyzeLine(
      line({ refs: ["MH1"], value: "MountingHole", footprint: "MountingHole:MountingHole_2.2mm" }),
    );
    expect(l.excluded).toMatch(/mounting hole/);
  });

  it("puts one back in when the designer named a real part", () => {
    // a screw-in standoff or a bought test jack is a purchase again
    const byValue = analyzeLine(
      line({ refs: ["MH1"], value: "R30-1002002", footprint: "MountingHole:MountingHole_2.2mm" }),
    );
    expect(byValue.excluded).toBeUndefined();

    const byField = analyzeLine(
      line({
        refs: ["TP1"],
        value: "TestPoint",
        footprint: "TestPoint:TestPoint_Pad_1.0x1.0mm",
        fields: { MPN: "5015" },
      }),
    );
    expect(byField.excluded).toBeUndefined();
  });

  it("keeps everything when asked to", () => {
    const l = analyzeLine(
      line({ refs: ["TP1"], value: "TestPoint", footprint: "TestPoint:TestPoint_Pad_1.0x1.0mm" }),
      { excludeClasses: [] },
    );
    expect(l.excluded).toBeUndefined();
  });

  it("does not exclude an ordinary part", () => {
    expect(analyzeLine(line({})).excluded).toBeUndefined();
  });
});

describe("measurement overrules the name", () => {
  const wuerth = line({
    refs: ["H1001", "H1002"],
    value: "MountingHole_Pad",
    footprint: "Mounting_Wuerth:Mounting_Wuerth_WA-SMSI-M2_H8mm_9774080243",
  });
  const plainHole = line({
    refs: ["H1007"],
    value: "MountingHole",
    footprint: "MountingHole:MountingHole_2.2mm_M2_DIN965",
  });
  const resistor = line({ refs: ["R1"], value: "10k" });

  it("rescues a part the naming rule wrongly dropped", () => {
    // an all-paste SMD standoff is a real purchase, MPN in the value or not
    const before = analyzeLine(wuerth);
    expect(before.excluded).toMatch(/mounting hole/);

    const [after] = applyMountability([before], () => true);
    expect(after?.excluded).toBeUndefined();
  });

  it("drops one the naming rule would have kept", () => {
    const [after] = applyMountability([analyzeLine(resistor)], () => false);
    expect(after?.excluded).toMatch(/nothing to solder/);
  });

  it("leaves the guess alone when nothing could be measured", () => {
    const [hole] = applyMountability([analyzeLine(plainHole)], () => undefined);
    expect(hole?.excluded).toMatch(/mounting hole/);
  });

  it("keeps the more specific reason when both agree", () => {
    const [hole] = applyMountability([analyzeLine(plainHole)], () => false);
    expect(hole?.excluded).toMatch(/mounting hole/); // not the geometry wording
  });
});

describe("analyzeLine: issues", () => {
  it("flags a footprint from the wrong class", () => {
    expect(codes(line({ refs: ["R1"], footprint: "Capacitor_SMD:C_0603_1608Metric" }))).toContain(
      "class-mismatch",
    );
  });

  it("treats a swapped chip land pattern as a warning, not an error", () => {
    // measured against the KiCad 10 libraries, R_0603 and C_0603 have an
    // identical 2.45 mm outer span: it solders, the 3D model is just wrong
    const swapped = analyzeLine(
      line({ refs: ["R1"], value: "0", footprint: "Capacitor_SMD:C_0603_1608Metric" }),
    ).issues.find((i) => i.code === "class-mismatch");
    expect(swapped?.severity).toBe("warning");
    expect(swapped?.message).toContain("solder");
  });

  it("keeps a genuinely wrong footprint an error", () => {
    // a resistor on an 8-pin SOIC is not a 3D-model quibble
    const wrong = analyzeLine(
      line({ refs: ["R1"], value: "10k", footprint: "Package_SO:SOIC-8_3.9x4.9mm_P1.27mm" }),
    ).issues.find((i) => i.code === "class-mismatch");
    expect(wrong?.severity).toBe("error");
  });

  it("stays quiet within the semiconductor family", () => {
    // SOT-23-6 is an everyday package for regulators, transistors and small ICs
    expect(
      codes(line({ refs: ["U1"], value: "RT9013", footprint: "Package_TO_SOT_SMD:SOT-23-6" })),
    ).toHaveLength(0);
    expect(
      codes(line({ refs: ["Q1"], value: "BC847", footprint: "Package_TO_SOT_SMD:SOT-23" })),
    ).toHaveLength(0);
  });

  it("flags a value that is just the designator letter", () => {
    expect(codes(line({ refs: ["R1"], value: "R" }))).toContain("placeholder-value");
    expect(
      codes(line({ refs: ["C1"], value: "C", footprint: "Capacitor_SMD:C_0603_1608Metric" })),
    ).toContain("placeholder-value");
  });

  it("flags a capacitor with no unit, but not a resistor", () => {
    expect(
      codes(line({ refs: ["C1"], value: "100", footprint: "Capacitor_SMD:C_0603_1608Metric" })),
    ).toContain("ambiguous-bare-value");
    expect(codes(line({ refs: ["R1"], value: "100" }))).toHaveLength(0);
  });

  it("flags a passive whose value cannot be read", () => {
    expect(codes(line({ refs: ["R1"], value: "TBD" }))).toContain("unparsable-value");
    expect(codes(line({ refs: ["C1"], value: "???" }))).toContain("unparsable-value");
  });

  it("treats a part number in the value as an answer, not a defect", () => {
    // real values from the reference board: someone already resolved these
    for (const mpn of ["IHLP6767GZER100M01", "KTF350B226M55NHT00", "160uH 7447709151"]) {
      const analyzed = analyzeLine(
        line({ refs: ["L1"], value: mpn, footprint: "Inductor_SMD:L_1210" }),
      );
      expect(analyzed.issues.map((i) => i.code)).toContain("pre-resolved");
      expect(analyzed.issues.every((i) => i.severity === "info")).toBe(true);
      expect(analyzed.spec.kind).toBe("specific");
      expect(analyzed.resolved).toBe(true);
    }
  });

  it("flags a missing footprint", () => {
    expect(codes(line({ footprint: "" }))).toContain("missing-footprint");
  });

  it("flags a quantity that disagrees with the reference list", () => {
    expect(codes(line({ refs: ["R1", "R2"], quantity: 3 }))).toContain("quantity-mismatch");
  });

  it("says nothing about a well-formed line", () => {
    expect(codes(line({}))).toHaveLength(0);
  });
});

describe("your decision overrules both rules", () => {
  const resistor = analyzeLine(line({}));
  const testPoint = analyzeLine(
    line({ refs: ["TP1"], value: "TestPoint", footprint: "TestPoint:TestPoint_Pad_1.0x1.0mm" }),
  );

  it("takes a part you buy out of the list", () => {
    const [after] = applyBuyChoices([resistor], () => false);
    expect(after?.excluded).toBe(notBoughtReason);
  });

  it("puts one the rules dropped back in", () => {
    expect(testPoint.excluded).toMatch(/test point/);
    const [after] = applyBuyChoices([testPoint], () => true);
    expect(after?.excluded).toBeUndefined();
  });

  it("says it was you, not the board, that left it out", () => {
    // the "Not bought" tab groups by reason, so a decision of yours reads as
    // one rather than hiding among the board features
    const [after] = applyBuyChoices([testPoint], () => false);
    expect(after?.excluded).toBe(notBoughtReason);
  });

  it("leaves a part with no decision to the rules", () => {
    const [kept, dropped] = applyBuyChoices([resistor, testPoint], () => undefined);
    expect(kept?.excluded).toBeUndefined();
    expect(dropped?.excluded).toMatch(/test point/);
  });

  it("decides by key, so every line of one part goes together", () => {
    const second = analyzeLine(line({ refs: ["R2"] }));
    expect(second.key).toBe(resistor.key);
    const after = applyBuyChoices([resistor, second], (key) => key !== resistor.key);
    expect(after.map((l) => l.excluded)).toEqual([notBoughtReason, notBoughtReason]);
  });
});
