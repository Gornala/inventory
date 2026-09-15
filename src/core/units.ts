/** Physical quantity a component value denotes. */
export type Unit = "ohm" | "farad" | "henry";

export const unitSymbol: Record<Unit, string> = {
  ohm: "Ω",
  farad: "F",
  henry: "H",
};

/**
 * SI prefixes, largest first. Case matters for exactly one pair: `m` is milli
 * and `M` is mega. Everything else is matched case-insensitively, because
 * schematics contain `10K` and `5K6` as often as `10k` and `5k6`.
 */
const prefixes = [
  { symbol: "G", exponent: 9 },
  { symbol: "M", exponent: 6 },
  { symbol: "k", exponent: 3 },
  { symbol: "", exponent: 0 },
  { symbol: "m", exponent: -3 },
  { symbol: "u", exponent: -6 },
  { symbol: "n", exponent: -9 },
  { symbol: "p", exponent: -12 },
] as const;

/**
 * Multiplier for a prefix letter, or undefined if it is not one.
 * `R` is the RKM ohm marker and multiplies by 1.
 */
export function prefixMultiplier(letter: string): number | undefined {
  switch (letter) {
    case "m":
      return 1e-3; // milli — lower case only
    case "M":
      return 1e6; // mega — upper case only
    default:
      break;
  }
  switch (letter.toLowerCase()) {
    case "p":
      return 1e-12;
    case "n":
      return 1e-9;
    case "u":
    case "µ": // MICRO SIGN
    case "μ": // GREEK SMALL LETTER MU
      return 1e-6;
    case "r":
      return 1; // RKM ohm marker: 0R1, 4R7
    case "k":
      return 1e3;
    case "g":
      return 1e9;
    default:
      return undefined;
  }
}

/** Drops floating point noise from a decimal-scaled magnitude. */
function tidy(n: number): number {
  return Number(n.toPrecision(10));
}

/**
 * Formats a magnitude in engineering notation with a mantissa in [1, 1000).
 *
 * This is what makes `100n` and `100nF` the same canonical part, and `5K6` and
 * `5k6` the same as `5.6k`. Note that it deliberately does NOT merge `0.1` and
 * `10m` — 100 mΩ and 10 mΩ are different resistors.
 */
export function formatMagnitude(magnitude: number): string {
  if (!Number.isFinite(magnitude)) throw new RangeError(`not a finite magnitude: ${magnitude}`);
  if (magnitude === 0) return "0";

  const sign = magnitude < 0 ? "-" : "";
  const abs = Math.abs(magnitude);

  for (const { symbol, exponent } of prefixes) {
    const scaled = tidy(abs / 10 ** exponent);
    if (scaled >= 1 && scaled < 1000) {
      return `${sign}${trimZeros(scaled)}${symbol}`;
    }
  }

  // Outside pico..giga: fall back to exponent form rather than lying about it.
  return `${sign}${trimZeros(tidy(abs))}`;
}

function trimZeros(n: number): string {
  // 4.700000000000001 -> "4.7", 100 -> "100"
  return String(Number(n.toPrecision(6)));
}
