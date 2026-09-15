import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  assignmentsPath,
  catalogPath,
  initInventory,
  inventoryHome,
  readAssignments,
  readCatalog,
  writeAssignments,
  writeCatalog,
} from "../../src/adapters/store/inventory.js";
import type { PartRollup } from "../../src/core/consolidate/findings.js";
import { assignPart, partId, resolveParts, unassign } from "../../src/core/inventory/resolve.js";
import type { CatalogPart } from "../../src/core/inventory/types.js";

function part(key: string, extra: Partial<PartRollup> = {}): PartRollup {
  return {
    key,
    label: "RES 10K OHM 0402",
    cls: "resistor",
    value: "10k",
    pkg: "0402",
    placements: 1,
    refs: ["R1"],
    sources: [],
    issueCount: 0,
    resolved: false,
    fields: {},
    ...extra,
  };
}

describe("part ids", () => {
  it("folds the ways people type one part number", () => {
    // the MPN is the identity; two catalog rows for the same part is a bug
    expect(partId("RC0603FR-0710KL")).toBe("rc0603fr-0710kl");
    expect(partId(" rc0603fr 0710kl ")).toBe("rc0603fr-0710kl");
    expect(partId("RC0603FR/0710KL")).toBe("rc0603fr-0710kl");
  });

  it("refuses a part number with nothing in it", () => {
    expect(() => assignPart("R|10k|0402", { mpn: "   " }, [], [])).toThrow(/needs an MPN/);
    expect(() => assignPart("R|10k|0402", { mpn: "///" }, [], [])).toThrow(/nothing usable/);
  });
});

describe("assigning a part", () => {
  const now = (): string => "2026-09-07T12:00:00.000Z";

  it("adds the part and records the decision", () => {
    const result = assignPart(
      "R|10k|0402",
      { mpn: "RC0402FR-0710KL", manufacturer: "Yageo" },
      [],
      [],
      now,
    );
    expect(result.catalog).toEqual([
      {
        id: "rc0402fr-0710kl",
        mpn: "RC0402FR-0710KL",
        manufacturer: "Yageo",
        firstKey: "R|10k|0402",
        addedAt: now(),
      },
    ]);
    expect(result.assignments).toEqual([
      { key: "R|10k|0402", partId: "rc0402fr-0710kl", decidedAt: now(), by: "user" },
    ]);
  });

  it("reuses one catalog entry across two keys", () => {
    // the reason the catalog is shared: a part chosen once is chosen
    const first = assignPart("R|10k|0402", { mpn: "RC0402FR-0710KL" }, [], [], now);
    const second = assignPart(
      "R|10k|0603",
      { mpn: "rc0402fr-0710kl" },
      first.catalog,
      first.assignments,
      now,
    );
    expect(second.catalog).toHaveLength(1);
    expect(second.assignments.map((a) => a.key).sort()).toEqual(["R|10k|0402", "R|10k|0603"]);
    // and the MPN keeps the capitalisation it was first entered with
    expect(second.catalog[0]?.mpn).toBe("RC0402FR-0710KL");
  });

  it("fills a gap without overwriting what the catalog already knew", () => {
    const first = assignPart(
      "R|10k|0402",
      { mpn: "RC0402FR-0710KL", manufacturer: "Yageo", datasheet: "https://example/ds.pdf" },
      [],
      [],
      now,
    );
    const second = assignPart(
      "R|10k|0603",
      {
        mpn: "RC0402FR-0710KL",
        manufacturer: "",
        supplier: "digikey",
        orderNumber: "311-10.0KLRCT-ND",
      },
      first.catalog,
      first.assignments,
      now,
    );
    expect(second.part.manufacturer).toBe("Yageo");
    expect(second.part.datasheet).toBe("https://example/ds.pdf");
    expect(second.part.supplier).toBe("digikey");
    expect(second.part.orderNumber).toBe("311-10.0KLRCT-ND");
  });

  it("replaces an assignment rather than stacking two", () => {
    const first = assignPart("R|10k|0402", { mpn: "AAA-1" }, [], [], now);
    const second = assignPart(
      "R|10k|0402",
      { mpn: "BBB-2" },
      first.catalog,
      first.assignments,
      now,
    );
    expect(second.assignments).toHaveLength(1);
    expect(second.assignments[0]?.partId).toBe("bbb-2");
    // the abandoned part stays in the catalog: it is still a part you know
    expect(second.catalog).toHaveLength(2);
  });

  it("clears one assignment and leaves the rest", () => {
    const a = assignPart("R|10k|0402", { mpn: "AAA-1" }, [], [], now);
    const b = assignPart("C|100n|0603", { mpn: "BBB-2" }, a.catalog, a.assignments, now);
    expect(unassign("R|10k|0402", b.assignments).map((x) => x.key)).toEqual(["C|100n|0603"]);
  });
});

