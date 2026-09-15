import { describe, expect, it } from "vitest";

import { readFootprintFile } from "../../src/adapters/kicad/mod.js";
import { head, parseSexpr, args, child } from "../../src/adapters/kicad/sexpr.js";
import { checkFootprint, checkPinNumbers } from "../../src/core/footprint/check.js";
import { measure, padExtents, type MeasuredPad } from "../../src/core/footprint/measure.js";
import { parseFootprintName } from "../../src/core/footprint/name.js";
import { fixture } from "../fixtures/index.js";

function fp(name: string) {
  return readFootprintFile(fixture("kicad10", "footprints", `${name}.kicad_mod`));
}

describe("s-expression reader", () => {
  it("reads nesting, quoting and escapes", () => {
    const node = parseSexpr('(footprint "R_0603" (attr smd) (descr "a \\"quoted\\" bit"))');
    expect(head(node)).toBe("footprint");
    expect(args(node)[0]).toBe("R_0603");
    expect(args(child(node, "descr"))[0]).toBe('a "quoted" bit');
  });

  it("records the byte span of every node, for the step-2b splicer", () => {
    const text = '(footprint "X" (attr smd))';
    const node = parseSexpr(text);
    const attr = child(node, "attr");
    expect(text.slice(attr?.start, attr?.end)).toBe("(attr smd)");
  });

  it("rejects a truncated file rather than guessing", () => {
    expect(() => parseSexpr('(footprint "X"')).toThrow(/unterminated/);
    expect(() => parseSexpr('(descr "unclosed')).toThrow(/unterminated/);
  });
});

describe("measuring real KiCad 10 footprints", () => {
  it("measures a chip resistor exactly", () => {
    const m = measure(fp("R_0603_1608Metric").pads);
    expect(m.padCount).toBe(2);
    expect(m.padSize).toEqual({ width: 0.8, height: 0.95 });
    expect(m.span).toEqual({ x: 2.45, y: 0.95 });
    expect(m.mounting).toBe("smd");
    expect(m.exposedPads).toHaveLength(0);
  });

  it("does not count paste-only stencil pads as pins", () => {
    // this QFN has 61 (pad …) entries: 56 signal + 1 EP + 4 paste sub-pads
    const m = measure(fp("QFN-56-1EP_7x7mm_P0.4mm_EP3.2x3.2mm").pads);
    expect(m.padCount).toBe(57);
    expect(m.pasteOnlyPads).toBe(4);
    expect(m.exposedPads).toEqual([{ width: 3.2, height: 3.2 }]);
  });

  it("measures pitch from the signal pins, ignoring the exposed pad", () => {
    expect(measure(fp("QFN-56-1EP_7x7mm_P0.4mm_EP3.2x3.2mm").pads).pitch).toBeCloseTo(0.4, 5);
    expect(measure(fp("SOIC-8_3.9x4.9mm_P1.27mm").pads).pitch).toBeCloseTo(1.27, 5);
  });

  it("reads through-hole mounting and drills", () => {
    const m = measure(fp("PinSocket_1x02_P2.54mm_Vertical").pads);
    expect(m.mounting).toBe("through-hole");
    expect(m.drills).toEqual([1]);
    expect(m.pitch).toBeCloseTo(2.54, 5);
  });

  it("reads the courtyard", () => {
    expect(fp("R_0603_1608Metric").courtyard).toEqual({
      x: -1.48,
      y: -0.73,
      width: 2.96,
      height: 1.46,
    });
  });

  it("counts pad instances and distinct numbers separately", () => {
    // a power MOSFET spreads one drain across several pads sharing a number
    const pads: MeasuredPad[] = [
      {
        number: "1",
        type: "smd",
        shape: "rect",
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        angle: 0,
        layers: ["F.Cu"],
        drill: undefined,
      },
      {
        number: "2",
        type: "smd",
        shape: "rect",
        x: 2,
        y: 0,
        width: 1,
        height: 1,
        angle: 0,
        layers: ["F.Cu"],
        drill: undefined,
      },
      {
        number: "2",
        type: "smd",
        shape: "rect",
        x: 4,
        y: 0,
        width: 1,
        height: 1,
        angle: 0,
        layers: ["F.Cu"],
        drill: undefined,
      },
    ];
    const m = measure(pads);
    expect(m.padCount).toBe(3);
    expect(m.distinctPads).toBe(2);
  });
});

