import type { PartRollup } from "../consolidate/findings.js";
import type { Resolution } from "./types.js";

/**
 * The schematic fields a resolved part is worth writing back.
 *
 * Only what the tool actually decided. `Value` and `Footprint` are the
 * designer's; `Description` and `Datasheet` come from the symbol library and
 * overwriting them would replace something a person chose with something a
 * distributor said. What is left is the part number, who makes it, and where
 * to buy it — the three facts a BOM export needs and a schematic cannot
 * currently tell anyone.
 */
export function fieldsForPart(resolution: Resolution): Record<string, string> {
  const part = resolution.part;
  if (part === undefined) return {};

  const fields: Record<string, string> = { MPN: part.mpn };
  if (part.manufacturer !== "") fields["Manufacturer"] = part.manufacturer;
  // Supplier-neutral names: the board is not bought from one distributor
  // forever, and a field called `DigiKey#` would say otherwise.
  if (part.supplier !== undefined) fields["Supplier"] = part.supplier;
  if (part.orderNumber !== undefined) fields["Supplier#"] = part.orderNumber;
  return fields;
}

export type FieldPlanEntry = {
  key: string;
  refs: string[];
  /** The spellings this part's BOM lines used, so the writer can check it found the right symbol. */
  values: string[];
  fields: Record<string, string>;
};

/** Every assigned part's fields, against the placements that carry them. */
export function fieldsToWrite(
  parts: readonly PartRollup[],
  resolutions: readonly Resolution[],
): FieldPlanEntry[] {
  const byKey = new Map(resolutions.map((r) => [r.key, r]));
  return parts.flatMap((part) => {
    const resolution = byKey.get(part.key);
    if (resolution === undefined) return [];
    const fields = fieldsForPart(resolution);
    if (Object.keys(fields).length === 0) return [];
    // Every spelling that fed this part: 100n and 100nF are one purchase, and
    // either is the right symbol to write the part number onto.
    const values = [...new Set(part.sources.map((s) => s.value))];
    return [{ key: part.key, refs: part.refs, values, fields }];
  });
}
