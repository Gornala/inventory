import { describe, expect, it } from "vitest";

import { canonicalKey, searchLabel } from "../../src/core/canonical.js";
import { analyzeLine } from "../../src/core/parse/spec.js";
import type { BomLine, Spec } from "../../src/core/types.js";

function line(partial: Partial<BomLine>): BomLine {
  return {
    refs: ["R1"],
    value: "10k",
    footprint: "Resistor_SMD:R_0603_1608Metric",
    datasheet: undefined,
    description: undefined,
    quantity: 1,
    dnp: false,
    fields: {},
    source: "test",
    ...partial,
  };
}

/** What a board line ends up called in a distributor's search box. */
const labelOf = (partial: Partial<BomLine>): string => searchLabel(analyzeLine(line(partial)).spec);

/**
 * The label a part is searched for by.
 *
 * `C|100n|0402` is the right join key and the wrong thing to type into a
 * distributor's search box. These are their words, and the point of the
 * exercise is that pasting one finds the part.
 */
describe("the distributor's own wording", () => {
  it("writes a capacitor the way a catalogue lists it", () => {
    expect(
      labelOf({ refs: ["C1"], value: "100n", footprint: "Capacitor_SMD:C_0402_1005Metric" }),
    ).toBe("CAP CER 0.1UF 0402");
  });

  it("writes a resistor the way a catalogue lists it", () => {
    expect(
      labelOf({ refs: ["R1"], value: "5k62", footprint: "Resistor_SMD:R_0603_1608Metric" }),
    ).toBe("RES 5.62K OHM 0603");
  });

  it("writes an inductor the way a catalogue lists it", () => {
    expect(
      labelOf({ refs: ["L1"], value: "150u", footprint: "Inductor_SMD:L_0805_2012Metric" }),
    ).toBe("FIXED IND 150UH 0805");
  });

  describe("capacitance changes unit where the catalogues change it", () => {
    const cap = (value: string): string =>
      labelOf({ refs: ["C1"], value, footprint: "Capacitor_SMD:C_0402_1005Metric" });

    it("is picofarads below 10 nF, because nobody lists a 100NF part", () => {
      expect(cap("22p")).toBe("CAP CER 22PF 0402");
      expect(cap("1n")).toBe("CAP CER 1000PF 0402");
      expect(cap("4n7")).toBe("CAP CER 4700PF 0402");
    });

    it("is microfarads from 10 nF up", () => {
      expect(cap("10n")).toBe("CAP CER 0.01UF 0402");
      expect(cap("1u")).toBe("CAP CER 1UF 0402");
      expect(cap("4u7")).toBe("CAP CER 4.7UF 0402"); // and not 4.700000000000001
    });
  });

  describe("resistance carries a prefix upwards and none downwards", () => {
    const res = (value: string): string =>
      labelOf({ refs: ["R1"], value, footprint: "Resistor_SMD:R_0603_1608Metric" });

    it("uses K and M above an ohm", () => {
      expect(res("10k")).toBe("RES 10K OHM 0603");
      expect(res("1M")).toBe("RES 1M OHM 0603");
      expect(res("100")).toBe("RES 100 OHM 0603");
    });

    it("writes a milliohm shunt out in full, because 5M OHM is a million times wrong", () => {
      expect(res("5m")).toBe("RES 0.005 OHM 0603");
      expect(res("0R1")).toBe("RES 0.1 OHM 0603");
    });

    it("keeps a 0 Ω jumper a jumper", () => {
      expect(res("0")).toBe("RES 0 OHM 0603");
    });
  });

  it("gives the ohm-measured classes their own words", () => {
    expect(
      labelOf({ refs: ["FB1"], value: "600", footprint: "Inductor_SMD:L_0603_1608Metric" }),
    ).toBe("FERRITE BEAD 600 OHM 0603");
    // NTC or PTC is not something the board says, so the label does not either
    expect(
      labelOf({ refs: ["TH1"], value: "10k", footprint: "Resistor_SMD:R_0402_1005Metric" }),
    ).toBe("THERMISTOR 10K OHM 0402");
  });

  it("leaves a specific part as the search term it already is", () => {
    expect(
      labelOf({
        refs: ["U1"],
        value: "RP2040",
        footprint: "Package_DFN_QFN:QFN-56-1EP_7x7mm_P0.4mm_EP3.2x3.2mm",
      }),
    ).toBe("RP2040");
  });

  it("leaves the package out when the board never said one", () => {
    const spec: Spec = {
      kind: "generic",
      cls: "inductor",
      magnitude: 150e-6,
      unit: "henry",
      pkg: undefined,
      variant: undefined,
    };
    expect(searchLabel(spec)).toBe("FIXED IND 150UH");
  });

  it("is a label and never an identity", () => {
    // two spellings of one part share a key, and so share a label; nothing is
    // ever filed under the label itself
    const a = analyzeLine(line({ refs: ["C1"], value: "100n" })).spec;
    const b = analyzeLine(line({ refs: ["C2"], value: "0.1uF" })).spec;
    expect(canonicalKey(a)).toBe(canonicalKey(b));
    expect(searchLabel(a)).toBe(searchLabel(b));
  });
});
