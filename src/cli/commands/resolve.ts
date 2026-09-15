import { Command } from "commander";

import {
  assignmentsPath,
  catalogPath,
  initInventory,
  inventoryHome,
  readAssignments,
  readCatalog,
  writeAssignments,
  writeCatalog,
} from "../../adapters/store/inventory.js";
import { assignPart, resolveParts, unassign } from "../../core/inventory/resolve.js";
import { buildReport } from "../../report.js";
import { pad, refList } from "../render.js";

/** `R|10k|0402=RC0402FR-0710KL` or `…=RC0402FR-0710KL@Yageo`. */
function parseSet(spec: string): { key: string; mpn: string; manufacturer: string } {
  const split = spec.indexOf("=");
  if (split < 0) throw new Error(`--set wants key=MPN, got "${spec}"`);
  const key = spec.slice(0, split).trim();
  const rest = spec.slice(split + 1).trim();
  const at = rest.lastIndexOf("@");
  return at < 0
    ? { key, mpn: rest, manufacturer: "" }
    : { key, mpn: rest.slice(0, at).trim(), manufacturer: rest.slice(at + 1).trim() };
}

export function initCommand(): Command {
  return new Command("init")
    .description("create the inventory directory and its files")
    .action(() => {
      const home = initInventory();
      console.log(`inventory at ${home}`);
      console.log(`  ${catalogPath()}`);
      console.log(`  ${assignmentsPath()}`);
      console.log("");
      console.log("One catalog for every board: a part chosen once is reused on the next.");
      console.log("Set KINV_HOME to keep it somewhere else.");
    });
}

export function resolveCommand(): Command {
  return new Command("resolve")
    .description("which real part each generic is bought as (offline: you type the MPN)")
    .argument("<project>", "path to a .kicad_pro or .kicad_sch, or an exported .csv")
    .option("--group-by <fields>", "kicad-cli grouping fields", "Value,Footprint")
    .option("--exclude-dnp", "drop do-not-populate parts")
    .option(
      "--set <key=MPN>",
      "assign one part, repeatable; MPN@Manufacturer to name the maker",
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .option(
      "--clear <key>",
      "drop an assignment",
      (v: string, p: string[]) => [...p, v],
      [] as string[],
    )
    .option("--all", "list every part, not only the unresolved ones")
    .option("--json", "machine-readable output")
    .action(
      async (
        project: string,
        opts: {
          groupBy: string;
          excludeDnp?: boolean;
          set: string[];
          clear: string[];
          all?: boolean;
          json?: boolean;
        },
      ) => {
        // The same report the UI and `kinv check` draw from, rather than a
        // second reading of the board: building the parts list here skipped the
        // geometry step that decides what is a purchase at all, and counted 81
        // parts where everything else counted 87.
        const report = await buildReport(project, {
          groupBy: opts.groupBy,
          ...(opts.excludeDnp === true ? { excludeDnp: true } : {}),
        });
        const parts = report.parts;
        const known = new Set(parts.map((p) => p.key));

        let catalog = readCatalog();
        let assignments = readAssignments();
        let changed = false;

        for (const key of opts.clear) {
          if (!known.has(key)) throw new Error(`no part on this board keyed ${key}`);
          assignments = unassign(key, assignments);
          changed = true;
        }

        for (const spec of opts.set) {
          const { key, mpn, manufacturer } = parseSet(spec);
          // Refusing an unknown key is the point: a typo would otherwise sit in
          // the catalog for every future board, attached to nothing.
          if (!known.has(key)) throw new Error(`no part on this board keyed ${key}`);
          const result = assignPart(key, { mpn, manufacturer }, catalog, assignments);
          catalog = result.catalog;
          assignments = result.assignments;
          changed = true;
        }

        if (changed) {
          // Catalog first: an assignment pointing at a part that is not there
          // yet is the one order these two writes must not happen in.
          writeCatalog(catalog);
          writeAssignments(assignments);
        }

        const resolutions = resolveParts(parts, catalog, assignments);
        const byKey = new Map(resolutions.map((r) => [r.key, r]));
        const listed = parts.filter(
          (p) => opts.all === true || byKey.get(p.key)?.part === undefined,
        );

        if (opts.json === true) {
          console.log(
            JSON.stringify(
              {
                home: inventoryHome(),
                parts: parts.map((p) => ({
                  ...byKey.get(p.key),
                  value: p.value,
                  placements: p.placements,
                })),
              },
              null,
              2,
            ),
          );
          return;
        }

        if (listed.length > 0) {
          console.log(
            opts.all === true
              ? "EVERY PART"
              : "NOT YET RESOLVED  —  kinv resolve <project> --set 'key=MPN'",
          );
          for (const part of listed) {
            const r = byKey.get(part.key);
            const bought = r?.part
              ? `${r.part.mpn}${r.part.manufacturer === "" ? "" : ` · ${r.part.manufacturer}`}`
              : r?.suggestedMpn !== undefined
                ? `(the value is already a part number: ${r.suggestedMpn})`
                : "";
            console.log(`  ${pad(part.key, 30)} ${pad(`${part.placements}×`, 5)} ${bought}`);
            if (bought === "") console.log(`  ${" ".repeat(30)}       ${refList(part.refs, 8)}`);
          }
          console.log("");
        }

        const assigned = resolutions.filter((r) => r.part !== undefined).length;
        console.log(
          `${assigned} of ${parts.length} parts resolved · ${catalog.length} in the catalog · ${inventoryHome()}`,
        );
        if (assigned < parts.length) process.exitCode = 1;
      },
    );
}
