import type { PartRollup } from "../consolidate/findings.js";
import type { CatalogPart, Resolution } from "./types.js";

/**
 * One row of the sheet you fill in.
 *
 * Everything to the left of `supplier` is the tool describing the board;
 * `mpn`, `supplier` and `order_number` are yours. That division is the whole
 * design: the tool counts, you decide.
 */
export type OrderRow = {
  key: string;
  value: string;
  package: string;
  used: number;
  mpn: string;
  manufacturer: string;
  supplier: string;
  order_number: string;
  /** The package of the part *you* buy — left blank on purpose; see CatalogPart. */
  part_package: string;
  refs: string;
};

export const orderColumns: readonly (keyof OrderRow)[] = [
  "key",
  "value",
  "package",
  "used",
  "mpn",
  "manufacturer",
  "supplier",
  "order_number",
  "part_package",
  "refs",
];

/** The board's parts, with whatever the catalog already knows filled in. */
export function orderRows(
  parts: readonly PartRollup[],
  resolutions: readonly Resolution[],
): OrderRow[] {
  const byKey = new Map(resolutions.map((r) => [r.key, r]));
  return parts.map((part) => {
    const resolution = byKey.get(part.key);
    const catalogued = resolution?.part;
    return {
      key: part.key,
      value: part.value,
      package: part.pkg,
      used: part.placements,
      // A part whose value is already a part number arrives with it suggested,
      // the same way the resolve tab offers it — you still have to keep it.
      mpn: catalogued?.mpn ?? resolution?.suggestedMpn ?? "",
      manufacturer: catalogued?.manufacturer ?? "",
      supplier: catalogued?.supplier ?? "",
      order_number: catalogued?.orderNumber ?? "",
      part_package: catalogued?.package ?? "",
      refs: part.refs.join(" "),
    };
  });
}

export type ImportedRow = {
  key: string;
  mpn: string;
  manufacturer: string;
  supplier: string;
  orderNumber: string;
  package: string;
};

export type ImportProblem = { row: number; key: string; reason: string };

/**
 * Reads the sheet back.
 *
 * Rows are matched on the canonical key, which is the one column you are not
 * asked to touch. A key the board does not have is reported rather than
 * guessed at: a spreadsheet that has drifted from the board — an old export, a
 * sorted-and-mangled column — must not quietly write part numbers into the
 * catalog under names nothing will ever look up.
 */
export function readOrderRows(
  records: readonly Record<string, string>[],
  known: ReadonlySet<string>,
): { rows: ImportedRow[]; problems: ImportProblem[] } {
  const rows: ImportedRow[] = [];
  const problems: ImportProblem[] = [];

  records.forEach((record, index) => {
    const line = index + 2; // 1-based, and the header is line 1
    const cell = (name: string): string => (record[name] ?? "").trim();
    const key = cell("key");
    if (key === "") return;

    if (!known.has(key)) {
      problems.push({ row: line, key, reason: "no part on this board has this key" });
      return;
    }

    const mpn = cell("mpn");
    const supplier = cell("supplier");
    const orderNumber = cell("order_number");
    const pkg = cell("part_package");
    if (mpn === "" && supplier === "" && orderNumber === "" && pkg === "") return; // untouched

    if (mpn === "") {
      problems.push({ row: line, key, reason: "a supplier was given but no MPN" });
      return;
    }
    rows.push({
      key,
      mpn,
      manufacturer: cell("manufacturer"),
      supplier,
      orderNumber,
      package: cell("part_package"),
    });
  });

  return { rows, problems };
}

export type OrderLine = {
  key: string;
  quantity: number;
  part: CatalogPart;
  refs: string[];
};

export type SupplierOrder = {
  supplier: string;
  lines: OrderLine[];
};

export type OrderPlan = {
  boards: number;
  orders: SupplierOrder[];
  /** Parts with a part number but nobody to buy them from. */
  noSupplier: OrderLine[];
  /** Parts with no MPN at all — step 2 has not been done for these. */
  unresolved: PartRollup[];
};

/**
 * What to buy, grouped by who you buy it from.
 *
 * The quantity is placements × boards and nothing else. No stock subtraction,
 * no spares, no rounding to a pack size, no price break — every one of those
 * is a decision, and a tool that makes them quietly is a tool that can order
 * ten thousand of a five-euro part because the arithmetic said so.
 */
export function planOrder(
  parts: readonly PartRollup[],
  resolutions: readonly Resolution[],
  boards = 1,
): OrderPlan {
  const byKey = new Map(resolutions.map((r) => [r.key, r]));
  const bySupplier = new Map<string, OrderLine[]>();
  const noSupplier: OrderLine[] = [];
  const unresolved: PartRollup[] = [];

  for (const part of parts) {
    const catalogued = byKey.get(part.key)?.part;
    if (catalogued === undefined) {
      unresolved.push(part);
      continue;
    }
    const line: OrderLine = {
      key: part.key,
      quantity: part.placements * boards,
      part: catalogued,
      refs: part.refs,
    };
    const supplier = catalogued.supplier;
    if (supplier === undefined || supplier === "") {
      noSupplier.push(line);
      continue;
    }
    const lines = bySupplier.get(supplier);
    if (lines === undefined) bySupplier.set(supplier, [line]);
    else lines.push(line);
  }

  const orders = [...bySupplier]
    .map(([supplier, lines]) => ({
      supplier,
      lines: lines.sort((a, b) => a.key.localeCompare(b.key)),
    }))
    .sort((a, b) => a.supplier.localeCompare(b.supplier));

  return { boards, orders, noSupplier, unresolved };
}

/** A filename per supplier, with nothing in it a filesystem will object to. */
export function supplierFileName(supplier: string): string {
  const safe = supplier
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `order.${safe === "" ? "supplier" : safe}.csv`;
}
