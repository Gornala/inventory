export type MeasuredPad = {
  number: string;
  type: string;
  /** `circle`, `rect`, `oval`, `roundrect`, `trapezoid`, `custom`. */
  shape: string;
  x: number;
  y: number;
  width: number;
  height: number;
  angle: number;
  layers: string[];
  drill: number | undefined;
  roundrectRatio?: number | undefined;
};

export type Measurement = {
  /** Numbered, copper-bearing pads: what the datasheet calls the pin count. */
  padCount: number;
  /** Distinct pad numbers, so a two-pad jumper numbered 1,1 counts once. */
  distinctPads: number;
  /** Median nearest-neighbour spacing along each pad row, when there is one. */
  pitch: number | undefined;
  /** Outer extent across all copper pads, pad edge to pad edge. */
  span: { x: number; y: number };
  /** The most common pad size, which is the signal pad on almost every part. */
  padSize: { width: number; height: number } | undefined;
  /** Large low-count pads that are not part of a pitched row. */
  exposedPads: { width: number; height: number }[];
  /** Paste-only sub-pads: stencil detail, never counted as pins. */
  pasteOnlyPads: number;
  /** Unnumbered plated or unplated holes — mounting, not pins. */
  mechanicalPads: number;
  /**
   * How the part attaches, decided by physics rather than by KiCad's `smd` /
   * `thru_hole` token: paste is what a reflow oven solders, a hole is what a
   * lead goes through. A KiCad "smd" test pad has neither, so nothing can be
   * soldered to it — it is a feature of the board, not a part.
   */
  mounting: "smd" | "through-hole" | "smd+through-hole" | "nothing-to-solder";
  drills: number[];
  /** Distinct pad shapes present, most common first. */
  shapes: string[];
  /**
   * How many pins carry solder paste. A through-hole pad *with* paste is a
   * deliberate pin-in-paste part — reflowed like an SMD despite its leads.
   * Without paste, a reflow oven will not solder it at all.
   */
  pinsWithPaste: number;
};

const copperLayer = /\.Cu$/;

/**
 * How much space a pad takes along each axis once its rotation is applied.
 *
 * `width`/`height` are the pad as the datasheet quotes it; a side pad rotated
 * 90 degrees occupies those the other way round. Ignoring this drew a vendor
 * QFN's side pads across each other as one solid bar.
 */
export function padExtents(pad: MeasuredPad): { w: number; h: number } {
  const angle = ((pad.angle % 180) + 180) % 180;
  if (angle === 0) return { w: pad.width, h: pad.height };
  if (angle === 90) return { w: pad.height, h: pad.width };
  const radians = (angle * Math.PI) / 180;
  const cos = Math.abs(Math.cos(radians));
  const sin = Math.abs(Math.sin(radians));
  return {
    w: pad.width * cos + pad.height * sin,
    h: pad.width * sin + pad.height * cos,
  };
}

export function isCopperPad(pad: MeasuredPad): boolean {
  return pad.layers.some((l) => copperLayer.test(l) || l === "*.Cu");
}

/** A pin: numbered and on copper. Excludes paste sub-pads and mounting holes. */
export function isPin(pad: MeasuredPad): boolean {
  return pad.number.trim() !== "" && isCopperPad(pad);
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
    : sorted[mid];
}

function round(n: number, places = 4): number {
  return Number(n.toFixed(places));
}

/**
 * Pitch from the pads themselves: group into rows and columns, take the
 * nearest-neighbour gaps within each, and use the median so one stray pad
 * (a pin-1 marker offset, a missing pin) cannot move the answer.
 */
function measurePitch(pads: MeasuredPad[]): number | undefined {
  const gaps: number[] = [];

  const collect = (along: "x" | "y", across: "x" | "y"): void => {
    const rows = new Map<number, number[]>();
    for (const pad of pads) {
      const key = round(pad[across], 3);
      const row = rows.get(key);
      if (row) row.push(pad[along]);
      else rows.set(key, [pad[along]]);
    }
    for (const row of rows.values()) {
      if (row.length < 2) continue;
      const sorted = [...row].sort((a, b) => a - b);
      for (let i = 1; i < sorted.length; i++) {
        gaps.push(round((sorted[i] as number) - (sorted[i - 1] as number)));
      }
    }
  };

  collect("x", "y"); // horizontal rows
  collect("y", "x"); // vertical columns

  const positive = gaps.filter((g) => g > 0);
  return positive.length === 0 ? undefined : median(positive);
}

