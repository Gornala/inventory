import { fieldJoin, type PartRollup } from "../consolidate/findings.js";
import { partNumberFields } from "../parse/spec.js";
import { partId } from "./resolve.js";
import type { Assignment, CatalogPart } from "./types.js";

/**
 * Reading back what the schematic already says about a part.
 *
 * `kinv fields write` puts `MPN`, `Manufacturer`, `Supplier` and `Supplier#`
 * onto the symbols; this is the other half of that round trip. Without it the
 * catalog is the only place the work exists, and a board handed to someone else
 * — or opened after `~/.kinv` is gone — is back to knowing nothing.
 *
 * It is also what makes copying a symbol in KiCad worth something: the copy
 * carries the fields, so the part it becomes arrives already answered.
 *
 * Nothing here is automatic. Reading a file is not permission to write a
 * catalog that outlives the board, so this produces a plan and the decision to
 * apply it is a separate, explicit act.
 */

/** What each fact can be called on a symbol. The first name is the one we write. */
const manufacturerFields = ["Manufacturer", "Mfr", "Mfg", "MFR"];
const supplierFields = ["Supplier", "Vendor", "Distributor"];
const orderNumberFields = ["Supplier#", "SupplierPN", "Supplier Part Number", "Vendor#"];

/**
 * One field's value, by any of its names, or "" if the schematic does not say.
 *
 * A merged disagreement is not a value: when `100n` and `100nF` roll up into
 * one part and their MPN fields differ, `bomFields` keeps both joined, and
 * `RC0402FR-0710KL · RC0603FR-0710KL` is a question rather than an answer.
 * Importing either spelling would be the tool picking, which is the one thing
 * step 2 exists to stop it doing.
 */
function fieldValue(fields: Record<string, string>, names: readonly string[]): string {
  const lookup = new Map(Object.entries(fields).map(([k, v]) => [k.toLowerCase(), v]));
  for (const name of names) {
    const raw = lookup.get(name.toLowerCase());
    if (raw === undefined) continue;
    const value = raw.trim();
    if (value === "" || value.includes(fieldJoin.trim())) continue;
    return value;
  }
  return "";
}

/** What one symbol's fields claim about the part it is. */
export type SchematicPart = {
  mpn: string;
  manufacturer: string;
  supplier: string;
  orderNumber: string;
};

export function schematicPart(part: PartRollup): SchematicPart {
  return {
    mpn: fieldValue(part.fields, partNumberFields),
    manufacturer: fieldValue(part.fields, manufacturerFields),
    supplier: fieldValue(part.fields, supplierFields),
    orderNumber: fieldValue(part.fields, orderNumberFields),
  };
}

/**
 * What importing one part would do.
 *
 * - `new` — the catalog has no answer for this key, and the schematic does.
 * - `fills` — the same part, with detail the catalog is missing.
 * - `agrees` — nothing to do, and worth saying so.
 * - `conflict` — the schematic names a different part than the catalog. Never
 *   resolved automatically: one of the two is out of date and only you know
 *   which.
 */
export type AdoptStatus = "new" | "fills" | "agrees" | "conflict";

export type AdoptEntry = {
  key: string;
  refs: string[];
  mpn: string;
  status: AdoptStatus;
  /** Catalog fields this would fill in, by name. */
  fills: Record<string, string>;
  /**
   * Where the schematic and the catalog say different things. The catalog
   * keeps its value in every case — a decision you made is not overwritten by
   * a file — and the disagreement is reported rather than swallowed.
   */
  disagrees: { field: string; schematic: string; catalog: string }[];
};

export type AdoptPlan = {
  entries: AdoptEntry[];
  /** Parts whose symbols carry nothing to import. */
  silent: number;
};

/**
 * What the board's own fields would add to the catalog.
 *
 * A read, and only a read: it touches nothing.
 */
