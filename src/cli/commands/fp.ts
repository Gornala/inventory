import { existsSync, writeFileSync } from "node:fs";
import { Command } from "commander";

import { footprintSvg } from "../../adapters/export/footprint-svg.js";
import { libraryTable, resolveFootprint } from "../../adapters/kicad/libraries.js";
import { readFootprintFile } from "../../adapters/kicad/mod.js";
import { auditFootprints, type FootprintAudit } from "../../core/footprint/audit.js";
import { measure } from "../../core/footprint/measure.js";
import { parseFootprintName } from "../../core/footprint/name.js";
import { checkFootprint } from "../../core/footprint/check.js";
import { pad, refList } from "../render.js";
import { loadProject } from "./check.js";

function num(n: number | undefined, digits = 3): string {
  return n === undefined ? "—" : String(Number(n.toFixed(digits)));
}

function measureCommand(): Command {
  return new Command("measure")
    .description("measure one footprint and compare it with what its name claims")
    .argument("<footprint>", "Library:Name, or a path to a .kicad_mod file")
    .option("--project <path>", "project whose fp-lib-table to use", process.cwd())
    .option("--svg <file>", "write an annotated drawing to this file")
    .action((reference: string, opts: { project: string; svg?: string }) => {
      const path = reference.endsWith(".kicad_mod")
        ? reference
        : resolveFootprint(reference, libraryTable(opts.project));

      if (path === undefined || !existsSync(path)) {
        throw new Error(`cannot find footprint ${reference}`);
      }

      const file = readFootprintFile(path);
      const measured = measure(file.pads);
      const declared = parseFootprintName(file.name);
      const findings = checkFootprint(declared, measured);

      console.log(`${file.name}`);
      console.log(`  ${path}`);
      console.log("");
      console.log(`  ${pad("pads", 16)}${measured.padCount} numbered on copper`);
      if (measured.pasteOnlyPads > 0) {
        console.log(`  ${pad("", 16)}${measured.pasteOnlyPads} paste-only (stencil, not pins)`);
      }
      // "Pitch" is meaningless for a two-pad chip; the number is the centre
      // distance, and calling it pitch would invite a bogus datasheet compare.
      const pitchLabel = measured.padCount === 2 ? "pad centres" : "pitch";
      console.log(`  ${pad(pitchLabel, 16)}${num(measured.pitch)} mm`);
      console.log(`  ${pad("outer span", 16)}${num(measured.span.x)} × ${num(measured.span.y)} mm`);
      if (measured.padSize) {
        console.log(
          `  ${pad("pad size", 16)}${num(measured.padSize.width)} × ${num(measured.padSize.height)} mm`,
        );
      }
      for (const ep of measured.exposedPads) {
        console.log(`  ${pad("exposed pad", 16)}${num(ep.width)} × ${num(ep.height)} mm`);
      }
      console.log(`  ${pad("mounting", 16)}${measured.mounting}`);
      console.log(
        `  ${pad("solder paste", 16)}` +
          (measured.pinsWithPaste === 0
            ? "none — a reflow oven will not solder this"
            : `${measured.pinsWithPaste} of ${measured.padCount} pads`),
      );
      if (measured.shapes.length > 0) {
        console.log(`  ${pad("pad shapes", 16)}${measured.shapes.join(", ")}`);
      }
      if (measured.drills.length > 0) {
        console.log(`  ${pad("drills", 16)}${measured.drills.map((d) => num(d)).join(", ")} mm`);
      }
      if (file.courtyard) {
        console.log(
          `  ${pad("courtyard", 16)}${num(file.courtyard.width)} × ${num(file.courtyard.height)} mm`,
        );
      }

      console.log("");
      console.log("  the name claims:");
      console.log(
        `  ${pad("", 16)}pins ${declared.pinCount ?? "—"} · pitch ${declared.pitch ?? "—"} · ` +
          `body ${declared.body ? `${declared.body.x}×${declared.body.y}` : "—"} · ` +
          `chip ${declared.chip?.imperial ?? "—"}`,
      );

      console.log("");
      if (findings.length === 0) {
        console.log("  ✓ geometry agrees with the name");
      } else {
        for (const f of findings) {
          console.log(`  ${f.severity === "error" ? "✗" : "!"} ${pad(f.code, 22)} ${f.message}`);
        }
      }

      if (opts.svg !== undefined) {
        writeFileSync(opts.svg, footprintSvg(file.pads, measured, { title: file.name }), "utf8");
        console.log(`\n  drawing written to ${opts.svg}`);
      }
    });
}

function renderAudit(audits: readonly FootprintAudit[], verbose: boolean): void {
  const problems = audits.filter((a) => a.findings.length > 0);

  if (problems.length > 0) {
    console.log("FOOTPRINT FINDINGS");
    for (const audit of problems) {
      console.log(`  ${audit.reference}  (×${audit.placements})`);
      for (const f of audit.findings) {
        console.log(`    ${f.severity === "error" ? "✗" : "!"} ${pad(f.code, 22)} ${f.message}`);
      }
      console.log(`    ${refList(audit.refs, 8)}`);
    }
    console.log("");
  }

  if (verbose) {
    console.log("MEASURED");
    for (const audit of audits) {
      if (!audit.measured) continue;
      const m = audit.measured;
      console.log(
        `  ${pad(audit.reference, 52)} ${pad(`${m.padCount}p`, 6)}` +
          `${pad(m.pitch === undefined ? "—" : `${num(m.pitch, 2)}mm`, 9)}` +
          `${num(m.span.x, 2)}×${num(m.span.y, 2)}mm`,
      );
    }
    console.log("");
  }

  const verified = audits.filter((a) => !a.unresolved).length;
  console.log(
    `${audits.length} distinct footprints · ${verified} measured · ` +
      `${audits.length - verified} not found in any library · ` +
      `${problems.reduce((n, a) => n + a.findings.length, 0)} findings`,
  );
}

function checkFootprintsCommand(): Command {
  return new Command("check")
    .description("measure every footprint a project uses and cross-check it")
    .argument("<project>", "path to a .kicad_pro or .kicad_sch, or an exported .csv")
    .option("--group-by <fields>", "kicad-cli grouping fields", "Value,Footprint")
    .option("--all", "list the measurements, not only the findings")
    .action(async (project: string, opts: { groupBy: string; all?: boolean }) => {
      const lines = await loadProject(project, { groupBy: opts.groupBy });
      const table = libraryTable(project);

      const audits = auditFootprints(lines, (reference) => {
        const path = resolveFootprint(reference, table);
        return path === undefined ? undefined : readFootprintFile(path).pads;
      });

      renderAudit(audits, opts.all === true);
      if (audits.some((a) => a.findings.some((f) => f.severity === "error"))) {
        process.exitCode = 1;
      }
    });
}

export function fpCommand(): Command {
  return new Command("fp")
    .description("footprint measurement and verification")
    .addCommand(measureCommand())
    .addCommand(checkFootprintsCommand());
}
