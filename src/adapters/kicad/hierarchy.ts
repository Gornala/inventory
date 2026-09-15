import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";

import { args, children, parseSexpr } from "./sexpr.js";

/**
 * The sheets a project is actually made of, walked from its root schematic.
 *
 * Not every `.kicad_sch` beside a project belongs to it. The reference board's
 * directory holds nine sheets that do, plus `_autosave-*.kicad_sch`, a
 * `12V_to_5V.kicad_sch` that was cut from the design, and four more that were
 * never in it. Globbing the directory read all of them, and reported the
 * resistors in those files as duplicate designators in the design — which they
 * are not; they are simply other files.
 *
 * The BOM comes from `kicad-cli`, which walks the hierarchy. Anything that
 * writes to the design has to walk the same one.
 */
export function projectSheets(project: string): string[] {
  const root = rootSchematicPath(project);
  if (root === undefined) return [];

  const found: string[] = [];
  const seen = new Set<string>();
  const queue = [root];

  while (queue.length > 0) {
    const file = queue.shift() as string;
    const key = resolve(file).toLowerCase();
    // A hierarchy may reuse one sheet in several places, and a broken one can
    // name itself: visit each file once.
    if (seen.has(key)) continue;
    seen.add(key);
    if (!existsSync(file)) continue;
    found.push(file);

    let text: string;
    try {
      text = readFileSync(file, "utf8");
      const tree = parseSexpr(text);
      for (const sheet of children(tree, "sheet")) {
        const name = children(sheet, "property").find((p) => args(p)[0] === "Sheetfile");
        const target = args(name)[1];
        if (target !== undefined && target !== "") queue.push(join(dirname(file), target));
      }
    } catch {
      // A sheet that will not parse still exists and is still part of the
      // design; it simply cannot tell us about its children.
      continue;
    }
  }

  return found.sort();
}

/** The root schematic for a `.kicad_pro`, a `.kicad_sch`, or neither. */
function rootSchematicPath(project: string): string | undefined {
  const ext = extname(project).toLowerCase();
  if (ext === ".kicad_sch") return project;
  if (ext === ".kicad_pro") {
    const sch = `${project.slice(0, -ext.length)}.kicad_sch`;
    return existsSync(sch) ? sch : undefined;
  }
  // A CSV export has no hierarchy to walk; callers that can still do something
  // useful with the directory handle that themselves.
  const sch = join(dirname(project), `${project.slice(0, -ext.length)}.kicad_sch`);
  return existsSync(sch) ? sch : undefined;
}

/**
 * The sheets to work on, falling back to the directory when there is no
 * hierarchy to walk — a bare `.csv` export names a directory and nothing else.
 */
export function projectSheetsOrDirectory(project: string, directoryFiles: string[]): string[] {
  const sheets = projectSheets(project);
  return sheets.length > 0 ? sheets : directoryFiles;
}
