import { describe, expect, it } from "vitest";

import { parseValue } from "../../src/core/parse/value.js";
import { formatMagnitude } from "../../src/core/units.js";

/** Parse, then render canonically — the round trip consolidation depends on. */
function canon(raw: string): string {
  const v = parseValue(raw);
  return v.kind === "quantity" ? formatMagnitude(v.magnitude) : `opaque(${v.raw})`;
}

describe("parseValue", () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    // plain magnitudes
    ["10k", "10k"],
    ["10K", "10k"],
    ["10 k", "10k"],
    ["1k", "1k"],
    ["100", "100"],
    ["0", "0"],
    ["0.1", "100m"],
    ["49.9", "49.9"],
    ["5.24k", "5.24k"],
    ["16.3k", "16.3k"],
    ["133k", "133k"],
    ["1M", "1M"],
    ["1G", "1G"],

    // RKM notation
    ["5k6", "5.6k"],
    ["5K6", "5.6k"],
    ["4k9", "4.9k"],
    ["6k2", "6.2k"],
    ["3n3", "3.3n"],
    ["2u2", "2.2u"],
    ["4u7", "4.7u"],
    ["0R1", "100m"],
    ["1R", "1"],
    ["4R7", "4.7"],

    // explicit units
    ["100n", "100n"],
    ["100nF", "100n"],
    ["10u", "10u"],
    ["10uF", "10u"],
    ["1µF", "1u"],
    ["1μF", "1u"], // GREEK SMALL LETTER MU, not MICRO SIGN
    ["0.1uF", "100n"],
    ["4.7n", "4.7n"],
    ["33n", "33n"],
    ["33nF", "33n"],
    ["10Ω", "10"],
    ["10 Ohm", "10"],
    ["4.7ohms", "4.7"],
    ["10uH", "10u"],

    // milli vs mega is the one case-sensitive rule
    ["10m", "10m"],
    ["2m", "2m"],
    ["5m", "5m"],
    ["1m", "1m"],

    // not quantities
    ["RP2040", "opaque(RP2040)"],
    ["AON6816", "opaque(AON6816)"],
    ["575-4", "opaque(575-4)"],
    ["TMR-1212", "opaque(TMR-1212)"],
    ["LED", "opaque(LED)"],
    ["1101M2S3AQE2", "opaque(1101M2S3AQE2)"],
    ["ICE40HX4K-TQ144", "opaque(ICE40HX4K-TQ144)"],
    ["", "opaque()"],
    ["C", "opaque(C)"],
  ];

  for (const [raw, expected] of cases) {
    it(`${JSON.stringify(raw)} -> ${expected}`, () => {
      expect(canon(raw)).toBe(expected);
    });
  }

  it("merges the spellings that split the reference board's BOM", () => {
    expect(canon("100n")).toBe(canon("100nF"));
    expect(canon("10u")).toBe(canon("10uF"));
    expect(canon("5K6")).toBe(canon("5k6"));
    expect(canon("0.1uF")).toBe(canon("100n"));
  });

  it("keeps 100 mΩ and 10 mΩ apart", () => {
    // both are shunts on the reference board; merging them would be a bug
    expect(canon("0.1")).not.toBe(canon("10m"));
  });

  it("reports whether a unit was actually stated", () => {
    const bare = parseValue("100");
    const explicit = parseValue("100nF");
    expect(bare.kind === "quantity" && bare.bare).toBe(true);
    expect(explicit.kind === "quantity" && explicit.bare).toBe(false);
    expect(explicit.kind === "quantity" && explicit.unit).toBe("farad");
  });
});

describe("formatMagnitude", () => {
  it("keeps the mantissa in [1, 1000)", () => {
    expect(formatMagnitude(1e-9)).toBe("1n");
    expect(formatMagnitude(999e-9)).toBe("999n");
    expect(formatMagnitude(1000e-9)).toBe("1u");
    expect(formatMagnitude(0)).toBe("0");
  });

  it("is idempotent through a parse", () => {
    for (const raw of ["4.7n", "5k6", "0R1", "10m", "49.9", "2u2"]) {
      const once = canon(raw);
      expect(canon(once)).toBe(once);
    }
  });
});
