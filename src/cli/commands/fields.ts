import { basename } from "node:path";
import { Command } from "commander";

import { dirtyFiles } from "../../adapters/git.js";
import {
  applyFieldWrite,
  planFieldWrite,
  type RewritePlan,
} from "../../adapters/kicad/schematic-edit.js";
import {
  readAssignments,
  readCatalog,
  writeAssignments,
  writeCatalog,
} from "../../adapters/store/inventory.js";
import { applyAdopt, planAdopt } from "../../core/inventory/adopt.js";
import { fieldsToWrite } from "../../core/inventory/fields.js";
import { buildReport } from "../../report.js";
import { pad } from "../render.js";

function renderPlan(plan: RewritePlan): void {
  const byFile = new Map<string, typeof plan.edits>();
  for (const edit of plan.edits) {
    const list = byFile.get(edit.file);
    if (list === undefined) byFile.set(edit.file, [edit]);
    else list.push(edit);
  }

  for (const [file, edits] of [...byFile].sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`  ${basename(file)}`);
    for (const edit of edits) {
      const change =
        edit.from === undefined
          ? `+ ${edit.field} = "${edit.to}"`
          : `  ${edit.field}: "${edit.from}" → "${edit.to}"`;
      console.log(`    ${edit.ref.padEnd(10)} ${change}`);
      if (edit.alsoAffects.length > 0) {
        console.log(
          `    ${" ".repeat(10)} also ${edit.alsoAffects.join(", ")} — one symbol, several placements`,
        );
      }
    }
  }
}

export function fieldsCommand(): Command {
  const write = new Command("write")
    .description("push the resolved MPNs into the schematic's symbol fields")
    .argument("<project>", "path to a .kicad_pro or .kicad_sch")
    .option("--group-by <fields>", "kicad-cli grouping fields", "Value,Footprint")
    .option("--exclude-dnp", "drop do-not-populate parts")
    .option("--apply", "write the files; without this it only shows the diff")
    .option("--allow-dirty", "write even where git already has uncommitted changes")
    .action(
      async (
        project: string,
        opts: {
          groupBy: string;
          excludeDnp?: boolean;
          apply?: boolean;
          allowDirty?: boolean;
        },
      ) => {
        const report = await buildReport(project, {
          groupBy: opts.groupBy,
          ...(opts.excludeDnp === true ? { excludeDnp: true } : {}),
        });

        const entries = fieldsToWrite(report.parts, report.resolutions);
        if (entries.length === 0) {
          console.log("nothing to write: no part on this board has an MPN yet");
          console.log("kinv resolve <project> --set 'key=MPN'");
          return;
        }

        const plan = planFieldWrite(
          project,
          entries.map((e) => ({ refs: e.refs, valueIsOneOf: e.values, fields: e.fields })),
        );
        // The guard is about the diff, not about your working tree: after this
        // runs, `git diff` should show only what the tool did.
        if (opts.allowDirty !== true) {
          plan.dirty = dirtyFiles(plan.files.map((f) => f.path));
        }

        const symbols = new Set(plan.edits.map((e) => `${e.file}|${e.uuid}`)).size;
        if (plan.edits.length === 0) {
          console.log(`nothing to change: ${entries.length} parts, every field already written`);
          return;
        }

        console.log(
          `${plan.edits.length} fields on ${symbols} symbols in ${plan.files.length} files`,
        );
        renderPlan(plan);
        if (plan.skipped.length > 0) {
          console.log("");
          console.log(`LEFT ALONE (${plan.skipped.length})`);
          for (const s of plan.skipped.slice(0, 10)) console.log(`  ${s.ref}  ${s.reason}`);
          if (plan.skipped.length > 10) console.log(`  …and ${plan.skipped.length - 10} more`);
        }
        console.log("");

        if (opts.apply !== true) {
          if (plan.locked.length > 0) {
            console.log(
              `KiCad has this project open (${plan.locked.map((f) => basename(f)).join(", ")}).`,
            );
          }
          if (plan.dirty.length > 0) {
            console.log(`uncommitted changes in ${plan.dirty.map((f) => basename(f)).join(", ")}.`);
          }
          console.log("dry run — nothing written. Add --apply to do it.");
          return;
        }

        const result = applyFieldWrite(plan);
        console.log(
          `wrote ${result.symbolsChanged} symbols in ${result.filesChanged.length} files · backups: ${result.backups
            .map((f) => basename(f))
            .join(", ")}`,
        );
      },
    );

  const read = new Command("read")
    .description("take the MPNs and vendors the schematic already carries into the catalog")
    .argument("<project>", "path to a .kicad_pro or .kicad_sch")
    .option("--group-by <fields>", "kicad-cli grouping fields", "Value,Footprint")
    .option("--exclude-dnp", "drop do-not-populate parts")
    .option("--apply", "write the catalog; without this it only shows what it would take")
    .action(
      async (project: string, opts: { groupBy: string; excludeDnp?: boolean; apply?: boolean }) => {
        const report = await buildReport(project, {
          groupBy: opts.groupBy,
          ...(opts.excludeDnp === true ? { excludeDnp: true } : {}),
        });

        const plan = planAdopt(report.parts, readCatalog(), readAssignments());
        const shown = plan.entries.filter((e) => e.status !== "agrees");
        const agreed = plan.entries.length - shown.length;

        if (shown.length === 0) {
          console.log(
            plan.entries.length === 0
              ? `nothing to read: no symbol on this board carries an MPN field (${plan.silent} parts)`
              : `nothing to read: all ${agreed} parts the schematic names already match the catalog`,
          );
          if (plan.entries.length === 0) console.log("kinv fields write <project> --apply");
          return;
        }

        for (const entry of shown) {
          const detail =
            entry.status === "conflict"
              ? `conflict: schematic says ${entry.mpn}, catalog says ${entry.disagrees[0]?.catalog}`
              : `${entry.status === "new" ? "adopt" : "fill"} ${entry.mpn}` +
                (Object.keys(entry.fills).length > 0
                  ? ` (+${Object.keys(entry.fills).join(", ")})`
                  : "");
          console.log(`  ${pad(entry.key, 34)} ${detail}`);
          for (const d of entry.disagrees) {
            if (d.field === "MPN") continue;
            console.log(
              `  ${" ".repeat(34)} ${d.field}: keeping "${d.catalog}", schematic says "${d.schematic}"`,
            );
          }
        }
        console.log("");

        const conflicts = shown.filter((e) => e.status === "conflict").length;
        const takeable = shown.length - conflicts;
        console.log(
          `${takeable} to take, ${conflicts} conflicting, ${agreed} already agreed, ${plan.silent} silent`,
        );

        if (opts.apply !== true) {
          console.log("dry run — the catalog is untouched. Add --apply to do it.");
          return;
        }

        const result = applyAdopt(plan, readCatalog(), readAssignments());
        // The catalog first: an assignment pointing at a part that is not there
        // yet is the one order these two writes must not happen in.
        writeCatalog(result.catalog);
        writeAssignments(result.assignments);
        console.log(
          `adopted ${result.adopted.length} parts, filled in ${result.filled.length}` +
            (conflicts > 0 ? ` · ${conflicts} conflicts left for you` : ""),
        );
      },
    );

  return new Command("fields")
    .description("read and write the symbol fields KiCad exports in a BOM")
    .addCommand(write)
    .addCommand(read);
}
