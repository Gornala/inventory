import type { ComponentClass } from "./refdes.js";

export type ParsedFootprint = {
  raw: string;
  /** Library nickname, `Capacitor_SMD` in `Capacitor_SMD:C_0603_1608Metric`. */
  library: string | undefined;
  /** Footprint name within the library. */
  name: string;
  /** Class the footprint implies. Compared against the refdes to catch mix-ups. */
  cls: ComponentClass;
  /** Two-terminal chip size, when the name encodes one. */
  chip: { imperial: string; metric: string } | undefined;
  /** `HandSolder`, `Pad1.33x2.70mm` etc. — same part, different land pattern. */
  variant: string | undefined;
};

/** Library nickname → class. Checked before the name, and longest first. */
const libraryClasses: ReadonlyArray<readonly [RegExp, ComponentClass]> = [
  [/^Capacitor/i, "capacitor"],
  [/^Resistor/i, "resistor"],
  [/^Inductor/i, "inductor"],
  [/^Ferrite/i, "ferrite"],
  [/^(Diode|LED)/i, "diode"],
  [/^(Transistor|Package_TO)/i, "transistor"],
  [/^Connector/i, "connector"],
  [/^(Button_Switch|Switch)/i, "switch"],
  [/^(Crystal|Oscillator)/i, "crystal"],
  [/^Transformer/i, "transformer"],
  [/^Fuse/i, "fuse"],
  [/^Relay/i, "relay"],
  [/^TestPoint/i, "testpoint"],
  [/^MountingHole|^Mounting_/i, "mounting"],
  [/^Package_/i, "ic"],
];

/** Footprint-name prefix → class, for libraries that say nothing useful. */
const nameClasses: ReadonlyArray<readonly [RegExp, ComponentClass]> = [
  [/^C_/, "capacitor"],
  [/^CP_/, "capacitor"],
  [/^R_/, "resistor"],
  [/^L_/, "inductor"],
  [/^FB_/, "ferrite"],
  [/^(D_|LED_)/, "diode"],
  [/^Q_/, "transistor"],
  [/^TestPoint/, "testpoint"],
  [/^MountingHole/, "mounting"],
  [/^PinSocket|^PinHeader|^USB_|^Conn_/, "connector"],
];

const chipPattern = /_(\d{4})_(\d{4})Metric/;
const variantPattern = /_(HandSolder|Pad[\d.x]+mm(?:_HandSolder)?|Castellated|ReverseGeometry)/i;

export function parseFootprint(raw: string): ParsedFootprint | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;

  const colon = trimmed.indexOf(":");
  const library = colon >= 0 ? trimmed.slice(0, colon) : undefined;
  const name = colon >= 0 ? trimmed.slice(colon + 1) : trimmed;

  let cls: ComponentClass = "unknown";
  if (library !== undefined) {
    for (const [re, c] of libraryClasses) {
      if (re.test(library)) {
        cls = c;
        break;
      }
    }
  }
  if (cls === "unknown") {
    for (const [re, c] of nameClasses) {
      if (re.test(name)) {
        cls = c;
        break;
      }
    }
  }

  const chipMatch = chipPattern.exec(name);
  const chip = chipMatch
    ? {
        imperial: chipMatch[1] as string,
        metric: chipMatch[2] as string,
      }
    : undefined;

  const variantMatch = variantPattern.exec(name);
  const variant = variantMatch ? (variantMatch[1] as string) : undefined;

  return { raw: trimmed, library, name, cls, chip, variant };
}

/**
 * The package token used in canonical keys: the imperial chip code where there
 * is one (`0603`), otherwise the footprint name, which for a specific part is
 * the most honest identity available.
 */
export function packageOf(fp: ParsedFootprint | undefined): string | undefined {
  if (!fp) return undefined;
  return fp.chip?.imperial ?? fp.name;
}