describe("what a board resolves to", () => {
  it("pairs each part with its assignment and catalog entry", () => {
    const catalog: CatalogPart[] = [
      {
        id: "aaa-1",
        mpn: "AAA-1",
        manufacturer: "Acme",
        addedAt: "2026-09-07T12:00:00.000Z",
      },
    ];
    const resolutions = resolveParts([part("R|10k|0402"), part("C|100n|0603")], catalog, [
      { key: "R|10k|0402", partId: "aaa-1", decidedAt: "x", by: "user" },
    ]);
    expect(resolutions[0]?.part?.mpn).toBe("AAA-1");
    expect(resolutions[1]?.part).toBeUndefined();
  });

  it("offers the MPN a pre-resolved part already carries, without assigning it", () => {
    // entering something in a catalog that outlives the board is a decision,
    // and a read does not get to make decisions
    const resolutions = resolveParts(
      [part("L|IHLP6767GZER100M01|6767", { value: "IHLP6767GZER100M01", resolved: true })],
      [],
      [],
    );
    expect(resolutions[0]?.suggestedMpn).toBe("IHLP6767GZER100M01");
    expect(resolutions[0]?.assignment).toBeUndefined();
  });

  it("survives an assignment pointing at a part that is not in the catalog", () => {
    const resolutions = resolveParts(
      [part("R|10k|0402")],
      [],
      [{ key: "R|10k|0402", partId: "gone", decidedAt: "x", by: "user" }],
    );
    expect(resolutions[0]?.assignment).toBeDefined();
    expect(resolutions[0]?.part).toBeUndefined();
  });
});

describe("the inventory on disk", () => {
  let home: string;
  const previous = process.env["KINV_HOME"];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "kinv-home-"));
    process.env["KINV_HOME"] = home;
  });

  afterEach(() => {
    if (previous === undefined) delete process.env["KINV_HOME"];
    else process.env["KINV_HOME"] = previous;
    rmSync(home, { recursive: true, force: true });
  });

  it("lives where KINV_HOME says", () => {
    expect(inventoryHome()).toBe(home);
    expect(catalogPath()).toBe(join(home, "catalog.json"));
  });

  it("writes sorted, so a one-part change is a one-line diff", () => {
    writeCatalog([
      { id: "zzz", mpn: "ZZZ", manufacturer: "Z", addedAt: "2026-01-01" },
      { id: "aaa", mpn: "AAA", manufacturer: "A", addedAt: "2026-01-01" },
    ]);
    const text = readFileSync(catalogPath(), "utf8");
    expect(text.indexOf('"aaa"')).toBeLessThan(text.indexOf('"zzz"'));
    // keys within a record are sorted too, and the file ends with a newline
    expect(text.indexOf('"addedAt"')).toBeLessThan(text.indexOf('"mpn"'));
    expect(text.endsWith("\n")).toBe(true);
  });

  it("round-trips both files", () => {
    const result = assignPart("R|10k|0402", { mpn: "RC0402FR-0710KL" }, [], []);
    writeCatalog(result.catalog);
    writeAssignments(result.assignments);

    expect(readCatalog()).toEqual(result.catalog);
    expect(readAssignments()).toEqual(result.assignments);
  });

  it("reads nothing rather than throwing when there is nothing to read", () => {
    expect(readCatalog()).toEqual([]);
    expect(readAssignments()).toEqual([]);
  });

  it("creates both files on init", () => {
    expect(initInventory()).toBe(home);
    expect(readFileSync(catalogPath(), "utf8")).toContain('"parts"');
    expect(readFileSync(assignmentsPath(), "utf8")).toContain('"assignments"');
  });
});
