import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { Command } from "commander";

import { toCsv } from "../../adapters/export/csv.js";
import { writeOrderFiles } from "../../adapters/export/orders.js";
import { parseCsvRecords } from "../../adapters/kicad/csv.js";
import {
  readAssignments,
  readCatalog,
  writeAssignments,
  writeCatalog,
} from "../../adapters/store/inventory.js";
import {
  orderColumns,
  orderRows,
  planOrder,
  readOrderRows,
  type OrderPlan,
} from "../../core/inventory/order.js";
import { assignPart } from "../../core/inventory/resolve.js";
import { buildReport } from "../../report.js";
import { pad } from "../render.js";

function renderPlan(plan: OrderPlan): void {
  for (const order of plan.orders) {
    const total = order.lines.reduce((n, l) => n + l.quantity, 0);
    console.log(
      `${order.supplier.toUpperCase()}  —  ${order.lines.length} lines · ${total} pieces`,
    );
    for (const line of order.lines) {
      console.log(
        `  ${pad(String(line.quantity), 6)} ${pad(line.part.orderNumber ?? "", 22)} ` +
          `${pad(line.part.mpn, 22)} ${line.key}`,
      );
    }
    console.log("");
  }

  if (plan.noSupplier.length > 0) {
    console.log(`NO SUPPLIER YET (${plan.noSupplier.length})`);
    for (const line of plan.noSupplier) {
      console.log(`  ${pad(line.part.mpn, 24)} ${line.key}`);
    }
    console.log("");
  }

  if (plan.unresolved.length > 0) {
    console.log(`NO PART NUMBER YET (${plan.unresolved.length})`);
    for (const part of plan.unresolved.slice(0, 12)) {
      console.log(`  ${pad(part.key, 30)} ${part.placements}×`);
    }
    if (plan.unresolved.length > 12) console.log(`  …and ${plan.unresolved.length - 12} more`);
    console.log("");
  }
}

export function orderCommand(): Command {
  return new Command("order")
    .description("what to buy, grouped by who you buy it from")
    .argument("<project>", "path to a .kicad_pro or .kicad_sch, or an exported .csv")
    .option("--boards <n>", "how many boards to build", "1")
    .option("--group-by <fields>", "kicad-cli grouping fields", "Value,Footprint")
    .option("--exclude-dnp", "drop do-not-populate parts")
    .option("--template <file>", "write the part list for you to fill in, and stop")
    .option("--import <file>", "read a filled-in part list into the catalog")
    .option("--out <dir>", "where the per-supplier files go", ".")
    .option("--reference", "add a customer-reference column carrying the canonical key")
    .option("--no-header", "leave the header row out, for a form that wants bare lines")
    .action(
      async (
        project: string,
        opts: {
          boards: string;
          groupBy: string;
          excludeDnp?: boolean;
          template?: string;
          import?: string;
          out: string;
          reference?: boolean;
          header: boolean;
        },
      ) => {
        const report = await buildReport(project, {
          groupBy: opts.groupBy,
          ...(opts.excludeDnp === true ? { excludeDnp: true } : {}),
        });

        if (opts.template !== undefined) {
          const rows = orderRows(report.parts, report.resolutions);
          writeFileSync(opts.template, toCsv([...orderColumns], rows), "utf8");
          const blank = rows.filter((r) => r.supplier === "" || r.order_number === "").length;
          console.log(`${rows.length} parts → ${opts.template}`);
          console.log(
            `fill in the "supplier" and "order_number" columns (${blank} still empty), then:`,
          );
          console.log(`  kinv order ${basename(project)} --import ${opts.template}`);
          return;
        }

        if (opts.import !== undefined) {
          const known = new Set(report.parts.map((p) => p.key));
          const { rows, problems } = readOrderRows(
            parseCsvRecords(readFileSync(opts.import, "utf8")),
            known,
          );

          let catalog = readCatalog();
          let assignments = readAssignments();
          for (const row of rows) {
            const result = assignPart(
              row.key,
              {
                mpn: row.mpn,
                manufacturer: row.manufacturer,
                supplier: row.supplier,
                orderNumber: row.orderNumber,
                package: row.package,
              },
              catalog,
              assignments,
            );
            catalog = result.catalog;
            assignments = result.assignments;
          }
          // The catalog first: an assignment pointing at a part that is not
          // there yet is the one order these two writes must not happen in.
          writeCatalog(catalog);
          writeAssignments(assignments);

          console.log(`${rows.length} parts read from ${basename(opts.import)}`);
          if (problems.length > 0) {
            console.log("");
            console.log(`NOT IMPORTED (${problems.length})`);
            for (const p of problems.slice(0, 10)) {
              console.log(`  line ${p.row}  ${p.key || "(no key)"} — ${p.reason}`);
            }
            if (problems.length > 10) console.log(`  …and ${problems.length - 10} more`);
          }
          console.log("");
          // Fall through: with the catalog updated, write the order files too.
          report.resolutions = report.parts.map((part) => {
            const assignment = assignments.find((a) => a.key === part.key);
            const catalogued = catalog.find((c) => c.id === assignment?.partId);
            return {
              key: part.key,
              assignment,
              part: catalogued,
              suggestedMpn: part.resolved ? part.value : undefined,
            };
          });
        }

        const boards = Math.max(1, Math.floor(Number(opts.boards) || 1));
        const plan = planOrder(report.parts, report.resolutions, boards);

        console.log(
          `${boards} board${boards === 1 ? "" : "s"} · ` +
            `${plan.orders.length} supplier${plan.orders.length === 1 ? "" : "s"} · ` +
            `quantities are placements × boards, nothing else`,
        );
        console.log("");
        renderPlan(plan);

        for (const file of writeOrderFiles(plan, opts.out, {
          reference: opts.reference === true,
          header: opts.header,
        })) {
          console.log(`→ ${file.path}`);
        }
        if (plan.orders.length === 0) {
          console.log("no part has a supplier yet — kinv order <project> --template parts.csv");
        }
      },
    );
}
