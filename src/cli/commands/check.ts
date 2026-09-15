import { Command } from "commander";

import { readBomCsv } from "../../adapters/kicad/bom.js";
import { exportBom } from "../../adapters/kicad/cli.js";
import { readAssignments, readCatalog } from "../../adapters/store/inventory.js";
import { readSolved } from "../../adapters/store/solved.js";
import { consolidate, partsByKey } from "../../core/consolidate/findings.js";
import { findingId, findingSignature } from "../../core/consolidate/identity.js";
import { packageIssues } from "../../core/inventory/package-check.js";
import { resolveParts } from "../../core/inventory/resolve.js";
import { analyzeProject } from "../../report.js";
import { analyzeBom } from "../../core/parse/spec.js";
import type { AnalyzedLine } from "../../core/types.js";
import {
  countBySeverity,
  renderExcluded,
  renderFindings,
  renderIssueList,
  renderSummary,
} from "../render.js";

export type LoadOptions = {
  groupBy?: string;
  excludeDnp?: boolean;
  /** Keep test points and mounting holes in the parts list. */
  includeExcluded?: boolean;
};

/** A `.csv` is read directly; anything else goes through kicad-cli. */
export async function loadProject(project: string, options: LoadOptions): Promise<AnalyzedLine[]> {
  const lines = project.toLowerCase().endsWith(".csv")
    ? readBomCsv(project)
    : await exportBom(project, {
        ...(options.groupBy !== undefined ? { groupBy: options.groupBy } : {}),
        ...(options.excludeDnp === true ? { excludeDnp: true } : {}),
      });
  return analyzeBom(lines, options.includeExcluded === true ? { excludeClasses: [] } : {});
}

export function checkCommand(): Command {
  return new Command("check")
    .description("consolidation report and defect check for a project")
    .argument("<project>", "path to a .kicad_pro or .kicad_sch, or an exported .csv")
    .option("--group-by <fields>", "kicad-cli grouping fields", "Value,Footprint")
    .option("--exclude-dnp", "drop do-not-populate parts")
    .option("--near <percent>", "flag values closer together than this", "2")
    .option("--include-excluded", "keep test points and mounting holes as parts")
    .option("--quiet", "summary and exit code only")
    .option("--all", "include findings settled in the UI")
    .option("--strict", "exit non-zero on warnings too, not just errors")
    .action(
      async (
        project: string,
        opts: {
          groupBy: string;
          excludeDnp?: boolean;
          near: string;
          includeExcluded?: boolean;
          quiet?: boolean;
          all?: boolean;
          strict?: boolean;
        },
      ) => {
        // The same reading of the board the UI and `kinv resolve` get. Doing
        // its own used to skip the geometry step that decides what is a
        // purchase, and reported two parts fewer than the page did.
        const { lines: analyzed } = await analyzeProject(project, {
          groupBy: opts.groupBy,
          ...(opts.excludeDnp === true ? { excludeDnp: true } : {}),
          ...(opts.includeExcluded === true ? { includeExcluded: true } : {}),
        });

        const near = Number(opts.near);
        const all = consolidate(analyzed, {
          nearValuePercent: Number.isFinite(near) ? near : 2,
        });

        // Findings settled in the UI stay settled here, so a pre-commit hook
        // stops asking about a decision you have already taken. `--all` is the
        // way to see them again without reopening anything.
        const marks = new Map(readSolved(project).map((m) => [m.id, m]));
        const settled =
          opts.all === true
            ? []
            : all.filter((f) => marks.get(findingId(f))?.signature === findingSignature(f));
        const findings = all.filter((f) => !settled.includes(f));
        // The part-vs-pads check needs the catalog, which the per-line analysis
        // knows nothing about; it is folded in here so `kinv check` fails on it
        // like any other error.
        const parts = partsByKey(analyzed.filter((l) => l.excluded === undefined));
        const catalogIssues = packageIssues(
          parts,
          resolveParts(parts, readCatalog(), readAssignments()),
        );
        const counts = countBySeverity(analyzed);
        for (const issue of catalogIssues) {
          counts[issue.severity] = (counts[issue.severity] ?? 0) + 1;
        }

        if (opts.quiet !== true) {
          const report = renderFindings(findings);
          if (report !== "") console.log(report + "\n");
          const issues = renderIssueList([...analyzed.flatMap((l) => l.issues), ...catalogIssues]);
          if (issues !== "") console.log(issues + "\n");
          const skipped = renderExcluded(analyzed);
          if (skipped !== "") console.log(skipped + "\n");
        }

        console.log(renderSummary(analyzed));
        console.log(
          `${findings.length} consolidation findings · ` +
            (settled.length > 0 ? `${settled.length} settled · ` : "") +
            `${counts["error"] ?? 0} errors · ${counts["warning"] ?? 0} warnings`,
        );

        const failing =
          (counts["error"] ?? 0) > 0 || (opts.strict === true && (counts["warning"] ?? 0) > 0);
        if (failing) process.exitCode = 1;
      },
    );
}