export function planAdopt(
  parts: readonly PartRollup[],
  catalog: readonly CatalogPart[],
  assignments: readonly Assignment[],
): AdoptPlan {
  const byKey = new Map(assignments.map((a) => [a.key, a]));
  const byId = new Map(catalog.map((p) => [p.id, p]));

  let silent = 0;
  const entries: AdoptEntry[] = [];

  for (const part of parts) {
    const said = schematicPart(part);
    // No part number means nothing to hang the rest on, the same rule the
    // vendor columns follow: a manufacturer with no MPN is not a part.
    if (said.mpn === "") {
      silent++;
      continue;
    }

    const entry: AdoptEntry = {
      key: part.key,
      refs: part.refs,
      mpn: said.mpn,
      status: "new",
      fills: {},
      disagrees: [],
    };

    const assignment = byKey.get(part.key);
    const assigned = assignment === undefined ? undefined : byId.get(assignment.partId);

    if (assigned !== undefined && assigned.id !== partId(said.mpn)) {
      entry.status = "conflict";
      entry.disagrees.push({ field: "MPN", schematic: said.mpn, catalog: assigned.mpn });
      entries.push(entry);
      continue;
    }

    // The catalog row this MPN already has, whether or not this key points at
    // it: an MPN entered on another board is the same part.
    const existing = assigned ?? byId.get(partId(said.mpn));
    const compare = (field: string, from: string, had: string | undefined): void => {
      if (from === "") return;
      const current = (had ?? "").trim();
      if (current === "") entry.fills[field] = from;
      else if (current !== from) entry.disagrees.push({ field, schematic: from, catalog: current });
    };
    compare("manufacturer", said.manufacturer, existing?.manufacturer);
    compare("supplier", said.supplier, existing?.supplier);
    compare("orderNumber", said.orderNumber, existing?.orderNumber);

    entry.status =
      assignment === undefined ? "new" : Object.keys(entry.fills).length > 0 ? "fills" : "agrees";
    entries.push(entry);
  }

  return { entries, silent };
}

export type AdoptResult = {
  catalog: CatalogPart[];
  assignments: Assignment[];
  /** Keys that gained an assignment they did not have. */
  adopted: string[];
  /** Keys whose catalog part gained a manufacturer, supplier or order number. */
  filled: string[];
};

/**
 * Applies a plan to the catalog and the assignments.
 *
 * The merge is the one `assignPart` makes: typed detail fills a gap and never
 * overwrites. `by: "rule"`, because the tool derived this from a file — you
 * accepted it, but you did not type it, and the audit log should not claim
 * otherwise.
 */
export function applyAdopt(
  plan: AdoptPlan,
  catalog: readonly CatalogPart[],
  assignments: readonly Assignment[],
  now: () => string = () => new Date().toISOString(),
): AdoptResult {
  let nextCatalog = [...catalog];
  let nextAssignments = [...assignments];
  const adopted: string[] = [];
  const filled: string[] = [];

  for (const entry of plan.entries) {
    if (entry.status === "conflict" || entry.status === "agrees") continue;

    const id = partId(entry.mpn);
    if (id === "") continue;

    const existing = nextCatalog.find((p) => p.id === id);
    const part: CatalogPart = {
      ...(existing ?? {
        id,
        mpn: entry.mpn,
        manufacturer: "",
        firstKey: entry.key,
        addedAt: now(),
      }),
    };
    for (const [field, value] of Object.entries(entry.fills)) {
      if (field === "manufacturer") part.manufacturer = value;
      if (field === "supplier") part.supplier = value;
      if (field === "orderNumber") part.orderNumber = value;
    }

    nextCatalog = [...nextCatalog.filter((p) => p.id !== id), part];
    if (Object.keys(entry.fills).length > 0) filled.push(entry.key);

    if (entry.status === "new") {
      nextAssignments = [
        ...nextAssignments.filter((a) => a.key !== entry.key),
        { key: entry.key, partId: id, decidedAt: now(), by: "rule" },
      ];
      adopted.push(entry.key);
    }
  }

  return { catalog: nextCatalog, assignments: nextAssignments, adopted, filled };
}
