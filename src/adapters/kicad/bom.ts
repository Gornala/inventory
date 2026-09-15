import { readFileSync } from "node:fs";
import { basename } from "node:path";

import { expandRefs } from "../../core/parse/refdes.js";
import type { BomLine } from "../../core/types.js";
import { parseCsvRecords } from "./csv.js";

/** Column aliases, so a hand-exported BOM with KiCad's default labels also works. */
const aliases: Record<string, readonly string[]> = {
  refs: ["Reference", "References", "Refs", "Designator"],
  value: ["Value"],
  footprint: ["Footprint"],
  datasheet: ["Datasheet"],
  description: ["Description"],
  quantity: ["QUANTITY", "Quantity", "Qty"],
  dnp: ["DNP"],
};

function pick(record: Record<string, string>, names: readonly string[]): string | undefined {
  for (const name of names) {
    const v = record[name];
    if (v !== undefined) return v;
  }
  return undefined;
}

/**
 * kicad-cli *localises* generated column values — the DNP column reads
 * "Nicht bestücken" on a German install. So DNP is "the cell is not empty",
 * never a comparison against any particular word.
 */
function isDnp(cell: string | undefined): boolean {
  return cell !== undefined && cell.trim() !== "";
}

export function parseBomCsv(csv: string, source: string): BomLine[] {
  const records = parseCsvRecords(csv);
  const known = new Set(Object.values(aliases).flat());

  return records.map((record) => {
    const refs = expandRefs(pick(record, aliases.refs as string[]) ?? "");
    const quantityCell = pick(record, aliases.quantity as string[]);
    const parsedQuantity = Number(quantityCell);

    const fields: Record<string, string> = {};
    for (const [name, value] of Object.entries(record)) {
      if (!known.has(name) && value.trim() !== "") fields[name] = value;
    }

    return {
      refs,
      value: pick(record, aliases.value as string[]) ?? "",
      footprint: pick(record, aliases.footprint as string[]) ?? "",
      datasheet: pick(record, aliases.datasheet as string[]) || undefined,
      description: pick(record, aliases.description as string[]) || undefined,
      quantity: Number.isFinite(parsedQuantity) && quantityCell ? parsedQuantity : refs.length,
      dnp: isDnp(pick(record, aliases.dnp as string[])),
      fields,
      source,
    };
  });
}

export function readBomCsv(path: string): BomLine[] {
  return parseBomCsv(readFileSync(path, "utf8"), basename(path));
}
