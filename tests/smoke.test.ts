import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { buildProgram } from "../src/cli/program.js";
import { version } from "../src/meta.js";
import { fixture, liveProject } from "./fixtures/index.js";

describe("cli", () => {
  it("reports the package version", () => {
    const pkg: { version: string } = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    expect(version).toBe(pkg.version);
  });

  it("exposes --version and --help without side effects", () => {
    const program = buildProgram();
    expect(program.name()).toBe("kinv");
    // commander keeps the help option out of `options`, so read the rendered help
    const help = program.helpInformation();
    expect(help).toContain("-v, --version");
    expect(help).toContain("-h, --help");
  });
});

describe("fixtures", () => {
  it("ships the reference board's BOM", () => {
    const csv = readFileSync(fixture("kicad10", "transformer_test.bom.csv"), "utf8");
    const lines = csv.trimEnd().split("\n");
    expect(lines[0]).toContain("Reference");
    expect(lines).toHaveLength(101); // header + 100 grouped BOM lines
  });

  it("ships a KiCad 10 schematic sheet", () => {
    const sch = readFileSync(fixture("kicad10", "encoder.kicad_sch"), "utf8");
    expect(sch).toContain('(generator_version "10.0")');
  });

  it("finds the live project when it is on this machine", () => {
    const project = liveProject();
    if (!project) return; // hermetic elsewhere; live checks are opt-in
    expect(project).toMatch(/\.kicad_pro$/);
  });
});
