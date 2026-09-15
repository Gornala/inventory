import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  applyValueRewrite,
  planValueRewrite,
  type RewritePlan,
} from "../../src/adapters/kicad/schematic-edit.js";
import { fixture } from "../fixtures/index.js";

/**
 * A copy of a real KiCad 10 sheet, edited in a temp directory. The fixture
 * itself is never written to: it is the thing every other test reads.
 */
describe("rewriting a symbol's value", () => {
  let dir: string;
  let sheet: string;
  let project: string;
  let original: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kinv-edit-"));
    sheet = join(dir, "encoder.kicad_sch");
    project = join(dir, "encoder.kicad_pro");
    copyFileSync(fixture("kicad10", "encoder.kicad_sch"), sheet);
    writeFileSync(project, "{}", "utf8");
    original = readFileSync(sheet, "utf8");
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const plan = (refs: string[], from: string, to: string): RewritePlan =>
    planValueRewrite(project, { to, groups: [{ from, refs }] });

  it("finds the symbol a reference names, and where its value sits", () => {
    const p = plan(["R10002"], "10k", "10K");
    expect(p.edits).toHaveLength(1);
    const edit = p.edits[0];
    expect(edit?.ref).toBe("R10002");
    expect(edit?.uuid).toBe("8bdc983c-316d-485a-9d5e-c0350cc0351c");
    expect(original.slice(edit?.start, edit?.end)).toBe('"10k"');
  });

  it("changes the bytes it planned and no others", () => {
    const p = plan(["R10002"], "10k", "10 kOhm");
    applyValueRewrite(p);

    const after = readFileSync(sheet, "utf8");
    expect(after).toBe(
      original.slice(0, p.edits[0]?.start) + '"10 kOhm"' + original.slice(p.edits[0]?.end),
    );
    // and the file still parses as the same design
    expect(after).toContain('(property "Reference" "R10002"');
    expect(after).toContain('(uuid "8bdc983c-316d-485a-9d5e-c0350cc0351c")');
  });

  it("leaves a backup of what was there before", () => {
    applyValueRewrite(plan(["R10002"], "10k", "10K"));
    expect(readFileSync(`${sheet}.bak`, "utf8")).toBe(original);
  });

  it("has nothing to do when the spelling is already the one asked for", () => {
    const p = plan(["R10002"], "10k", "10k");
    expect(p.edits).toEqual([]);
    expect(p.skipped).toEqual([]);
    expect(() => applyValueRewrite(p)).toThrow(/nothing to change/);
    expect(readFileSync(sheet, "utf8")).toBe(original);
  });

  it("is byte-identical after a round trip", () => {
    // there and back again: if the splicer reflows, re-quotes or normalises
    // anything on the way, the file will not come back the same
    applyValueRewrite(plan(["R10002"], "10k", "10K"));
    expect(readFileSync(sheet, "utf8")).not.toBe(original);

    applyValueRewrite(plan(["R10002"], "10K", "10k"));
    expect(readFileSync(sheet, "utf8")).toBe(original);
  });

  it("refuses a symbol whose value has moved on since the report", () => {
    const p = plan(["R10002"], "4k7", "4.7k");
    expect(p.edits).toEqual([]);
    expect(p.skipped).toEqual([{ ref: "R10002", reason: 'Value reads "10k", not "4k7"' }]);
    expect(() => applyValueRewrite(p)).toThrow(/nothing to change/);
  });

  it("says which references it could not find", () => {
    const p = plan(["R10002", "R99999"], "10k", "10K");
    expect(p.edits.map((e) => e.ref)).toEqual(["R10002"]);
    expect(p.skipped).toEqual([{ ref: "R99999", reason: "no symbol with this reference" }]);
  });

  it("never touches the library definitions", () => {
    // lib_symbols carries (property "Value" "R") on the *definition* of a
    // resistor. It is not a placement and editing it would corrupt the library
    // cache for every part on the sheet.
    const p = plan(["R10002"], "10k", "10K");
    applyValueRewrite(p);
    const after = readFileSync(sheet, "utf8");
    expect(after).toContain('(symbol "Device:R"');
    expect(after.match(/\(property "Value" "R"/g)?.length).toBe(
      original.match(/\(property "Value" "R"/g)?.length,
    );
  });

  it("refuses to write while KiCad has the document open", () => {
    // KiCad keeps the file in memory: the next Ctrl+S there would overwrite
    // this edit and never mention it
    writeFileSync(join(dir, "~encoder.kicad_sch.lck"), "locked", "utf8");
    const p = plan(["R10002"], "10k", "10K");
    expect(p.locked).toHaveLength(1);
    expect(() => applyValueRewrite(p)).toThrow(/KiCad has this project open/);
    expect(readFileSync(sheet, "utf8")).toBe(original);
  });

  it("takes a lock on any sheet as a lock on the project", () => {
    // KiCad locks the *root* schematic and holds the whole hierarchy in
    // memory. Checking only the sheets about to be edited let a write through
    // on a project that was open, because every edit happened to be in a
    // sub-sheet — which is the common case on a real board.
    writeFileSync(join(dir, "~some_other_sheet.kicad_sch.lck"), "locked", "utf8");
    const p = plan(["R10002"], "10k", "10K");
    expect(p.locked).toHaveLength(1);
    expect(() => applyValueRewrite(p)).toThrow(/KiCad has this project open/);
    expect(readFileSync(sheet, "utf8")).toBe(original);
  });

  it("aborts when the file changed between planning and applying", () => {
    // a save from KiCad rewrites the whole file and moves every offset after
    // the change; splicing at the planned span would land in the middle of some
    // other atom, so the bytes there are checked first
    const p = plan(["R10002"], "10k", "10K");
    writeFileSync(sheet, `; saved from KiCad in the meantime\n${original}`, "utf8");
    expect(() => applyValueRewrite(p)).toThrow(/changed since the plan was made/);
    expect(readFileSync(sheet, "utf8")).toContain('(property "Value" "10k"');
  });

  it("moves several symbols in one pass, back to front", () => {
    // applying front-first would shift every later span by the length change
    const p = plan(["R10002", "C10002"], "10k", "10K");
    expect(p.edits).toHaveLength(1); // only the resistor reads 10k

    const both = plan(["C10001", "C10002"], "10n", "10nF");
    expect(both.edits.length).toBeGreaterThan(1);
    applyValueRewrite(both);

    const after = readFileSync(sheet, "utf8");
    expect(after.match(/\(property "Value" "10nF"/g)?.length).toBe(both.edits.length);
    expect(after).not.toContain('(property "Value" "10n"\n');
  });

  it("escapes a value that would otherwise break the file", () => {
    applyValueRewrite(plan(["R10002"], "10k", '10k "precision"'));
    expect(readFileSync(sheet, "utf8")).toContain('(property "Value" "10k \\"precision\\""');
  });
});
