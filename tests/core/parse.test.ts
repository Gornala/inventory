import { describe, expect, it } from "vitest";

import { packageOf, parseFootprint } from "../../src/core/parse/footprint.js";
import { classOfRef, expandRefs, parseRef } from "../../src/core/parse/refdes.js";

describe("expandRefs", () => {
  it("expands the ranges kicad-cli emits", () => {
    expect(expandRefs("C6001-C6004")).toEqual(["C6001", "C6002", "C6003", "C6004"]);
  });

  it("handles a real mixed cell from the reference board", () => {
    expect(expandRefs("C1001,C2004,C2005,C6001-C6004,C12001")).toEqual([
      "C1001",
      "C2004",
      "C2005",
      "C6001",
      "C6002",
      "C6003",
      "C6004",
      "C12001",
    ]);
  });

  it("leaves ranges it cannot verify alone rather than guessing", () => {
    expect(expandRefs("R1-C4")).toEqual(["R1-C4"]); // prefixes differ
    expect(expandRefs("R9-R2")).toEqual(["R9-R2"]); // descending
    expect(expandRefs("575-4")).toEqual(["575-4"]); // not designators at all
  });

  it("ignores empty cells and stray whitespace", () => {
    expect(expandRefs("")).toEqual([]);
    expect(expandRefs(" R1 , R2 ")).toEqual(["R1", "R2"]);
  });
});

describe("parseRef / classOfRef", () => {
  it("splits prefix and number", () => {
    expect(parseRef("C12001")).toEqual({ prefix: "C", number: 12001, ref: "C12001" });
    expect(parseRef("TP5")).toEqual({ prefix: "TP", number: 5, ref: "TP5" });
    expect(parseRef("not-a-ref")).toBeUndefined();
  });

  it("prefers the longer prefix", () => {
    expect(classOfRef("SW3")).toBe("switch");
    expect(classOfRef("TP1")).toBe("testpoint");
    expect(classOfRef("T1")).toBe("transformer");
  });

  it("knows the longer prefixes people actually type", () => {
    expect(classOfRef("LCD1")).toBe("display");
    expect(classOfRef("REG3")).toBe("ic");
    expect(classOfRef("OPA2")).toBe("ic");
    expect(classOfRef("VREG1")).toBe("ic");
    expect(classOfRef("MCU1")).toBe("ic");
    expect(classOfRef("H4")).toBe("mounting");
    expect(classOfRef("LED7")).toBe("diode");
    expect(classOfRef("NTC1")).toBe("thermistor");
    expect(classOfRef("BAT1")).toBe("battery");
    expect(classOfRef("ANT1")).toBe("antenna");
    expect(classOfRef("BZ1")).toBe("sounder");
    expect(classOfRef("MOD1")).toBe("module");
    expect(classOfRef("XTAL1")).toBe("crystal");
    expect(classOfRef("FUSE2")).toBe("fuse");
  });

  it("matches the whole prefix, never a fragment", () => {
    // LED beats L, REG beats R — but an unrecognised prefix stays unknown
    // instead of being read as the letter it happens to start with
    expect(classOfRef("LED1")).toBe("diode");
    expect(classOfRef("L1")).toBe("inductor");
    expect(classOfRef("REG1")).toBe("ic");
    expect(classOfRef("R1")).toBe("resistor");
    expect(classOfRef("RUMBLE1")).toBe("unknown");
    expect(classOfRef("CLK1")).toBe("unknown");
  });

  it("admits it does not know", () => {
    // the reference board has test points named after their nets
    expect(classOfRef("SDO1")).toBe("unknown");
    expect(classOfRef("SCK1")).toBe("unknown");
  });
});

describe("parseFootprint", () => {
  it("reads chip sizes", () => {
    const fp = parseFootprint("Capacitor_SMD:C_0603_1608Metric");
    expect(fp?.library).toBe("Capacitor_SMD");
    expect(fp?.cls).toBe("capacitor");
    expect(fp?.chip).toEqual({ imperial: "0603", metric: "1608" });
    expect(packageOf(fp)).toBe("0603");
  });

  it("separates the land-pattern variant from the package", () => {
    const fp = parseFootprint("Capacitor_SMD:C_1210_3225Metric_Pad1.33x2.70mm_HandSolder");
    expect(packageOf(fp)).toBe("1210");
    expect(fp?.variant).toBeDefined();
  });

  it("falls back to the footprint name for specific parts", () => {
    expect(packageOf(parseFootprint("Package_DFN_QFN:QFN-56-1EP_7x7mm_P0.4mm_EP3.2x3.2mm"))).toBe(
      "QFN-56-1EP_7x7mm_P0.4mm_EP3.2x3.2mm",
    );
  });

  it("classifies by library, then by name", () => {
    expect(parseFootprint("Resistor_SMD:R_0402_1005Metric")?.cls).toBe("resistor");
    expect(parseFootprint("LED_SMD:LED_0805_2012Metric")?.cls).toBe("diode");
    expect(parseFootprint("TestPoint:TestPoint_Pad_D1.0mm")?.cls).toBe("testpoint");
    expect(parseFootprint("MountingHole:MountingHole_2.2mm_M2_DIN965")?.cls).toBe("mounting");
  });

  it("says nothing about libraries it does not recognise", () => {
    // vendor libraries on the reference board: AON6816:AON6816, 575-4:575-4
    expect(parseFootprint("AON6816:AON6816")?.cls).toBe("unknown");
    expect(parseFootprint("575-4:575-4")?.cls).toBe("unknown");
  });

  it("treats an empty footprint as absent", () => {
    expect(parseFootprint("")).toBeUndefined();
    expect(parseFootprint("   ")).toBeUndefined();
  });
});
