import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { projectSheets } from "../../src/adapters/kicad/hierarchy.js";
import { applyFieldWrite, planFieldWrite } from "../../src/adapters/kicad/schematic-edit.js";
import { fixture } from "../fixtures/index.js";

/**
 * Minimal schematics, written here rather than copied: what is under test is
 * the *walk*, and a real board's root would bring 13 sheets and 600 symbols to
 * a question about which files a project is made of. The symbol-level tests use
 * genuine KiCad files.
 */
function sheet(...sheetfiles: string[]): string {
  const links = sheetfiles
    .map(
      (f, i) =>
        `\t(sheet\n\t\t(uuid "0000000${i}-0000-0000-0000-000000000000")\n` +
        `\t\t(property "Sheetname" "${basename(f, ".kicad_sch")}")\n` +
        `\t\t(property "Sheetfile" "${f}")\n\t)`,
    )
    .join("\n");
  return `(kicad_sch\n\t(version 20260306)\n\t(generator "eeschema")\n${links}\n)\n`;
}

describe("which files a project is made of", () => {
  let dir: string;
  let root: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kinv-hier-"));
    root = join(dir, "board.kicad_sch");
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const name = (paths: string[]): string[] => paths.map((p) => basename(p)).sort();

  it("follows the sheets from the root and ignores everything else", () => {
    // the reference board's directory holds nine sheets that belong to the
    // design, plus KiCad's autosaves and five schematics cut from it or never
    // in it. Globbing read all of them.
    writeFileSync(root, sheet("power.kicad_sch"), "utf8");
    writeFileSync(join(dir, "power.kicad_sch"), sheet(), "utf8");
    writeFileSync(join(dir, "_autosave-board.kicad_sch"), sheet(), "utf8");
    writeFileSync(join(dir, "cut_from_the_design.kicad_sch"), sheet(), "utf8");

    expect(name(projectSheets(root))).toEqual(["board.kicad_sch", "power.kicad_sch"]);
  });

  it("follows a sheet inside a sheet", () => {
    writeFileSync(root, sheet("power.kicad_sch"), "utf8");
    writeFileSync(join(dir, "power.kicad_sch"), sheet("driver.kicad_sch"), "utf8");
    writeFileSync(join(dir, "driver.kicad_sch"), sheet(), "utf8");

    expect(name(projectSheets(root))).toEqual([
      "board.kicad_sch",
      "driver.kicad_sch",
      "power.kicad_sch",
    ]);
  });

  it("visits a sheet used twice only once, and does not loop on a cycle", () => {
    writeFileSync(root, sheet("power.kicad_sch", "power.kicad_sch"), "utf8");
    writeFileSync(join(dir, "power.kicad_sch"), sheet("board.kicad_sch"), "utf8");

    expect(name(projectSheets(root))).toEqual(["board.kicad_sch", "power.kicad_sch"]);
  });

  it("finds the root of a .kicad_pro, and nothing for a project with none", () => {
    writeFileSync(root, sheet(), "utf8");
    writeFileSync(join(dir, "board.kicad_pro"), "{}", "utf8");
    expect(name(projectSheets(join(dir, "board.kicad_pro")))).toEqual(["board.kicad_sch"]);
    expect(projectSheets(join(dir, "nothing-here.kicad_pro"))).toEqual([]);
  });

  it("keeps a sheet that will not parse, and stops descending there", () => {
    // a broken sheet is still part of the design; it just cannot say what it
    // contains, and losing the rest of the hierarchy over it would be worse
    writeFileSync(root, sheet("power.kicad_sch"), "utf8");
    writeFileSync(join(dir, "power.kicad_sch"), "(kicad_sch (version", "utf8");
    expect(name(projectSheets(root))).toEqual(["board.kicad_sch", "power.kicad_sch"]);
  });
});

describe("writing only into the design", () => {
  let dir: string;
  let inDesign: string;
  let stray: string;
  let root: string;
  let project: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kinv-hier-w-"));
    root = join(dir, "board.kicad_sch");
    project = join(dir, "board.kicad_pro");
    inDesign = join(dir, "encoder.kicad_sch");
    stray = join(dir, "_autosave-encoder.kicad_sch");

    writeFileSync(root, sheet("encoder.kicad_sch"), "utf8");
    writeFileSync(project, "{}", "utf8");
    copyFileSync(fixture("kicad10", "encoder.kicad_sch"), inDesign);
    copyFileSync(fixture("kicad10", "encoder.kicad_sch"), stray);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("leaves an autosave of the same sheet alone", () => {
    // the autosave carries the same references and the same values, so a value
    // check cannot catch this one: only knowing the hierarchy can
    const untouched = readFileSync(stray, "utf8");
    const plan = planFieldWrite(project, [{ refs: ["R10002"], fields: { MPN: "AAA-1" } }]);

    expect(plan.edits).toHaveLength(1);
    expect(plan.edits[0]?.file).toBe(inDesign);
    applyFieldWrite(plan);

    expect(readFileSync(inDesign, "utf8")).toContain('(property "MPN" "AAA-1"');
    expect(readFileSync(stray, "utf8")).toBe(untouched);
  });
});