describe("rotated pads (vendor footprints)", () => {
  // KiCad's own libraries never rotate a pad — they write a per-edge size
  // instead — so this only shows up on vendor footprints. TI's VQFN36 rotates
  // its 20 side pads by 90 degrees.
  const file = fp("VQFN36_RRV_TEX");

  it("reads the rotation angle", () => {
    const rotated = file.pads.filter((p) => p.angle !== 0);
    expect(rotated).toHaveLength(20);
    expect(rotated.every((p) => p.angle === 90)).toBe(true);
    // every pad is physically the same: 0.254 x 0.8128, some turned sideways
    expect(rotated[0]?.width).toBe(0.254);
    expect(rotated[0]?.height).toBe(0.8128);
  });

  it("measures the span across the turned pads, not through them", () => {
    const m = measure(file.pads);
    // side pads sit at x = ±2.4511 and are 0.8128 long once rotated, so the
    // pads span 2 × (2.4511 + 0.4064) = 5.715 mm across. Top and bottom pads
    // are further out at y = ±2.9464 and are not rotated: 6.7056 mm down.
    // The package really is rectangular — 10 pads a side, 8 top and bottom.
    expect(m.span.x).toBeCloseTo(5.715, 3);
    expect(m.span.y).toBeCloseTo(6.7056, 3);
  });

  it("would have merged neighbouring side pads if rotation were ignored", () => {
    // the bug this test exists for: unrotated, each side pad is 0.8128 tall
    // and they sit 0.5 mm apart, so they overlap into one bar
    const side = file.pads.filter((p) => p.angle === 90 && p.x < 0);
    const spacing = Math.abs((side[1]?.y ?? 0) - (side[0]?.y ?? 0));
    expect(spacing).toBeCloseTo(0.5, 3);
    expect(side[0]?.height).toBeGreaterThan(spacing); // overlaps if not rotated
    expect(padExtents(side[0] as MeasuredPad).h).toBeLessThan(spacing); // fits when rotated
  });
});

describe("how a part attaches", () => {
  // Decided by physics, not by KiCad's pad token: paste is what a reflow oven
  // solders and a hole is what a lead goes through. KiCad calls a test pad
  // "smd" even though nothing can be soldered to it.
  it("calls a pad with paste and no hole SMD", () => {
    expect(measure(fp("R_0603_1608Metric").pads).mounting).toBe("smd");
  });

  it("calls a pad with a hole and no paste through-hole", () => {
    const m = measure(fp("PinSocket_1x02_P2.54mm_Vertical").pads);
    expect(m.mounting).toBe("through-hole");
    expect(m.pinsWithPaste).toBe(0);
  });

  it("calls a test pad what it is: nothing to solder", () => {
    const file = fp("TestPoint_Pad_1.0x1.0mm");
    // KiCad's own token says smd, and there is no paste and no drill
    expect(file.pads[0]?.type).toBe("smd");
    expect(measure(file.pads).mounting).toBe("nothing-to-solder");
  });

  it("reads the 4 mm bushing as a single round through-hole pad", () => {
    const file = fp("575-4");
    expect(file.pads).toHaveLength(1);
    expect(file.pads[0]?.shape).toBe("circle");
    expect(file.pads[0]?.width).toBe(8.2);
    expect(file.pads[0]?.drill).toBe(4.4);

    const m = measure(file.pads);
    expect(m.shapes).toEqual(["circle"]);
    // it is meant to be stuck in and reflowed, but as drawn it has no paste
    // aperture, so a reflow oven would not solder it
    expect(m.pinsWithPaste).toBe(0);
    expect(m.mounting).toBe("through-hole");
  });

  it("does not count an unplated hole as a way of mounting anything", () => {
    // a plain mounting hole: a screw goes through it, nothing solders to it
    const npth: MeasuredPad[] = [
      {
        number: "",
        type: "np_thru_hole",
        shape: "circle",
        x: 0,
        y: 0,
        width: 2.2,
        height: 2.2,
        angle: 0,
        layers: ["*.Cu", "*.Mask"],
        drill: 2.2,
      },
    ];
    expect(measure(npth).mounting).toBe("nothing-to-solder");

    // the same hole plated is a bushing you solder into
    const plated = npth.map((p) => ({ ...p, type: "thru_hole" }));
    expect(measure(plated).mounting).toBe("through-hole");
  });

  it("recognises a pin-in-paste part as both at once", () => {
    const file = fp("575-4");
    const withPaste = file.pads.map((p) => ({ ...p, layers: [...p.layers, "F.Paste"] }));
    expect(measure(withPaste).mounting).toBe("smd+through-hole");
  });
});

