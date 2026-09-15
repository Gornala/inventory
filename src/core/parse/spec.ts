import { canonicalKey } from "../canonical.js";
import type { AnalyzedLine, BomLine, Issue, Severity, Spec } from "../types.js";
import type { Unit } from "../units.js";
import { packageOf, parseFootprint } from "./footprint.js";
import { classLetter, classOfRef, type ComponentClass } from "./refdes.js";
import { parseValue } from "./value.js";

const passiveUnits: Partial<Record<ComponentClass, Unit>> = {
  resistor: "ohm",
  thermistor: "ohm", // nominal resistance at 25 °C
  capacitor: "farad",
  inductor: "henry",
  ferrite: "ohm", // impedance at a stated frequency; ohms is the sane base
};

/**
 * Families that look alike on a board. A mismatch is only worth reporting when
 * it crosses a family: an `R` on a `Capacitor_SMD` footprint is a real error,
 * while a `U` on `Package_TO_SOT_SMD:SOT-23-6` is an everyday regulator.
 */
function family(cls: ComponentClass): string {
  switch (cls) {
    case "ic":
    case "transistor":
    case "diode":
      return "semiconductor";
    // A thermistor is a resistor-shaped part and lives on resistor land
    // patterns; it keys separately, but it is not a footprint error.
    case "resistor":
    case "thermistor":
      return "resistive";
    case "inductor":
    case "ferrite":
    case "transformer":
      return "magnetics";
    // Modules, displays, batteries and sounders are built from whatever
    // footprint suits — a header, a pad field, a custom outline. There is no
    // expected footprint class, so they never take part in the comparison.
    case "display":
    case "battery":
    case "antenna":
    case "sounder":
    case "module":
    case "unknown":
      return "unknown";
    default:
      return cls;
  }
}

/**
 * Distinguishes a manufacturer part number from a placeholder. Both fail to
 * parse as a quantity, but `IHLP6767GZER100M01` is an answer and `TBD` is not.
 */
/**
 * Classes that live on generic two-terminal chip land patterns. Within this
 * set a footprint from the "wrong" library is cosmetic: measured against the
 * KiCad 10 libraries, same-size chip land patterns across Resistor_SMD,
 * Capacitor_SMD, Inductor_SMD, Diode_SMD and LED_SMD agree to within 0.075 mm
 * of outer span (R_0603 and C_0603 are identical at 2.45 mm). The part solders;
 * what is wrong is the 3D model and the library intent.
 */
function isTwoTerminalChip(cls: ComponentClass): boolean {
  return (
    cls === "resistor" ||
    cls === "thermistor" ||
    cls === "capacitor" ||
    cls === "inductor" ||
    cls === "ferrite" ||
    cls === "diode"
  );
}

/** "a resistor" but "an inductor". */
function article(word: string): string {
  return /^[aeiou]/i.test(word) ? "an" : "a";
}

function looksLikeMpn(value: string): boolean {
  const t = value.trim();
  return t.length >= 5 && /[A-Za-z]/.test(t) && /\d/.test(t) && /[A-Za-z0-9]{5,}/.test(t);
}

/** Classes excluded by default: board features rather than bought parts. */
export const defaultExcludedClasses: ComponentClass[] = ["testpoint", "mounting"];

export type AnalyzeOptions = {
  /** Pass an empty array to keep everything. */
  excludeClasses?: readonly ComponentClass[];
};

/** Field names a designer might put a real part number in. */
export const partNumberFields = [
  "MPN",
  "PN",
  "Part Number",
  "PartNumber",
  "Manufacturer Part Number",
];

function hasPartNumber(line: BomLine): boolean {
  for (const [name, value] of Object.entries(line.fields)) {
    if (value.trim() === "") continue;
    if (partNumberFields.some((f) => f.toLowerCase() === name.toLowerCase())) return true;
  }
  return looksLikeMpn(line.value);
}

