/**
 * A real, buyable thing.
 *
 * `spec` is deliberately absent from the stored record even though §3 of the
 * README sketched one: the generic need a part satisfies is exactly what its
 * canonical key says, the assignment already carries that key, and a second
 * copy of it in the catalog is a second thing to keep in step. `firstKey` is
 * kept as provenance — what you were looking at when you entered the part —
 * not as the authority on what it can satisfy.
 */
export type CatalogPart = {
  /** Stable local id, derived from the MPN. */
  id: string;
  mpn: string;
  manufacturer: string;
  /**
   * Who you buy it from and their ordering number — the two columns you fill
   * in yourself.
   *
   * Deliberately one supplier and one number, not a table of distributors with
   * live prices: the tool has no way to look either up, and no business
   * deciding where a part comes from. It carries what you decided so the next
   * board does not ask again.
   */
  supplier?: string;
  orderNumber?: string;
  /**
   * The package of the part you actually buy — `0402`, `SOIC-8`, `QFN-56`.
   *
   * Never filled in for you. Copying the board's own package here would make
   * the check that compares them always pass, which is worse than not having
   * it: a blank means "you did not say", and the tool stays quiet.
   */
  package?: string;
  datasheet?: string;
  notes?: string;
  firstKey?: string;
  addedAt: string;
};

/** Step 2's output: the decision "this generic is bought as this part". */
export type Assignment = {
  key: string;
  partId: string;
  decidedAt: string;
  /** `user` typed it; `rule` means the tool derived it and you accepted it. */
  by: "user" | "rule";
};

/** What one part on a board currently resolves to. */
export type Resolution = {
  key: string;
  assignment: Assignment | undefined;
  part: CatalogPart | undefined;
  /**
   * An MPN the tool already knows without asking: a passive whose *value* is a
   * part number was chosen before any generic was. Offered, never assumed.
   */
  suggestedMpn: string | undefined;
};
