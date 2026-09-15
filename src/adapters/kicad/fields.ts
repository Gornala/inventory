import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { projectSheetsOrDirectory } from "./hierarchy.js";

/**
 * Field names KiCad owns rather than the designer.
 *
 * `Reference`, `Value`, `Footprint`, `Datasheet` and `Description` are asked
 * for by name already; the generated columns (`QUANTITY`, `DNP`, …) are asked
 * for with their `${}` delimiters; `Sheetname` and `Sheetfile` are properties
 * of a *sheet* and never appear on a symbol.
 */
const reserved = new Set([
  "Reference",
  "Value",
  "Footprint",
  "Datasheet",
  "Description",
  "Sheetname",
  "Sheetfile",
  "QUANTITY",
  "ITEM_NUMBER",
  "DNP",
  "EXCLUDE_FROM_BOM",
  "EXCLUDE_FROM_BOARD",
  "EXCLUDE_FROM_SIM",
]);

/** `(property "Name" …)`, with the escapes s-expression strings allow. */
const property = /\(property\s+"((?:[^"\\]|\\.)*)"/g;

function unescapeSexpr(s: string): string {
  return s.replace(/\\(.)/g, "$1");
}

/**
 * A name is only usable if it survives the round trip through `--fields`,
 * which is a comma-separated list and treats `${…}` as a generated column.
 */
function usable(name: string): boolean {
  if (name === "" || reserved.has(name)) return false;
  if (name.startsWith("ki_")) return false; // library metadata: keywords, fp filters, locked
  if (name.startsWith("Sim.")) return false; // the simulator's, not the BOM's
  return !/[,"${}]/.test(name);
}

/**
 * The designer's own field names in one schematic's text.
 *
 * A regex rather than the s-expression reader: only the *names* are wanted,
 * a stray match costs nothing (a column no part fills is dropped before it
 * reaches the table), and the reader would parse several megabytes of
 * schematic on every re-export to answer a question about quoted atoms.
 */
export function customFieldNames(text: string): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(property)) {
    const name = unescapeSexpr(match[1] as string);
    if (usable(name)) names.add(name);
  }
  return [...names];
}

/**
 * Every custom field used anywhere in a project, so the BOM export can ask for
 * all of them. kicad-cli has no "export every field" switch — `--fields`
 * defaults to five columns and anything else has to be named — so the names
 * are read off the schematics first.
 *
 * Sheets are looked for beside the root schematic, which is where KiCad puts
 * them and what `sourceSignature` already watches. A field only used on a sheet
 * kept somewhere else is missed, and the cost of missing it is one absent
 * column, so this never throws.
 */
export function projectFieldNames(schematicPath: string): string[] {
  const names = new Set<string>();
  try {
    const dir = dirname(schematicPath);
    if (!existsSync(dir)) return [];
    // The sheets the design is made of, not every file beside it: an autosave
    // or a sheet cut from the project would otherwise add a BOM column for a
    // field no part on this board carries.
    const sheets = projectSheetsOrDirectory(
      schematicPath,
      readdirSync(dir)
        .filter((f) => f.endsWith(".kicad_sch"))
        .map((f) => join(dir, f)),
    );
    for (const file of sheets) {
      for (const name of customFieldNames(readFileSync(file, "utf8"))) names.add(name);
    }
  } catch {
    return [];
  }

  // Case-insensitive, so `Capacity` and `capacity` land next to each other —
  // the inconsistency is the point of showing them.
  return [...names].sort(
    (a, b) => a.localeCompare(b, "en", { sensitivity: "base" }) || (a < b ? -1 : 1),
  );
}
