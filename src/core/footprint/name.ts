/**
 * What a KiCad footprint name asserts about itself. These are conventions, not
 * guarantees — which is the whole point: comparing the claim against measured
 * geometry is what catches a hand-edited or mis-named footprint.
 */
export type DeclaredFootprint = {
  name: string;
  /** Chip size code, e.g. `0603`, with its metric twin. */
  chip: { imperial: string; metric: string } | undefined;
  /** `P0.4mm` → 0.4 */
  pitch: number | undefined;
  /** Pin count from a `QFN-56`, `SOIC-8`, `TQFP-144` style prefix. */
  pinCount: number | undefined;
  /** `7x7mm` body size. */
  body: { x: number; y: number } | undefined;
  /** `1EP` / `EP3.2x3.2mm` — an exposed pad is claimed. */
  exposedPad: { x: number; y: number } | undefined | "claimed";
  /** Package family token, `QFN`, `SOIC`, `TQFP`, `SOT`. */
  family: string | undefined;
};

const chipPattern = /_(\d{4})_(\d{4})Metric/;
const pitchPattern = /_P(\d+(?:\.\d+)?)mm/;
const bodyPattern = /_(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)mm/;
const epSizePattern = /_EP(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)mm/;
const epClaimPattern = /-(\d+)EP/;
const pinCountPattern = /^([A-Za-z]+)-(\d+)/;

/**
 * Families where `NAME-<digits>` really is a pin count.
 *
 * Deliberately a whitelist, because the same shape means a JEDEC package code
 * elsewhere: SOT-23 is not 23 pins, SOT-353 is not 353, and ESP-07 is a module
 * name. Guessing here produced four confident, wrong findings on a real board.
 */
const pinCountFamilies = new Set([
  "QFN",
  "VQFN",
  "WQFN",
  "UQFN",
  "TQFN",
  "HVQFN",
  "DFN",
  "VDFN",
  "WDFN",
  "UDFN",
  "SON",
  "USON",
  "WSON",
  "VSON",
  "XSON",
  "SO",
  "SOIC",
  "SOP",
  "TSOP",
  "PSOP",
  "HSOP",
  "SSOP",
  "TSSOP",
  "VSSOP",
  "MSOP",
  "QSOP",
  "QFP",
  "TQFP",
  "LQFP",
  "PQFP",
  "HTQFP",
  "MQFP",
  "BGA",
  "LGA",
  "CSP",
  "WLCSP",
  "PLCC",
  "DIP",
  "SDIP",
  "SIP",
  "PDIP",
]);

export function parseFootprintName(name: string): DeclaredFootprint {
  const bare = name.includes(":") ? name.slice(name.indexOf(":") + 1) : name;

  const chipMatch = chipPattern.exec(bare);
  const pitchMatch = pitchPattern.exec(bare);
  const epSizeMatch = epSizePattern.exec(bare);
  const pinMatch = pinCountPattern.exec(bare);

  // The exposed-pad size always carries an `_EP` prefix, which the body
  // pattern cannot match, so the first hit is the body.
  const bodyMatch = bodyPattern.exec(bare);
  const body = bodyMatch ? { x: Number(bodyMatch[1]), y: Number(bodyMatch[2]) } : undefined;

  return {
    name: bare,
    chip: chipMatch
      ? { imperial: chipMatch[1] as string, metric: chipMatch[2] as string }
      : undefined,
    pitch: pitchMatch ? Number(pitchMatch[1]) : undefined,
    pinCount:
      pinMatch && pinCountFamilies.has((pinMatch[1] as string).toUpperCase())
        ? Number(pinMatch[2])
        : undefined,
    body,
    exposedPad: epSizeMatch
      ? { x: Number(epSizeMatch[1]), y: Number(epSizeMatch[2]) }
      : epClaimPattern.test(bare)
        ? "claimed"
        : undefined,
    family: pinMatch ? pinMatch[1] : undefined,
  };
}

/** Nominal chip body sizes, imperial code → millimetres. */
export const chipSizes: Record<string, { x: number; y: number }> = {
  "0201": { x: 0.6, y: 0.3 },
  "0402": { x: 1.0, y: 0.5 },
  "0603": { x: 1.6, y: 0.8 },
  "0805": { x: 2.0, y: 1.25 },
  "1206": { x: 3.2, y: 1.6 },
  "1210": { x: 3.2, y: 2.5 },
  "1812": { x: 4.5, y: 3.2 },
  "2010": { x: 5.0, y: 2.5 },
  "2220": { x: 5.7, y: 5.0 },
  "2512": { x: 6.3, y: 3.2 },
};
