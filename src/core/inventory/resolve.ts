import type { PartRollup } from "../consolidate/findings.js";
import type { Assignment, CatalogPart, Resolution } from "./types.js";

/**
 * A stable id from a manufacturer part number.
 *
 * The MPN is the identity — it is what you order, and two catalog entries for
 * `RC0603FR-0710KL` are a bug, not a feature. Case and punctuation vary in how
 * people type it, so the id folds both, and the MPN as typed is kept verbatim
 * alongside.
 */
export function partId(mpn: string): string {
  return mpn
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Fields a person can type. Everything else about a part comes later, from a distributor. */
export type PartEntry = {
  mpn: string;
  manufacturer?: string;
  supplier?: string;
  orderNumber?: string;
  package?: string;
  datasheet?: string;
  notes?: string;
};

export type AssignResult = {
  catalog: CatalogPart[];
  assignments: Assignment[];
  part: CatalogPart;
};

/**
 * Records "this generic is bought as this part", adding the part to the
 * catalog if it is new.
 *
 * An MPN already in the catalog is reused rather than duplicated — that reuse
 * is the whole point of a catalog shared across boards — and any new detail
 * typed alongside it (a manufacturer that was blank, a datasheet) fills in what
 * was missing without overwriting what was there.
 */
export function assignPart(
  key: string,
  entry: PartEntry,
  catalog: readonly CatalogPart[],
  assignments: readonly Assignment[],
  now: () => string = () => new Date().toISOString(),
): AssignResult {
  const mpn = entry.mpn.trim();
  if (mpn === "") throw new Error("an assignment needs an MPN");

  const id = partId(mpn);
  if (id === "") throw new Error(`"${mpn}" has nothing usable as a part number`);

  const existing = catalog.find((p) => p.id === id);
  // Typed detail fills a gap; it never overwrites what the catalog already has.
  const fill = (typed: string | undefined, had: string | undefined): string | undefined =>
    typed?.trim() || had;
  const datasheet = fill(entry.datasheet, existing?.datasheet);
  const notes = fill(entry.notes, existing?.notes);
  const supplier = fill(entry.supplier, existing?.supplier);
  const orderNumber = fill(entry.orderNumber, existing?.orderNumber);
  const pkg = fill(entry.package, existing?.package);

  const part: CatalogPart = {
    id,
    mpn: existing?.mpn ?? mpn,
    manufacturer: fill(entry.manufacturer, existing?.manufacturer) ?? "",
    ...(supplier === undefined ? {} : { supplier }),
    ...(orderNumber === undefined ? {} : { orderNumber }),
    ...(pkg === undefined ? {} : { package: pkg }),
    ...(datasheet === undefined ? {} : { datasheet }),
    ...(notes === undefined ? {} : { notes }),
    firstKey: existing?.firstKey ?? key,
    addedAt: existing?.addedAt ?? now(),
  };

  return {
    catalog: [...catalog.filter((p) => p.id !== id), part],
    assignments: [
      ...assignments.filter((a) => a.key !== key),
      { key, partId: id, decidedAt: now(), by: "user" },
    ],
    part,
  };
}

export function unassign(key: string, assignments: readonly Assignment[]): Assignment[] {
  return assignments.filter((a) => a.key !== key);
}

/**
 * What each part on the board currently resolves to.
 *
 * A part whose *value* is already a manufacturer part number carries its own
 * answer — those are the `pre-resolved` findings — so its MPN is offered as a
 * suggestion. It is not assigned automatically: entering something in a catalog
 * that outlives the board is a decision, and the tool does not make decisions
 * on a read.
 */
export function resolveParts(
  parts: readonly PartRollup[],
  catalog: readonly CatalogPart[],
  assignments: readonly Assignment[],
): Resolution[] {
  const byKey = new Map(assignments.map((a) => [a.key, a]));
  const byId = new Map(catalog.map((p) => [p.id, p]));

  return parts.map((part) => {
    const assignment = byKey.get(part.key);
    return {
      key: part.key,
      assignment,
      part: assignment === undefined ? undefined : byId.get(assignment.partId),
      suggestedMpn: part.resolved ? part.value : undefined,
    };
  });
}

/** Parts with no assignment yet — what `kinv resolve` has left to ask about. */
export function unresolved(resolutions: readonly Resolution[]): Resolution[] {
  return resolutions.filter((r) => r.assignment === undefined);
}

/**
 * Changes who a part is bought from and their ordering number.
 *
 * `assignPart` fills gaps and never overwrites, which is right for detail
 * typed alongside an MPN — a manufacturer that was blank gets one — and wrong
 * here: a vendor column you cannot correct is a column you cannot use. So this
 * one overwrites, and a blank clears the field, because "I have not decided
 * after all" has to be sayable too.
 *
 * It edits the *catalog part*, so a second board buying the same MPN gets the
 * same vendor. That is the catalog doing its job; it is also why this needs an
 * MPN first, and refuses rather than inventing a part to hang a vendor on.
 */
export function setSupplier(
  key: string,
  entry: { supplier?: string; orderNumber?: string },
  catalog: readonly CatalogPart[],
  assignments: readonly Assignment[],
): { catalog: CatalogPart[]; part: CatalogPart } {
  const assignment = assignments.find((a) => a.key === key);
  if (assignment === undefined) throw new Error(`${key} has no part yet — give it an MPN first`);
  const existing = catalog.find((p) => p.id === assignment.partId);
  if (existing === undefined) throw new Error(`${key} points at a part the catalog does not have`);

  const supplier = (entry.supplier ?? "").trim();
  const orderNumber = (entry.orderNumber ?? "").trim();
  // A cleared field is *absent*, not an empty string: the catalog is read as
  // JSON by eye and by git, and "supplier": "" would be a decision on the page.
  const part: CatalogPart = { ...existing };
  if (supplier === "") delete part.supplier;
  else part.supplier = supplier;
  if (orderNumber === "") delete part.orderNumber;
  else part.orderNumber = orderNumber;

  return { catalog: [...catalog.filter((p) => p.id !== existing.id), part], part };
}
