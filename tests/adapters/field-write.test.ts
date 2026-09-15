import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { dirtyFiles } from "../../src/adapters/git.js";
import { applyFieldWrite, planFieldWrite } from "../../src/adapters/kicad/schematic-edit.js";
import { child, parseSexpr, type SList } from "../../src/adapters/kicad/sexpr.js";
import { fixture } from "../fixtures/index.js";

/**
 * Two real KiCad dialects, because they disagree about exactly the thing a
 * field writer has to get right: KiCad 9 puts `(hide yes)` inside `(effects …)`
 * and KiCad 10 puts it directly under the property.
 */
const dialects = [
  {
    name: "KiCad 10",
    file: fixture("kicad10", "encoder.kicad_sch"),
    ref: "R10002",
    value: "10k",
    /** Where this dialect writes the hide token. */
    hiddenInEffects: false,
  },
  {
    name: "KiCad 9",
    file: fixture("kicad9", "Arduino_Pro_Mini.kicad_sch"),
    ref: "J7",
    value: "Digital",
    hiddenInEffects: true,
  },
] as const;

describe.each(dialects)("writing fields into a $name schematic", (dialect) => {
  let dir: string;
  let sheet: string;
  let project: string;
  let original: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kinv-fields-"));
    sheet = join(dir, "board.kicad_sch");
    project = join(dir, "board.kicad_pro");
    copyFileSync(dialect.file, sheet);
    writeFileSync(project, "{}", "utf8");
    original = readFileSync(sheet, "utf8");
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const plan = (fields: Record<string, string>) =>
    planFieldWrite(project, [{ refs: [dialect.ref], fields }]);

  it("adds a field the symbol did not have", () => {
    const p = plan({ MPN: "RC0402FR-0710KL" });
    expect(p.edits).toHaveLength(1);
    expect(p.edits[0]?.from).toBeUndefined();
    applyFieldWrite(p);

    const after = readFileSync(sheet, "utf8");
    expect(after).toContain('(property "MPN" "RC0402FR-0710KL"');
    // still one file KiCad can read
    expect(() => parseSexpr(after)).not.toThrow();
  });

  it("writes the new field hidden, the way this file writes hidden fields", () => {
    // a part number belongs in the BOM, not drawn on the sheet — and the two
    // dialects say "hidden" in different places, which is why the field is
    // cloned from one the file already has rather than emitted from a template
    applyFieldWrite(plan({ MPN: "RC0402FR-0710KL" }));
    const after = readFileSync(sheet, "utf8");
    const added = after.slice(after.indexOf('(property "MPN"'));
    const block = added.slice(0, added.indexOf('(property "', 12));

    expect(block).toContain("(hide yes)");
    const hideAt = block.indexOf("(hide yes)");
    const effectsAt = block.indexOf("(effects");
    expect(hideAt > effectsAt).toBe(dialect.hiddenInEffects);
  });

  it("changes a field that is already there", () => {
    applyFieldWrite(plan({ MPN: "AAA-1" }));
    const first = readFileSync(sheet, "utf8");

    applyFieldWrite(plan({ MPN: "BBB-2" }));
    const second = readFileSync(sheet, "utf8");

    expect(second).toContain('(property "MPN" "BBB-2"');
    expect(second).not.toContain("AAA-1");
    // the second write replaced a value; it did not add a second field
    expect(second.match(/\(property "MPN"/g)).toHaveLength(1);
    expect(second.length).toBe(first.length - "AAA-1".length + "BBB-2".length);
  });

  it("is byte-identical after a round trip", () => {
    // the acceptance test for the splicer: if it reflows, re-quotes or
    // normalises anything on the way, the file will not come back the same
    applyFieldWrite(
      planFieldWrite(project, [{ refs: [dialect.ref], fields: { Value: "TEMP-1" } }]),
    );
    expect(readFileSync(sheet, "utf8")).not.toBe(original);

    applyFieldWrite(
      planFieldWrite(project, [{ refs: [dialect.ref], fields: { Value: dialect.value } }]),
    );
    expect(readFileSync(sheet, "utf8")).toBe(original);
  });

  it("has nothing to do when every field already says so", () => {
    applyFieldWrite(plan({ MPN: "AAA-1" }));
    const written = readFileSync(sheet, "utf8");

    expect(plan({ MPN: "AAA-1" }).edits).toEqual([]);
    expect(readFileSync(sheet, "utf8")).toBe(written);
  });

  it("adds several fields to one symbol in one pass", () => {
    const p = plan({ MPN: "AAA-1", Manufacturer: "Acme", "DigiKey#": "111-AAA-ND" });
    expect(p.edits).toHaveLength(3);
    applyFieldWrite(p);

    const after = readFileSync(sheet, "utf8");
    expect(after).toContain('(property "MPN" "AAA-1"');
    expect(after).toContain('(property "Manufacturer" "Acme"');
    expect(after).toContain('(property "DigiKey#" "111-AAA-ND"');
    expect(() => parseSexpr(after)).not.toThrow();
  });

  /** The `lib_symbols` block, byte for byte. */
  const librarySection = (text: string): string => {
    const node = child(parseSexpr(text), "lib_symbols") as SList;
    return text.slice(node.start, node.end);
  };

  it("never touches the library definitions", () => {
    // lib_symbols carries properties of its own; they define the symbol rather
    // than place it, and editing one would follow every part on the sheet
    const before = librarySection(original);
    applyFieldWrite(plan({ MPN: "AAA-1" }));
    expect(librarySection(readFileSync(sheet, "utf8"))).toBe(before);
  });

  it("inserts with the line ending the file already uses", () => {
    // KiCad writes CRLF on Windows and .gitattributes marks these files -text,
    // so an LF line would leave the file mixed and the next diff unreadable
    const crlf = original.includes("\r\n");
    applyFieldWrite(plan({ MPN: "AAA-1" }));

    const after = readFileSync(sheet, "utf8");
    const at = after.indexOf('(property "MPN"');
    const lineStart = after.lastIndexOf("\n", at);

    // the inserted field starts its own line, indented like its siblings
    expect(after.slice(lineStart + 1, at)).toMatch(/^\t+$/);
    // and that line break is the one the rest of the file uses
    expect(after[lineStart - 1] === "\r").toBe(crlf);
  });
});

describe("a reference is not unique", () => {
  let dir: string;
  let sheet: string;
  let project: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kinv-dup-"));
    sheet = join(dir, "board.kicad_sch");
    project = join(dir, "board.kicad_pro");
    copyFileSync(fixture("kicad10", "encoder.kicad_sch"), sheet);
    writeFileSync(project, "{}", "utf8");
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("refuses to label a symbol whose value says it is a different part", () => {
    // the reference board has two symbols answering to R10001 in different
    // sheets — one 10k, one 83k8 — because a project directory can hold sheets
    // annotated separately or not in the current hierarchy at all. Writing
    // "this is a 10k" onto the 83k8 is the worst thing this code could do.
    const original = readFileSync(sheet, "utf8");
    const plan = planFieldWrite(project, [
      { refs: ["R10002"], valueIsOneOf: ["4k7"], fields: { MPN: "RC0402FR-0104KL" } },
    ]);

    expect(plan.edits).toEqual([]);
    expect(plan.skipped[0]?.reason).toContain('reads "10k" here, not "4k7"');
    expect(plan.skipped[0]?.reason).toContain("same reference");
    expect(readFileSync(sheet, "utf8")).toBe(original);
  });

  it("accepts any spelling the part was built from", () => {
    // 100n and 100nF are one purchase; either is the right symbol to label
    const plan = planFieldWrite(project, [
      { refs: ["R10002"], valueIsOneOf: ["10K", "10k"], fields: { MPN: "AAA-1" } },
    ]);
    expect(plan.edits).toHaveLength(1);
    expect(plan.skipped).toEqual([]);
  });
});

describe("the git guard", () => {
  let dir: string;
  let sheet: string;
  let project: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kinv-git-"));
    sheet = join(dir, "board.kicad_sch");
    project = join(dir, "board.kicad_pro");
    copyFileSync(fixture("kicad10", "encoder.kicad_sch"), sheet);
    writeFileSync(project, "{}", "utf8");
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const git = (...argv: string[]): void => {
    execFileSync("git", argv, { cwd: dir, stdio: "ignore", windowsHide: true });
  };

  it("says nothing outside a repository", () => {
    expect(dirtyFiles([sheet])).toEqual([]);
  });

  it("finds a file with uncommitted changes", () => {
    git("init", "-q");
    git("-c", "user.email=t@e.st", "-c", "user.name=t", "add", ".");
    git("-c", "user.email=t@e.st", "-c", "user.name=t", "commit", "-qm", "board");
    expect(dirtyFiles([sheet])).toEqual([]);

    writeFileSync(sheet, `${readFileSync(sheet, "utf8")}\n; edited`, "utf8");
    expect(dirtyFiles([sheet])).toEqual([sheet]);
  });

  it("refuses to write on top of one", () => {
    // the guard is about the diff: after this runs, `git diff` should show
    // only what the tool did
    const plan = planFieldWrite(project, [{ refs: ["R10002"], fields: { MPN: "AAA-1" } }]);
    plan.dirty = [sheet];
    expect(() => applyFieldWrite(plan)).toThrow(/uncommitted changes/);
  });
});