function mostCommonSize(
  pads: MeasuredPad[],
): { width: number; height: number; count: number } | undefined {
  const counts = new Map<string, { width: number; height: number; count: number }>();
  for (const pad of pads) {
    const key = `${round(pad.width, 3)}x${round(pad.height, 3)}`;
    const slot = counts.get(key);
    if (slot) slot.count += 1;
    else counts.set(key, { width: pad.width, height: pad.height, count: 1 });
  }
  return [...counts.values()].sort((a, b) => b.count - a.count)[0];
}

export function measure(allPads: readonly MeasuredPad[]): Measurement {
  const pads = [...allPads];
  const pins = pads.filter(isPin);
  const signalSize = mostCommonSize(pins);

  // An exposed pad is a copper pin whose area dwarfs the signal pads. Compared
  // by area rather than either dimension, since EPs are often wide and short.
  const signalArea = signalSize ? signalSize.width * signalSize.height : 0;
  const exposedPads = pins.filter((p) => signalArea > 0 && p.width * p.height > signalArea * 4);
  const signalPins = pins.filter((p) => !exposedPads.includes(p));

  const xs = pins.flatMap((p) => {
    const e = padExtents(p);
    return [p.x - e.w / 2, p.x + e.w / 2];
  });
  const ys = pins.flatMap((p) => {
    const e = padExtents(p);
    return [p.y - e.h / 2, p.y + e.h / 2];
  });

  // Paste and holes are looked for across every pad, not only numbered pins:
  // an unnumbered NPTH is still a hole, and a paste-only aperture still means
  // the stencil will put solder there.
  const hasPaste = pads.some((p) => p.layers.some((l) => l.endsWith(".Paste")));
  // A *plated* hole. An `np_thru_hole` is a hole drilled in the board — a
  // screw goes through it, nothing solders to it — so a plain mounting hole
  // has nothing to solder even though it very much has a hole.
  const hasHole = pads.some(
    (p) => p.drill !== undefined && p.drill > 0 && p.type !== "np_thru_hole",
  );

  return {
    padCount: pins.length,
    distinctPads: new Set(pins.map((p) => p.number)).size,
    // Pitch comes from the signal pins only: an exposed pad sitting in the
    // middle would otherwise invent a gap that no datasheet mentions.
    pitch: measurePitch(signalPins),
    span: {
      x: xs.length > 0 ? round(Math.max(...xs) - Math.min(...xs)) : 0,
      y: ys.length > 0 ? round(Math.max(...ys) - Math.min(...ys)) : 0,
    },
    padSize: signalSize ? { width: signalSize.width, height: signalSize.height } : undefined,
    exposedPads: exposedPads.map((p) => ({ width: p.width, height: p.height })),
    // The stencil sub-pads KiCad adds to break up a big thermal pad: a QFN-56
    // with an EP has 61 (pad …) entries but 57 pins.
    pasteOnlyPads: pads.filter((p) => !isCopperPad(p) && p.layers.includes("F.Paste")).length,
    mechanicalPads: pads.filter((p) => p.number.trim() === "" && isCopperPad(p)).length,
    mounting:
      hasPaste && hasHole
        ? "smd+through-hole" // stuck in, then reflowed: pin-in-paste
        : hasPaste
          ? "smd"
          : hasHole
            ? "through-hole"
            : "nothing-to-solder",
    shapes: [...new Set(pins.map((p) => p.shape).filter((s) => s !== ""))],
    pinsWithPaste: pins.filter((p) => p.layers.some((l) => l.endsWith(".Paste"))).length,
    drills: [...new Set(pads.map((p) => p.drill).filter((d): d is number => d !== undefined))].sort(
      (a, b) => a - b,
    ),
  };
}
