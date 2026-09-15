import { classLetter } from "./parse/refdes.js";
import type { Spec } from "./types.js";
import { formatMagnitude } from "./units.js";

/**
 * The join key between a schematic line, a catalog entry, a stock record and an
 * order line. Two lines that produce the same key are the same thing to buy.
 *
 * Land-pattern variants are deliberately absent: a 1210 cap on a HandSolder
 * footprint is the same purchase as one on the standard footprint.
 */
export function canonicalKey(spec: Spec): string {
  const letter = classLetter[spec.cls];
  const pkg = spec.pkg ?? "?";
  if (spec.kind === "generic") {
    return `${letter}|${formatMagnitude(spec.magnitude)}|${pkg}`;
  }
  return `${letter}|${spec.designator}|${pkg}`;
}

/** Human-facing value, e.g. `100n` -> `100 nF`. */
export function displayValue(spec: Spec): string {
  if (spec.kind === "specific") return spec.designator;
  const magnitude = formatMagnitude(spec.magnitude);
  switch (spec.unit) {
    case "ohm":
      return `${magnitude} Ω`;
    case "farad":
      return `${magnitude}F`;
    case "henry":
      return `${magnitude}H`;
  }
}

/**
 * How a distributor writes the same part, so the row can be pasted into a
 * search box.
 *
 * `C|100n|0402` is the right join key and the wrong thing to type into DigiKey.
 * Their own listings read `CAP CER 0.1UF 0402` and `RES 5.62K OHM 0603`, so
 * that is what this produces: their words, their units, their order. It is a
 * label and never an identity — nothing is filed under it, and two parts are
 * still the same part when `canonicalKey` says so.
 *
 * A specific part is its own search term: `RP2040` is what you would type, and
 * dressing it up would only get in the way.
 */
export function searchLabel(spec: Spec): string {
  if (spec.kind === "specific") return spec.designator;

  const pkg = spec.pkg === undefined ? "" : ` ${spec.pkg}`;
  switch (spec.unit) {
    case "ohm":
      return `${classWord[spec.cls] ?? "RES"} ${ohms(spec.magnitude)} OHM${pkg}`;
    case "farad":
      return `CAP CER ${farads(spec.magnitude)}${pkg}`;
    case "henry":
      return `FIXED IND ${henries(spec.magnitude)}${pkg}`;
  }
}

/** The classes that measure in ohms do not all call themselves resistors. */
const classWord: Partial<Record<Spec["cls"], string>> = {
  resistor: "RES",
  ferrite: "FERRITE BEAD",
  // NTC or PTC is not something the board says, so neither does the label.
  thermistor: "THERMISTOR",
};

/**
 * A number as a person writes it: no exponent, no trailing zeros.
 *
 * `toPrecision` first, because 4.7 µF divided down arrives as
 * 4.700000000000001 and a search box does not want to see that.
 */
function plain(value: number): string {
  return String(Number(value.toPrecision(6)));
}

/**
 * Ohms carry an SI prefix upwards and none downwards.
 *
 * `5.62k` is `5.62K OHM`, but 5 mΩ cannot be `5M OHM` — that is five megohms,
 * and the shunt you meant is a millionth of it. Below an ohm the distributors
 * write the decimal out (`0.005 OHM`), which has no such trap in it.
 */
function ohms(magnitude: number): string {
  const abs = Math.abs(magnitude);
  if (abs >= 1e6) return `${plain(magnitude / 1e6)}M`;
  if (abs >= 1e3) return `${plain(magnitude / 1e3)}K`;
  return plain(magnitude);
}

/**
 * Capacitance in the two units a catalogue actually uses.
 *
 * Nanofarads are a schematic's unit, not a distributor's: nobody lists a
 * `100NF` part. Under 10 nF it is picofarads (`22PF`, `4700PF`), from there up
 * it is microfarads (`0.01UF`, `0.1UF`, `10UF`) — which is where their own
 * listings change over.
 */
function farads(magnitude: number): string {
  return Math.abs(magnitude) < 10e-9
    ? `${plain(magnitude / 1e-12)}PF`
    : `${plain(magnitude / 1e-6)}UF`;
}

/** Inductance the same way: nH, then µH, then mH — `MH`, as they write it. */
function henries(magnitude: number): string {
  const abs = Math.abs(magnitude);
  if (abs >= 1e-3) return `${plain(magnitude / 1e-3)}MH`;
  if (abs >= 1e-6) return `${plain(magnitude / 1e-6)}UH`;
  return `${plain(magnitude / 1e-9)}NH`;
}
