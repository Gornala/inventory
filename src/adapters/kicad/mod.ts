import { readFileSync } from "node:fs";

import { args, child, children, head, numbers, parseSexpr, type SList } from "./sexpr.js";

export type Pad = {
  /** Empty for the paste-only sub-pads KiCad uses to split a thermal pad. */
  number: string;
  /** `smd`, `thru_hole`, `np_thru_hole`, `connect`. */
  type: string;
  shape: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Degrees, counter-clockwise. Vendor footprints rotate side pads; KiCad's
   *  own libraries write a per-edge size instead and leave this at 0. */
  angle: number;
  layers: string[];
  drill: number | undefined;
  /** Corner rounding as a fraction of the shorter side, for `roundrect`. */
  roundrectRatio: number | undefined;
};

export type FootprintFile = {
  name: string;
  /** `(version …)` from the file header. */
  version: string | undefined;
  descr: string | undefined;
  /** `smd`, `through_hole`, or absent. */
  attr: string[];
  pads: Pad[];
  /** Bounding box of the front courtyard, if the footprint draws one. */
  courtyard: { x: number; y: number; width: number; height: number } | undefined;
};

function padOf(node: SList): Pad {
  const positional = args(node);
  const [number = "", type = "", shape = ""] = positional;
  const at = numbers(child(node, "at"));
  const size = numbers(child(node, "size"));
  const drill = child(node, "drill");

  return {
    number,
    type,
    shape,
    x: at[0] ?? 0,
    y: at[1] ?? 0,
    width: size[0] ?? 0,
    height: size[1] ?? 0,
    angle: at[2] ?? 0,
    layers: args(child(node, "layers")),
    drill: drill ? numbers(drill)[0] : undefined,
    roundrectRatio: numbers(child(node, "roundrect_rratio"))[0],
  };
}

/** Bounding box of every graphic on a layer, across lines, rects and polys. */
function layerBounds(
  root: SList,
  layer: string,
): { x: number; y: number; width: number; height: number } | undefined {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  const visit = (node: SList): void => {
    const kind = head(node);
    if (kind !== undefined && kind.startsWith("fp_")) {
      const on = args(child(node, "layer"))[0];
      if (on === layer) {
        for (const key of ["start", "end", "center", "mid"]) {
          const point = numbers(child(node, key));
          const [x, y] = point;
          if (x !== undefined && y !== undefined) {
            minX = Math.min(minX, x);
            maxX = Math.max(maxX, x);
            minY = Math.min(minY, y);
            maxY = Math.max(maxY, y);
          }
        }
      }
    }
    for (const item of node.items) if (item.kind === "list") visit(item);
  };
  visit(root);

  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return undefined;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function parseFootprintFile(text: string): FootprintFile {
  const root = parseSexpr(text);
  if (head(root) !== "footprint") throw new Error("not a footprint file");

  return {
    name: args(root)[0] ?? "",
    version: args(child(root, "version"))[0],
    descr: args(child(root, "descr"))[0],
    attr: args(child(root, "attr")),
    pads: children(root, "pad").map(padOf),
    courtyard: layerBounds(root, "F.CrtYd"),
  };
}

export function readFootprintFile(path: string): FootprintFile {
  return parseFootprintFile(readFileSync(path, "utf8"));
}