export function analyzeLine(line: BomLine, options: AnalyzeOptions = {}): AnalyzedLine {
  const issues: Issue[] = [];
  let resolved = false;
  const refs = line.refs;
  const push = (code: Issue["code"], severity: Severity, message: string): void => {
    issues.push({ code, severity, message, refs });
  };

  const fp = parseFootprint(line.footprint);
  if (!fp) push("missing-footprint", "error", "no footprint assigned");

  const refCls = refs.length > 0 ? classOfRef(refs[0] as string) : "unknown";
  const fpCls = fp?.cls ?? "unknown";

  if (
    refCls !== "unknown" &&
    fpCls !== "unknown" &&
    family(refCls) !== family(fpCls) &&
    fp !== undefined
  ) {
    const interchangeable =
      fp.chip !== undefined && isTwoTerminalChip(refCls) && isTwoTerminalChip(fpCls);
    push(
      "class-mismatch",
      interchangeable ? "warning" : "error",
      interchangeable
        ? `${refCls} on a ${fpCls} land pattern ("${fp.raw}"). Same-size chip pads are ` +
            `interchangeable within 0.075 mm, so it will solder — but the 3D model and the ` +
            `library are wrong`
        : `reference designator says ${refCls}, footprint "${fp.raw}" says ${fpCls}`,
    );
  }

  // The refdes is the more trustworthy of the two, since it is what the
  // designer typed deliberately; the footprint is what they picked from a list.
  const cls: ComponentClass = refCls !== "unknown" ? refCls : fpCls;

  if (line.quantity !== refs.length) {
    push(
      "quantity-mismatch",
      "error",
      `exported quantity ${line.quantity} but ${refs.length} references listed`,
    );
  }

  // A test point with a part number is a real bought part; one without is a
  // pad on the board. Same for mounting holes, which may be a plain hole or an
  // actual screw-in standoff someone ordered.
  const excludedClasses = options.excludeClasses ?? defaultExcludedClasses;
  const excluded =
    excludedClasses.includes(cls) && !hasPartNumber(line)
      ? `${cls === "mounting" ? "mounting hole" : "test point"} with no part number`
      : undefined;

  const unit = passiveUnits[cls];
  const parsed = parseValue(line.value);
  const pkg = packageOf(fp);

  if (unit !== undefined) {
    if (line.value.trim().toUpperCase() === classLetter[cls]) {
      push("placeholder-value", "error", `value is the bare designator letter "${line.value}"`);
    } else if (parsed.kind === "opaque") {
      // A passive whose value is already a manufacturer part number is a part
      // someone has resolved by hand, not a broken value.
      if (looksLikeMpn(line.value)) {
        resolved = true;
        push(
          "pre-resolved",
          "info",
          `"${line.value.trim()}" is a specific part already — ${article(cls)} ${cls} chosen ` +
            `for power, size or precision gets picked before the generics do`,
        );
      } else {
        push("unparsable-value", "error", `cannot read "${line.value}" as a ${cls} value`);
      }
    } else if (parsed.bare && cls !== "resistor") {
      push(
        "ambiguous-bare-value",
        "warning",
        `"${line.value}" has no unit; for a ${cls} the magnitude is a guess`,
      );
    }

    if (parsed.kind === "quantity") {
      const spec: Spec = {
        kind: "generic",
        cls,
        magnitude: parsed.magnitude,
        unit,
        pkg,
        variant: fp?.variant,
      };
      return { line, spec, key: canonicalKey(spec), issues, resolved, excluded };
    }
  }

  const spec: Spec = { kind: "specific", cls, designator: line.value.trim(), pkg };
  return { line, spec, key: canonicalKey(spec), issues, resolved, excluded };
}

export function analyzeBom(
  lines: readonly BomLine[],
  options: AnalyzeOptions = {},
): AnalyzedLine[] {
  return lines.map((line) => analyzeLine(line, options));
}

/** The lines that will actually be bought. */
export function purchasable(lines: readonly AnalyzedLine[]): AnalyzedLine[] {
  return lines.filter((l) => l.excluded === undefined);
}

/**
 * Lets measured geometry overrule the name-based guess about what is a part.
 *
 * `mountable` returns true or false for a footprint that was found and
 * measured, and undefined for one that was not. Measurement wins in both
 * directions: it drops test pads no naming rule would catch, and it rescues a
 * Würth SMD standoff that the naming rule threw away for want of an MPN. Where
 * nothing could be measured the guess stands, because a guess beats silence.
 */
export function applyMountability(
  lines: readonly AnalyzedLine[],
  mountable: (footprint: string) => boolean | undefined,
): AnalyzedLine[] {
  return lines.map((line) => {
    const measured = mountable(line.line.footprint.trim());
    if (measured === undefined) return line;
    if (measured) {
      return line.excluded === undefined ? line : { ...line, excluded: undefined };
    }
    return {
      ...line,
      excluded: line.excluded ?? "footprint has no paste and no plated hole — nothing to solder",
    };
  });
}

/**
 * The reason a part carries when you were the one who took it out.
 *
 * Distinct from the two rule reasons on purpose: the "Not bought" tab groups by
 * reason, so your own decisions sit in a heading of their own rather than being
 * mixed in with the board features the tool worked out for itself.
 */
export const notBoughtReason = "marked do not buy";

/**
 * Lets your own decision overrule both rules, in either direction.
 *
 * Last word, after the class guess and after the geometry: the rules describe
 * the usual board and you are looking at this one. A footprint populated by
 * hand from the drawer is not a purchase however solderable it is, and a part
 * the geometry threw out is one if you say it is.
 */
export function applyBuyChoices(
  lines: readonly AnalyzedLine[],
  choice: (key: string) => boolean | undefined,
): AnalyzedLine[] {
  return lines.map((line) => {
    const buy = choice(line.key);
    if (buy === undefined) return line;
    if (buy) return line.excluded === undefined ? line : { ...line, excluded: undefined };
    return line.excluded === notBoughtReason ? line : { ...line, excluded: notBoughtReason };
  });
}
