import { describe, expect, it } from "vitest";

import type { PartRollup } from "../../src/core/consolidate/findings.js";
import { applyAdopt, planAdopt, schematicPart } from "../../src/core/inventory/adopt.js";
import { assignPart } from "../../src/core/inventory/resolve.js";
import type { Assignment, CatalogPart } from "../../src/core/inventory/types.js";

/**
 * Reading the schematic's own fields back into the catalog.
 *
 * The other half of `kinv fields write`: the point of putting MPNs and vendors
 * on the symbols is that the work survives without `~/.kinv`, and that is only
 * true if something can read them again.
 */
function part(key: string, fields: Record<string, string>): PartRollup {
  return {
    key,
    label: "RES 10K OHM 0402",
    cls: "resistor",
    value: "10k",
    pkg: "0402",
    placements: 2,
    refs: ["R1", "R2"],
    sources: [],
    issueCount: 0,
    resolved: false,
    fields,
  };
}

const RESISTOR = "R|10k|0402";
const fully = {
  MPN: "RC0402FR-0710KL",
  Manufacturer: "Yageo",
  Supplier: "digikey",
  "Supplier#": "311-10.0KLRCT-ND",
};

/** The catalog as it stands after typing one MPN by hand. */
function resolved(
  key: string,
  mpn: string,
  extra: Record<string, string> = {},
): {
  catalog: CatalogPart[];
  assignments: Assignment[];
} {
  const result = assignPart(key, { mpn, ...extra }, [], []);
  return { catalog: result.catalog, assignments: result.assignments };
}

describe("what a symbol claims", () => {
  it("reads the four fields the tool writes", () => {
    expect(schematicPart(part(RESISTOR, fully))).toEqual({
      mpn: "RC0402FR-0710KL",
      manufacturer: "Yageo",
      supplier: "digikey",
      orderNumber: "311-10.0KLRCT-ND",
    });
  });

  it("takes a part number under any of the names a designer uses", () => {
    // a board that was never near this tool still has its MPNs picked up
    expect(schematicPart(part(RESISTOR, { PN: "RC0402FR-0710KL" })).mpn).toBe("RC0402FR-0710KL");
    expect(schematicPart(part(RESISTOR, { "Part Number": "AAA-1" })).mpn).toBe("AAA-1");
    expect(schematicPart(part(RESISTOR, { mpn: "lowercase-1" })).mpn).toBe("lowercase-1");
    expect(schematicPart(part(RESISTOR, { Vendor: "mouser" })).supplier).toBe("mouser");
  });

  it("refuses a value two spellings disagree about", () => {
    // 100n and 100nF roll up into one part; if their MPN fields differ the
    // merged field carries both, and picking one would be the tool deciding
    const merged = part(RESISTOR, { MPN: "RC0402FR-0710KL · RC0603FR-0710KL" });
    expect(schematicPart(merged).mpn).toBe("");
  });

  it("says nothing rather than guessing when the field is blank", () => {
    expect(schematicPart(part(RESISTOR, { MPN: "   ", Manufacturer: "Yageo" })).mpn).toBe("");
  });
});

