import { Command } from "commander";

import { watchProject } from "../../adapters/kicad/watch.js";
import { buildReport, type Report } from "../../report.js";
import { renderFindings, renderIssueList } from "../render.js";

/** `91 → 89 (−2)`, or just the number when nothing moved. */
function delta(label: string, now: number, before: number | undefined): string {
  if (before === undefined || before === now) return `${now} ${label}`;
  const change = now - before;
  return `${before} → ${now} ${label} (${change > 0 ? "+" : "−"}${Math.abs(change)})`;
}

function renderReport(report: Report, previous: Report | undefined, full: boolean): void {
  if (full) {
    const findings = renderFindings(report.findings);
    if (findings !== "") console.log(findings + "\n");
    const issues = renderIssueList(report.issues);
    if (issues !== "") console.log(issues + "\n");
  }

  const s = report.summary;
  const c = report.counts;
  console.log(
    [
      delta("placements", s.placements, previous?.summary.placements),
      delta("BOM lines", s.lines, previous?.summary.lines),
      delta("distinct parts", s.parts, previous?.summary.parts),
    ].join(" · "),
  );
  console.log(
    [
      delta("findings", c.findings, previous?.counts.findings),
      delta("errors", c.errors, previous?.counts.errors),
      delta("warnings", c.warnings, previous?.counts.warnings),
      delta("not bought", c.excluded, previous?.counts.excluded),
    ].join(" · "),
  );
}

export function watchCommand(): Command {
  return new Command("watch")
    .description("re-read the project whenever you save in KiCad, and report what changed")
    .argument("<project>", "path to a .kicad_pro or .kicad_sch, or an exported .csv")
    .option("--group-by <fields>", "kicad-cli grouping fields", "Value,Footprint")
    .option("--exclude-dnp", "drop do-not-populate parts")
    .option("--near <percent>", "flag values closer together than this", "2")
    .option("--include-excluded", "keep test points and mounting holes as parts")
    .option("--summary", "print only the counts on each change, not the full report")
    .action(
      async (
        project: string,
        opts: {
          groupBy: string;
          excludeDnp?: boolean;
          near: string;
          includeExcluded?: boolean;
          summary?: boolean;
        },
      ) => {
        const near = Number(opts.near);
        const reportOptions = {
          groupBy: opts.groupBy,
          ...(opts.excludeDnp === true ? { excludeDnp: true } : {}),
          ...(Number.isFinite(near) ? { nearValuePercent: near } : {}),
          ...(opts.includeExcluded === true ? { includeExcluded: true } : {}),
        };

        let previous: Report | undefined;
        let running = false;
        let queued = false;

        const refresh = async (): Promise<void> => {
          // A save while a run is in flight schedules exactly one more run:
          // KiCad writing thirteen sheets must not start thirteen exports.
          if (running) {
            queued = true;
            return;
          }
          running = true;
          const started = Date.now();
          try {
            const report = await buildReport(project, reportOptions);
            const stamp = new Date().toLocaleTimeString();
            console.log(`\n── ${stamp}  (${Date.now() - started} ms) ─────────────────────────`);
            renderReport(report, previous, opts.summary !== true);
            previous = report;
          } catch (err) {
            // A half-written schematic, a locked file, a library that moved:
            // report it and keep watching. Exiting here would be the worst
            // possible behaviour for a tool you leave running all afternoon.
            console.error(`\n! ${err instanceof Error ? err.message : String(err)}`);
          } finally {
            running = false;
            if (queued) {
              queued = false;
              void refresh();
            }
          }
        };

        await refresh();
        console.log("\nwatching for saves · ctrl-c to stop");

        const watcher = watchProject(project, () => void refresh());
        const stop = (): void => {
          watcher.stop();
          process.exit(0);
        };
        process.on("SIGINT", stop);
        process.on("SIGTERM", stop);

        // The watcher's sweep interval holds the event loop open; this just
        // stops the action from resolving and letting commander finish.
        await new Promise(() => {
          /* until ctrl-c */
        });
      },
    );
}