describe("what a footprint name claims", () => {
  it("reads pin count, pitch, body and exposed pad", () => {
    const d = parseFootprintName("Package_DFN_QFN:QFN-56-1EP_7x7mm_P0.4mm_EP3.2x3.2mm");
    expect(d.pinCount).toBe(56);
    expect(d.pitch).toBe(0.4);
    expect(d.body).toEqual({ x: 7, y: 7 });
    expect(d.exposedPad).toEqual({ x: 3.2, y: 3.2 });
  });

  it("reads chip size codes", () => {
    expect(parseFootprintName("Resistor_SMD:R_0603_1608Metric").chip).toEqual({
      imperial: "0603",
      metric: "1608",
    });
  });

  it("refuses to read a JEDEC package code as a pin count", () => {
    // every one of these produced a confident, wrong finding before the
    // family whitelist existed
    expect(parseFootprintName("Package_TO_SOT_SMD:SOT-23-6").pinCount).toBeUndefined();
    expect(parseFootprintName("Package_TO_SOT_SMD:SOT-353_SC-70-5").pinCount).toBeUndefined();
    expect(parseFootprintName("RF_Module:ESP-07").pinCount).toBeUndefined();
    expect(parseFootprintName("1201M2S3CQE2:SPDT-1101M2_CNK").pinCount).toBeUndefined();
  });

  it("still reads the families where the number is a pin count", () => {
    expect(parseFootprintName("SOIC-8_3.9x4.9mm_P1.27mm").pinCount).toBe(8);
    expect(parseFootprintName("TQFP-144_20x20mm_P0.5mm").pinCount).toBe(144);
    expect(parseFootprintName("USON-8_UX_2x3x0p6").pinCount).toBe(8);
  });
});

describe("cross-checking the name against the geometry", () => {
  const real = [
    "R_0603_1608Metric",
    "QFN-56-1EP_7x7mm_P0.4mm_EP3.2x3.2mm",
    "SOIC-8_3.9x4.9mm_P1.27mm",
    "PinSocket_1x02_P2.54mm_Vertical",
  ];

  it("passes every unmodified library footprint", () => {
    for (const name of real) {
      const file = fp(name);
      expect(checkFootprint(parseFootprintName(file.name), measure(file.pads))).toEqual([]);
    }
  });

  it("catches a footprint whose pads no longer match its name", () => {
    // squeeze a 0.5 mm TQFP to 0.4 mm: the name still says P0.5mm
    const file = fp("SOIC-8_3.9x4.9mm_P1.27mm");
    const squeezed = file.pads.map((p) => ({ ...p, y: p.y * 0.8 }));
    const findings = checkFootprint(parseFootprintName(file.name), measure(squeezed));
    expect(findings.map((f) => f.code)).toContain("pitch-mismatch");
    expect(findings[0]?.severity).toBe("error");
    expect(findings[0]?.message).toMatch(/1\.27/);
  });

  it("catches a missing pin", () => {
    const file = fp("SOIC-8_3.9x4.9mm_P1.27mm");
    const findings = checkFootprint(parseFootprintName(file.name), measure(file.pads.slice(0, -1)));
    expect(findings.map((f) => f.code)).toContain("pin-count-mismatch");
  });

  it("calls a thermal pad numbered as a pin what it is, not a defect", () => {
    const file = fp("SOIC-8_3.9x4.9mm_P1.27mm");
    const withEp = [...file.pads, { ...(file.pads[0] as MeasuredPad), number: "9", x: 0, y: 0 }];
    const findings = checkFootprint(parseFootprintName(file.name), measure(withEp));
    expect(findings.map((f) => f.code)).toEqual(["extra-thermal-pad"]);
    expect(findings[0]?.severity).toBe("info");
  });

  it("catches an exposed pad the name promises but the geometry lacks", () => {
    const file = fp("QFN-56-1EP_7x7mm_P0.4mm_EP3.2x3.2mm");
    const withoutEp = file.pads.filter((p) => p.width < 3);
    const findings = checkFootprint(parseFootprintName(file.name), measure(withoutEp));
    expect(findings.map((f) => f.code)).toContain("exposed-pad-missing");
  });
});

describe("symbol pins against footprint pads", () => {
  it("catches a symbol whose pins have no pads", () => {
    const findings = checkPinNumbers(["1", "2", "3", "4", "5", "6", "7", "8"], ["1", "2", "3"]);
    expect(findings[0]?.code).toBe("symbol-pin-mismatch");
    expect(findings[0]?.message).toMatch(/4, 5, 6/);
  });

  it("catches a numbering convention mismatch", () => {
    expect(checkPinNumbers(["A1", "A2"], ["1", "2"])).toHaveLength(1);
  });

  it("says nothing when they line up", () => {
    expect(checkPinNumbers(["1", "2"], ["1", "2"])).toEqual([]);
  });
});
