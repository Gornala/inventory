import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";

import { toCsv } from "./csv.js";
import { supplierFileName, type OrderPlan } from "../../core/inventory/order.js";

/** One file on disk, and enough about it to tell whether it is the one you meant. */
export type OrderFile = {
  name: string;
  path: string;
  /** Read back out of the file name, so a file from an older run still says who it is for. */
  supplier: string;
  /** Data lines — the header, if there is one, is not one of them. */
  lines: number;
  pieces: number;
  writtenAt: string;
};

/**
 * The file a supplier's upload form eats.
 *
 * A quantity and their part number, and nothing else. A third column carrying
 * the canonical key is on offer — a bag of parts on the bench can then be
 * matched back to a line without guessing — but it is off by default, because
 * a form that was not expecting it is a form that rejects the upload, and the
 * whole point of these files is that they go straight in.
 */
export function supplierCsv(
  lines: readonly { quantity: number; key: string; part: { orderNumber?: string; mpn: string } }[],
  options: { reference: boolean; header: boolean },
): string {
  const columns = ["Quantity", "Part Number"];
  if (options.reference) columns.push("Customer Reference");

  const rows = lines.map((l) => ({
    Quantity: l.quantity,
    // The supplier's own number if you gave one; the MPN is the fallback,
    // because most forms accept a manufacturer part number too.
    "Part Number": l.part.orderNumber ?? l.part.mpn,
    "Customer Reference": l.key,
  }));

  const csv = toCsv(columns, rows);
  return options.header ? csv : csv.slice(csv.indexOf("\r\n") + 2);
}

/** Writes one file per supplier and says what went into each. */
export function writeOrderFiles(
  plan: OrderPlan,
  dir: string,
  options: { reference: boolean; header: boolean },
): OrderFile[] {
  return plan.orders.map((order) => {
    const name = supplierFileName(order.supplier);
    const path = resolvePath(join(dir, name));
    writeFileSync(path, supplierCsv(order.lines, options), "utf8");
    return {
      name,
      path,
      supplier: order.supplier,
      lines: order.lines.length,
      pieces: order.lines.reduce((n, l) => n + l.quantity, 0),
      writtenAt: new Date().toISOString(),
    };
  });
}

/**
 * The order files already sitting in a directory.
 *
 * Counted out of the files themselves rather than remembered from the run that
 * wrote them: what you are about to upload is what is on disk, including the
 * file an older run left behind and the one you edited by hand.
 */
export function listOrderFiles(dir: string): OrderFile[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /^order\..+\.csv$/i.test(name))
    .sort()
    .map((name) => {
      const path = resolvePath(join(dir, name));
      const counted = summarise(readFileSync(path, "utf8"));
      return {
        name,
        path,
        supplier: name.slice("order.".length, -".csv".length),
        ...counted,
        writtenAt: new Date(statSync(path).mtimeMs).toISOString(),
      };
    });
}

/**
 * Lines and pieces, from the text.
 *
 * `--no-header` is a real option, so a header is detected rather than assumed,
 * and the quantity is read off the front of the line: these files are written
 * by `toCsv` and a quantity is a number, so nothing here needs the full reader.
 */
function summarise(text: string): { lines: number; pieces: number } {
  const rows = text.split(/\r?\n/).filter((line) => line.trim() !== "");
  const body = rows.length > 0 && /^"?quantity"?,/i.test(rows[0] ?? "") ? rows.slice(1) : rows;
  let pieces = 0;
  for (const row of body) {
    const first = Number((row.split(",")[0] ?? "").replace(/"/g, ""));
    if (Number.isFinite(first)) pieces += first;
  }
  return { lines: body.length, pieces };
}
