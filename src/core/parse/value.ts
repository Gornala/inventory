import { prefixMultiplier, type Unit } from "../units.js";

export type ParsedValue =
  | {
      kind: "quantity";
      /** In base units (ohms / farads / henries), whichever the class supplies. */
      magnitude: number;
      /** Set only when the string itself said so (`100nF`, `10Ω`), not inferred. */
      unit: Unit | undefined;
      /** True when the string carried neither unit nor SI prefix: `100`, `0`, `4`. */
      bare: boolean;
      raw: string;
    }
  | {
      /** Not a quantity: an MPN, a placeholder, a name. `RP2040`, `LED`, `575-4`. */
      kind: "opaque";
      raw: string;
    };

/** Unicode and spelling variants that mean the same thing. */
function normalize(raw: string): string {
  return raw
    .trim()
    .replace(/µ|μ/g, "u") // MICRO SIGN, GREEK SMALL LETTER MU
    .replace(/Ω|Ω/g, "ohm") // OHM SIGN, GREEK CAPITAL OMEGA
    .replace(/\s+/g, "");
}

/** Strips an explicit trailing unit, returning what it was. */
function takeUnit(s: string): { rest: string; unit: Unit | undefined } {
  const tail = [
    { re: /(?:ohms?)$/i, unit: "ohm" as const },
    { re: /(?:farads?)$/i, unit: "farad" as const },
    { re: /(?:henrys?|henries)$/i, unit: "henry" as const },
    { re: /F$/, unit: "farad" as const },
    { re: /H$/, unit: "henry" as const },
  ];
  for (const { re, unit } of tail) {
    const rest = s.replace(re, "");
    // Only a unit if something numeric survives; guards `F` in a part number.
    if (rest !== s && /\d/.test(rest)) return { rest, unit };
  }
  return { rest: s, unit: undefined };
}

const rkm = /^(\d+)([a-zA-Zµ])(\d+)$/; //  5k6, 3n3, 0R1, 4u7
const plain = /^(\d+(?:\.\d+)?)([a-zA-Zµ]?)$/; //  10k, 4.7n, 100, 0.1

/**
 * Parses a KiCad `Value` field into a magnitude, or reports it as opaque.
 *
 * The unit is usually absent (`10k`), so the caller supplies it from the
 * component class; `unit` here is only what the text itself asserted.
 */
export function parseValue(raw: string): ParsedValue {
  const trimmed = raw.trim();
  if (trimmed === "") return { kind: "opaque", raw };

  const { rest, unit } = takeUnit(normalize(trimmed));

  const rkmMatch = rkm.exec(rest);
  if (rkmMatch) {
    const [, whole, letter, frac] = rkmMatch as unknown as [string, string, string, string];
    const multiplier = prefixMultiplier(letter);
    if (multiplier !== undefined) {
      const magnitude = Number(`${whole}.${frac}`) * multiplier;
      if (Number.isFinite(magnitude))
        return { kind: "quantity", magnitude, unit, bare: false, raw };
    }
    return { kind: "opaque", raw };
  }

  const plainMatch = plain.exec(rest);
  if (plainMatch) {
    const [, digits, letter] = plainMatch as unknown as [string, string, string];
    const multiplier = letter === "" ? 1 : prefixMultiplier(letter);
    if (multiplier !== undefined) {
      const magnitude = Number(digits) * multiplier;
      if (Number.isFinite(magnitude)) {
        return {
          kind: "quantity",
          magnitude,
          unit,
          bare: letter === "" && unit === undefined,
          raw,
        };
      }
    }
    return { kind: "opaque", raw };
  }

  return { kind: "opaque", raw };
}