describe("planning the import", () => {
  it("adopts a part the catalog has never heard of", () => {
    const plan = planAdopt([part(RESISTOR, fully)], [], []);
    expect(plan.silent).toBe(0);
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0]).toMatchObject({
      key: RESISTOR,
      mpn: "RC0402FR-0710KL",
      status: "new",
      fills: {
        manufacturer: "Yageo",
        supplier: "digikey",
        orderNumber: "311-10.0KLRCT-ND",
      },
      disagrees: [],
    });
  });

  it("counts the parts whose symbols say nothing", () => {
    const plan = planAdopt([part(RESISTOR, { Description: "Resistor" })], [], []);
    expect(plan.entries).toEqual([]);
    expect(plan.silent).toBe(1);
  });

  it("fills only what the catalog is missing", () => {
    // the MPN was typed in the UI; the vendor was filled in on the schematic
    const { catalog, assignments } = resolved(RESISTOR, "RC0402FR-0710KL", {
      manufacturer: "Yageo",
    });
    const plan = planAdopt([part(RESISTOR, fully)], catalog, assignments);

    expect(plan.entries[0]).toMatchObject({
      status: "fills",
      fills: { supplier: "digikey", orderNumber: "311-10.0KLRCT-ND" },
      disagrees: [],
    });
  });

  it("reports a disagreement instead of overwriting a decision", () => {
    const { catalog, assignments } = resolved(RESISTOR, "RC0402FR-0710KL", {
      manufacturer: "Yageo",
      supplier: "mouser",
    });
    const plan = planAdopt([part(RESISTOR, fully)], catalog, assignments);

    expect(plan.entries[0]?.fills).toEqual({ orderNumber: "311-10.0KLRCT-ND" });
    expect(plan.entries[0]?.disagrees).toEqual([
      { field: "supplier", schematic: "digikey", catalog: "mouser" },
    ]);
  });

  it("never resolves two different part numbers by itself", () => {
    const { catalog, assignments } = resolved(RESISTOR, "SOMETHING-ELSE");
    const plan = planAdopt([part(RESISTOR, fully)], catalog, assignments);

    expect(plan.entries[0]).toMatchObject({
      status: "conflict",
      disagrees: [{ field: "MPN", schematic: "RC0402FR-0710KL", catalog: "SOMETHING-ELSE" }],
    });
  });

  it("says so when the two already agree", () => {
    const { catalog, assignments } = resolved(RESISTOR, "RC0402FR-0710KL", {
      manufacturer: "Yageo",
      supplier: "digikey",
      orderNumber: "311-10.0KLRCT-ND",
    });
    expect(planAdopt([part(RESISTOR, fully)], catalog, assignments).entries[0]).toMatchObject({
      status: "agrees",
      fills: {},
      disagrees: [],
    });
  });

  it("recognises a part another board already entered", () => {
    // the MPN is in the catalog with a manufacturer, but this key is unassigned
    const { catalog } = resolved("R|10k|0603", "RC0402FR-0710KL", { manufacturer: "Yageo" });
    const plan = planAdopt([part(RESISTOR, fully)], catalog, []);

    // it assigns the key and adds only what that catalog row lacks
    expect(plan.entries[0]).toMatchObject({
      status: "new",
      fills: { supplier: "digikey", orderNumber: "311-10.0KLRCT-ND" },
    });
  });

  it("touches nothing", () => {
    const { catalog, assignments } = resolved(RESISTOR, "SOMETHING-ELSE");
    const before = JSON.stringify({ catalog, assignments });
    planAdopt([part(RESISTOR, fully)], catalog, assignments);
    expect(JSON.stringify({ catalog, assignments })).toBe(before);
  });
});

describe("applying the import", () => {
  const clock = (): string => "2026-09-08T00:00:00.000Z";

  it("adds the part and the assignment, marked as derived", () => {
    const plan = planAdopt([part(RESISTOR, fully)], [], []);
    const result = applyAdopt(plan, [], [], clock);

    expect(result.catalog).toMatchObject([
      {
        id: "rc0402fr-0710kl",
        mpn: "RC0402FR-0710KL",
        manufacturer: "Yageo",
        supplier: "digikey",
        orderNumber: "311-10.0KLRCT-ND",
        firstKey: RESISTOR,
      },
    ]);
    // "rule", not "user": the tool read this out of a file, and the audit log
    // should not claim it was typed
    expect(result.assignments).toEqual([
      { key: RESISTOR, partId: "rc0402fr-0710kl", decidedAt: clock(), by: "rule" },
    ]);
    expect(result.adopted).toEqual([RESISTOR]);
  });

  it("leaves a conflicting part exactly as it was", () => {
    const { catalog, assignments } = resolved(RESISTOR, "SOMETHING-ELSE");
    const plan = planAdopt([part(RESISTOR, fully)], catalog, assignments);
    const result = applyAdopt(plan, catalog, assignments, clock);

    expect(result.adopted).toEqual([]);
    expect(result.filled).toEqual([]);
    expect(result.catalog.map((p) => p.mpn)).toEqual(["SOMETHING-ELSE"]);
    expect(result.assignments).toEqual(assignments);
  });

  it("keeps the catalog's own value where the two disagree", () => {
    const { catalog, assignments } = resolved(RESISTOR, "RC0402FR-0710KL", { supplier: "mouser" });
    const plan = planAdopt([part(RESISTOR, fully)], catalog, assignments);
    const result = applyAdopt(plan, catalog, assignments, clock);

    const stored = result.catalog[0];
    expect(stored?.supplier).toBe("mouser");
    expect(stored?.orderNumber).toBe("311-10.0KLRCT-ND");
    expect(result.filled).toEqual([RESISTOR]);
    // and the assignment it already had is not re-stamped
    expect(result.assignments).toEqual(assignments);
  });

  it("is a no-op the second time", () => {
    const first = applyAdopt(planAdopt([part(RESISTOR, fully)], [], []), [], [], clock);
    const again = planAdopt([part(RESISTOR, fully)], first.catalog, first.assignments);

    expect(again.entries[0]?.status).toBe("agrees");
    const second = applyAdopt(again, first.catalog, first.assignments, clock);
    expect(second.catalog).toEqual(first.catalog);
    expect(second.assignments).toEqual(first.assignments);
  });
});
