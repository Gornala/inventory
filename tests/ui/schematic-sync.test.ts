import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  readAssignments,
  readCatalog,
  writeAssignments,
  writeCatalog,
} from "../../src/adapters/store/inventory.js";
import { startUiServer } from "../../src/ui/server.js";
import { fixture } from "../fixtures/index.js";

/**
 * The schematic round trip: out to the symbols, and back again.
 *
 * The point of writing MPNs and vendors onto the symbols is that the work
 * outlives `~/.kinv` — hand the project to someone else, or lose the catalog,
 * and the board still knows what it is bought as. That is only true if the
 * names the writer uses are the names the reader looks for, so the seam between
 * the two halves is what this file is really about: the second half reads the
 * column names back out of the schematic the first half wrote.
 *
 * kicad-cli is not on the CI machine, so the BOM export in the middle is stood
 * in for by a CSV built from those same names.
 */
describe("the schematic round trip", () => {
  let dir: string;
  let project: string;
  let sheet: string;
  let server: Server;
  let base: string;

  const KEY = "R|10k|0402";

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "kinv-sync-"));
    sheet = join(dir, "encoder.kicad_sch");
    project = join(dir, "board.bom.csv");
    copyFileSync(fixture("kicad10", "encoder.kicad_sch"), sheet);
    writeFileSync(project, plainCsv(), "utf8");
    writeCatalog([]);
    writeAssignments([]);

    const started = await startUiServer(project, { port: 0 });
    server = started.server;
    base = started.url;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  /** The board as KiCad exports it before anything has been written back. */
  const plainCsv = (): string =>
    [
      '"Reference","Value","Footprint","QUANTITY","DNP"',
      '"R10002","10k","Resistor_SMD:R_0402_1005Metric","1",""',
    ].join("\n");

  const post = async (path: string, body: unknown = {}): Promise<Response> =>
    fetch(new URL(path, base), {
      method: "POST",
      headers: { "content-type": "application/json", "x-kinv": "1" },
      body: JSON.stringify(body),
    });

  const json = async <T>(path: string, body: unknown = {}): Promise<T> => {
    const res = await post(path, body);
    const parsed = (await res.json()) as T & { error?: string };
    if (!res.ok) throw new Error(parsed.error ?? `HTTP ${res.status}`);
    return parsed;
  };

  /** Types an MPN and a vendor the way the parts table does. */
  const decide = async (): Promise<void> => {
    await json("api/assign", { key: KEY, mpn: "RC0402FR-0710KL", manufacturer: "Yageo" });
    await json("api/supplier", {
      key: KEY,
      supplier: "digikey",
      orderNumber: "311-10.0KLRCT-ND",
    });
  };

  /** Every `(property "Name" "Value")` the sheet now carries, by name. */
  const properties = (): Map<string, string[]> => {
    const found = new Map<string, string[]>();
    const text = readFileSync(sheet, "utf8");
    for (const m of text.matchAll(/\(property\s+"([^"]+)"\s+"([^"]*)"/g)) {
      const name = m[1] as string;
      const list = found.get(name);
      if (list === undefined) found.set(name, [m[2] as string]);
      else list.push(m[2] as string);
    }
    return found;
  };

  describe("writing the fields onto the symbols", () => {
    it("plans the four fields the catalog knows, and writes none of them yet", async () => {
      await decide();
      const plan = await json<{ edits: { ref: string; field: string; to: string }[] }>(
        "api/fields/plan",
      );

      expect(plan.edits.map((e) => e.field).sort()).toEqual([
        "MPN",
        "Manufacturer",
        "Supplier",
        "Supplier#",
      ]);
      expect(plan.edits.every((e) => e.ref === "R10002")).toBe(true);
      // a plan is a read
      expect(properties().has("MPN")).toBe(false);
      expect(existsSync(`${sheet}.bak`)).toBe(false);
    });

    it("writes them, after a backup", async () => {
      await decide();
      const result = await json<{ symbolsChanged: number; backups: string[] }>("api/fields/apply");

      expect(result.symbolsChanged).toBe(1);
      expect(result.backups).toHaveLength(1);
      expect(existsSync(`${sheet}.bak`)).toBe(true);

      const props = properties();
      expect(props.get("MPN")).toEqual(["RC0402FR-0710KL"]);
      expect(props.get("Manufacturer")).toEqual(["Yageo"]);
      expect(props.get("Supplier")).toEqual(["digikey"]);
      expect(props.get("Supplier#")).toEqual(["311-10.0KLRCT-ND"]);
    });

    it("says there is nothing to write when the schematic already says it", async () => {
      await decide();
      await json("api/fields/apply");
      const again = await json<{ edits: unknown[] }>("api/fields/plan");
      expect(again.edits).toEqual([]);
    });

    it("has nothing to write before anything is resolved", async () => {
      const plan = await json<{ edits: unknown[] }>("api/fields/plan");
      expect(plan.edits).toEqual([]);
    });
  });

  /**
   * The BOM as kicad-cli would export it *after* a write: one column per field
   * the schematic now carries, with the names read back out of the file rather
   * than typed here. If the writer ever renamed a field, this is where the
   * round trip breaks.
   */
  const exportedCsvFor = (): string => {
    const props = properties();
    const names = ["MPN", "Manufacturer", "Supplier", "Supplier#"].filter((n) => props.has(n));
    expect(names).toHaveLength(4);
    const values = names.map((n) => (props.get(n) as string[])[0] as string);
    return [
      `"Reference","Value","Footprint","QUANTITY","DNP",${names.map((n) => `"${n}"`).join(",")}`,
      `"R10002","10k","Resistor_SMD:R_0402_1005Metric","1","",${values
        .map((v) => `"${v}"`)
        .join(",")}`,
    ].join("\n");
  };

  describe("reading them back", () => {
    /** Writes the board out, loses the catalog, and re-exports the BOM. */
    const roundTrip = async (): Promise<void> => {
      await decide();
      await json("api/fields/apply");
      const csv = exportedCsvFor();
      writeCatalog([]);
      writeAssignments([]);
      writeFileSync(project, csv, "utf8");
    };

    it("rebuilds the catalog from the schematic alone", async () => {
      await roundTrip();
      expect(readCatalog()).toEqual([]);

      const plan = await json<{ entries: { key: string; mpn: string; status: string }[] }>(
        "api/adopt/plan",
      );
      expect(plan.entries).toHaveLength(1);
      expect(plan.entries[0]).toMatchObject({ key: KEY, mpn: "RC0402FR-0710KL", status: "new" });

      const result = await json<{ adopted: number; conflicts: number }>("api/adopt/apply");
      expect(result).toMatchObject({ adopted: 1, conflicts: 0 });

      // everything that was typed is back, off the schematic and nothing else
      expect(readCatalog()).toMatchObject([
        {
          mpn: "RC0402FR-0710KL",
          manufacturer: "Yageo",
          supplier: "digikey",
          orderNumber: "311-10.0KLRCT-ND",
        },
      ]);
      // "rule", because the tool read it rather than you typing it
      expect(readAssignments()).toMatchObject([{ key: KEY, by: "rule" }]);
    });

    it("is a no-op the second time", async () => {
      await roundTrip();
      await json("api/adopt/apply");
      const before = JSON.stringify({ c: readCatalog(), a: readAssignments() });

      const plan = await json<{ entries: { status: string }[] }>("api/adopt/plan");
      expect(plan.entries[0]?.status).toBe("agrees");
      await json("api/adopt/apply");
      expect(JSON.stringify({ c: readCatalog(), a: readAssignments() })).toBe(before);
    });

    it("leaves a part number the catalog disagrees with alone", async () => {
      await roundTrip();
      // you changed your mind in the UI after the schematic was written
      await json("api/assign", { key: KEY, mpn: "SOMETHING-ELSE" });

      const plan = await json<{ entries: { status: string }[] }>("api/adopt/plan");
      expect(plan.entries[0]?.status).toBe("conflict");

      const result = await json<{ adopted: number; conflicts: number }>("api/adopt/apply");
      expect(result).toMatchObject({ adopted: 0, conflicts: 1 });
      expect(readCatalog().find((p) => p.id === "something-else")).toBeDefined();
      expect(readAssignments()[0]?.partId).toBe("something-else");
    });

    it("has nothing to read from a board that carries no MPN field", async () => {
      const plan = await json<{ entries: unknown[]; silent: number }>("api/adopt/plan");
      expect(plan.entries).toEqual([]);
      expect(plan.silent).toBe(1);
    });

    it("refuses either direction from a page that is not this one", async () => {
      for (const path of ["api/fields/apply", "api/adopt/apply"]) {
        const res = await fetch(new URL(path, base), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        expect(res.status).toBe(403);
      }
      expect(properties().has("MPN")).toBe(false);
    });
  });

  describe("the two buttons in the page", () => {
    async function open(): Promise<JSDOM> {
      const html = await (await fetch(base)).text();
      const dom = new JSDOM(html, {
        url: base,
        runScripts: "dangerously",
        pretendToBeVisual: true,
        beforeParse(window) {
          (window as unknown as { fetch: typeof fetch }).fetch = ((
            input: string,
            init?: RequestInit,
          ) => fetch(new URL(String(input), base), init)) as typeof fetch;
        },
      });
      for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 5));
      dom.window.document.querySelector<HTMLButtonElement>('[data-tab="parts"]')?.click();
      return dom;
    }

    const settle = async (ticks = 80): Promise<void> => {
      for (let i = 0; i < ticks; i++) await new Promise((r) => setTimeout(r, 5));
    };

    it("shows the plan first, and writes only on the second click", async () => {
      await decide();
      const dom = await open();
      const doc = dom.window.document;
      await settle(20);

      (doc.getElementById("fieldswrite") as HTMLElement).click();
      await settle();

      const panel = doc.querySelector("#syncpanel .panel");
      expect(panel?.textContent).toContain("4 fields on 1 symbol");
      expect(panel?.textContent).toContain(".bak is written first");
      expect(panel?.textContent).toContain("RC0402FR-0710KL");
      // still a plan
      expect(properties().has("MPN")).toBe(false);

      (doc.querySelector(".fieldsapply") as HTMLElement).click();
      await settle();

      expect(properties().get("Supplier#")).toEqual(["311-10.0KLRCT-ND"]);
      expect(doc.querySelector("#syncpanel .panel")?.textContent).toContain("1 symbol written");
      dom.window.close();
    });

    it("closes the panel when the same button is pressed again", async () => {
      await decide();
      const dom = await open();
      const doc = dom.window.document;
      await settle(20);

      const button = doc.getElementById("fieldswrite") as HTMLElement;
      button.click();
      await settle();
      expect(doc.querySelector("#syncpanel .panel")).not.toBeNull();
      expect(button.classList.contains("open")).toBe(true);

      (doc.getElementById("fieldswrite") as HTMLElement).click();
      expect(doc.querySelector("#syncpanel .panel")).toBeNull();
      dom.window.close();
    });

    it("reads the schematic back into an empty catalog", async () => {
      await decide();
      await json("api/fields/apply");
      const csv = exportedCsvFor();
      writeCatalog([]);
      writeAssignments([]);
      writeFileSync(project, csv, "utf8");

      const dom = await open();
      const doc = dom.window.document;
      await settle(20);

      (doc.getElementById("adoptread") as HTMLElement).click();
      await settle();
      const panel = doc.querySelector("#syncpanel .panel");
      expect(panel?.textContent).toContain("1 part to take from the schematic");
      expect(panel?.textContent).toContain("nothing you typed is overwritten");
      expect(readCatalog()).toEqual([]);

      (doc.querySelector(".adoptapply") as HTMLElement).click();
      await settle();

      expect(readCatalog()).toMatchObject([{ supplier: "digikey" }]);
      expect(doc.querySelector("#syncpanel .panel")?.textContent).toContain("took 1 part");
      // and the table it sits above now shows the part as resolved
      expect(doc.querySelector(`#tbl-parts tr[data-key="${KEY}"]`)?.textContent).toContain(
        "RC0402FR-0710KL",
      );
      dom.window.close();
    }, 15000);

    it("says so when there is nothing to read", async () => {
      const dom = await open();
      const doc = dom.window.document;
      await settle(20);

      (doc.getElementById("adoptread") as HTMLElement).click();
      await settle();
      expect(doc.querySelector("#syncpanel .panel")?.textContent).toContain(
        "No symbol on this board carries an MPN field",
      );
      expect(doc.querySelector(".adoptapply")).toBeNull();
      dom.window.close();
    });
  });
});
