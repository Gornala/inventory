/** Coarse component class, as implied by a reference designator prefix. */
export type ComponentClass =
  | "resistor"
  | "capacitor"
  | "inductor"
  | "ferrite"
  | "diode"
  | "transistor"
  | "ic"
  | "connector"
  | "switch"
  | "crystal"
  | "transformer"
  | "fuse"
  | "relay"
  | "testpoint"
  | "mounting"
  | "thermistor"
  | "display"
  | "battery"
  | "antenna"
  | "sounder"
  | "module"
  | "unknown";

/** Letter used for this class in a canonical key. */
export const classLetter: Record<ComponentClass, string> = {
  resistor: "R",
  capacitor: "C",
  inductor: "L",
  ferrite: "FB",
  diode: "D",
  transistor: "Q",
  ic: "U",
  connector: "J",
  switch: "SW",
  crystal: "Y",
  transformer: "T",
  fuse: "F",
  relay: "K",
  testpoint: "TP",
  mounting: "MH",
  thermistor: "TH",
  display: "DS",
  battery: "BT",
  antenna: "ANT",
  sounder: "LS",
  module: "MOD",
  unknown: "X",
};

/**
 * Reference designator prefixes.
 *
 * Deliberately long: IEEE 315 covers the single letters, but real schematics
 * are full of `LCD1`, `REG3`, `OPA2` and `H4` because a designer would rather
 * read the board than decode it. Anything not listed stays `unknown`, which
 * only means the footprint gets the deciding vote — never a wrong guess.
 *
 * Order does not matter: lookup takes the longest match.
 */
const prefixClasses: ReadonlyArray<readonly [string, ComponentClass]> = [
  // passives
  ["R", "resistor"],
  ["RES", "resistor"],
  ["RV", "resistor"],
  ["RN", "resistor"],
  ["RA", "resistor"],
  ["POT", "resistor"],
  ["VR", "resistor"],
  ["C", "capacitor"],
  ["CAP", "capacitor"],
  ["CN", "capacitor"],
  ["L", "inductor"],
  ["IND", "inductor"],
  ["CHK", "inductor"],
  ["FB", "ferrite"],
  ["FER", "ferrite"],
  ["TH", "thermistor"],
  ["NTC", "thermistor"],
  ["PTC", "thermistor"],
  ["RT", "thermistor"],
  ["T", "transformer"],
  ["TR", "transformer"],
  ["XFMR", "transformer"],

  // semiconductors
  ["D", "diode"],
  ["DZ", "diode"],
  ["ZD", "diode"],
  ["LED", "diode"],
  ["CR", "diode"],
  ["Q", "transistor"],
  ["TX", "transistor"],
  ["U", "ic"],
  ["IC", "ic"],
  ["REG", "ic"],
  ["VREG", "ic"],
  ["OP", "ic"],
  ["OPA", "ic"],
  ["AMP", "ic"],
  ["AR", "ic"],
  ["MCU", "ic"],
  ["FPGA", "ic"],
  ["MEM", "ic"],
  ["DRV", "ic"],
  ["ADC", "ic"],
  ["DAC", "ic"],
  ["OSC", "crystal"],

  // connectors and mechanics
  ["J", "connector"],
  ["P", "connector"],
  ["CON", "connector"],
  ["JP", "connector"],
  ["CONN", "connector"],
  ["USB", "connector"],
  ["HDR", "connector"],
  ["SW", "switch"],
  ["S", "switch"],
  ["SB", "switch"],
  ["BTN", "switch"],
  ["KEY", "switch"],
  ["K", "relay"],
  ["RY", "relay"],
  ["RLY", "relay"],
  ["F", "fuse"],
  ["FU", "fuse"],
  ["FUSE", "fuse"],
  ["Y", "crystal"],
  ["X", "crystal"],
  ["XTAL", "crystal"],
  ["TP", "testpoint"],
  ["TSTP", "testpoint"],
  ["H", "mounting"],
  ["HW", "mounting"],
  ["MH", "mounting"],
  ["MK", "mounting"],
  ["MP", "mounting"],
  ["STANDOFF", "mounting"],

  // modules and the rest
  ["LCD", "display"],
  ["DISP", "display"],
  ["DS", "display"],
  ["OLED", "display"],
  ["SEG", "display"],
  ["BT", "battery"],
  ["BAT", "battery"],
  ["ANT", "antenna"],
  ["AE", "antenna"],
  ["E", "antenna"],
  ["LS", "sounder"],
  ["SP", "sounder"],
  ["SPK", "sounder"],
  ["BZ", "sounder"],
  ["BUZ", "sounder"],
  ["MOD", "module"],
  ["M", "module"],
  ["PS", "module"],
  ["PSU", "module"],
];

/** Built once: longest prefixes win, so `LED` beats `L` and `REG` beats `R`. */
const prefixLookup = new Map(prefixClasses.map(([prefix, cls]) => [prefix, cls]));
const longestPrefix = Math.max(...prefixClasses.map(([prefix]) => prefix.length));

export type RefDes = { prefix: string; number: number; ref: string };

const refPattern = /^([A-Za-z_]+)(\d+)$/;

export function parseRef(ref: string): RefDes | undefined {
  const m = refPattern.exec(ref.trim());
  if (!m) return undefined;
  const [, prefix, digits] = m as unknown as [string, string, string];
  return { prefix: prefix.toUpperCase(), number: Number(digits), ref: ref.trim() };
}

export function classOfPrefix(prefix: string): ComponentClass {
  const upper = prefix.toUpperCase();
  // Exact match on the whole prefix: `LEDR1` is not an LED, and inventing a
  // class from a partial match is how a tool starts being wrong confidently.
  return upper.length <= longestPrefix ? (prefixLookup.get(upper) ?? "unknown") : "unknown";
}

export function classOfRef(ref: string): ComponentClass {
  const parsed = parseRef(ref);
  return parsed ? classOfPrefix(parsed.prefix) : "unknown";
}

/**
 * Expands a kicad-cli reference cell into individual designators.
 *
 * kicad-cli emits `C6001-C6004` for runs and joins groups with commas, so a
 * single cell reads `C1001,C2004,C6001-C6004`. A range only expands when both
 * ends share a prefix and ascend; anything else is kept verbatim rather than
 * guessed at.
 */
export function expandRefs(cell: string): string[] {
  const out: string[] = [];
  for (const chunk of cell.split(",")) {
    const piece = chunk.trim();
    if (piece === "") continue;

    const dash = piece.indexOf("-");
    if (dash <= 0) {
      out.push(piece);
      continue;
    }

    const from = parseRef(piece.slice(0, dash));
    const to = parseRef(piece.slice(dash + 1));
    if (!from || !to || from.prefix !== to.prefix || to.number < from.number) {
      out.push(piece);
      continue;
    }

    for (let n = from.number; n <= to.number; n++) out.push(`${from.prefix}${n}`);
  }
  return out;
}
