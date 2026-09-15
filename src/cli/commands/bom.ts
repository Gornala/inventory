import { Command } from "commander";

import { displayValue } from "../../core/canonical.js";
import type { AnalyzedLine } from "../../core/types.js";
import { pad, renderIssues, renderSummary } from "../render.js";
import { loadProject } from "./check.js";

function renderTable(lines: AnalyzedLine[]): string {
  const rows = lines.map((l) => ({
    key: l.key,
    value: displayValue(l.spec),
    qty: String(l.line.refs.length),
    refs: l.line.refs.slice(0, 3).join(",") + (l.line.refs.length > 3 ? ", …" : ""),
    flag: l.issues.length > 0 ? "!" : " ",
  }));
  const w = (get: (r: (typeof rows)[number]) => string): number =>
    Math.max(0, ...rows.map((r) => get(r).length));
  const kw = Math.min(
    46,
    w((r) => r.key),
  );
  const vw = Math.min(
    14,
    w((r) => r.value),
  );

  return rows
    .map((r) => `${r.flag} ${pad(r.key, kw)}  ${pad(r.value, vw)}  ${pad(r.qty, 4)} ${r.refs}`)
    .join("\n");
}

export function bomCommand(): Command {
  return new Command("bom")
    .description("read a project's BOM and show the canonical key for every line")
    .argument("<project>", "path to a .kicad_pro or .kicad_sch, or an exported .csv")
    .option("--group-by <fields>", "kicad-cli grouping fields", "Value,Footprint")
    .option("--exclude-dnp", "drop do-not-populate parts")
    .option("--include-excluded", "keep test points and mounting holes as parts")
    .option("--issues", "list only lines with issues")
    .option("--json", "emit JSON instead of a table")
    .action(
      async (
        project: string,
        opts: {
          groupBy: string;
          excludeDnp?: boolean;
          includeExcluded?: boolean;
          issues?: boolean;
          json?: boolean;
        },
      ) => {
        const analyzed = await loadProject(project, {
          groupBy: opts.groupBy,
          ...(opts.excludeDnp === true ? { excludeDnp: true } : {}),
          ...(opts.includeExcluded === true ? { includeExcluded: true } : {}),
        });
        const shown = opts.issues === true ? analyzed.filter((l) => l.issues.length > 0) : analyzed;

        if (opts.json === true) {
          console.log(JSON.stringify(shown, null, 2));
          return;
        }

        console.log(renderTable(shown));
        console.log(`\n${renderSummary(analyzed)}`);

        const issues = renderIssues(analyzed);
        if (issues !== "") console.log(`\n${issues}`);
      },
    );
}
