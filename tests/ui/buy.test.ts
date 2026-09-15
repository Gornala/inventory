import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { assignPart } from "../../src/core/inventory/resolve.js";
import type { FolderChoice } from "../../src/adapters/os/folder.js";
import { startUiServer } from "../../src/ui/server.js";

/**
 * Buying: the two columns you fill in on the parts table, and the button that
 * turns them into one upload file per supplier.
 *
 * Driven through the real server against a throwaway board, so a vendor typed
 * in the browser genuinely reaches the catalog on disk and the files genuinely
 * land beside the project.
 */
describe("the parts to buy", () => {
  let dir: string;
  let project: string;
  let server: Server;
  let base: string;
  /**
   * What the folder dialog answers, for tests that click export.
   *
   * The real one is a modal on somebody's desktop; a test that opened it would
   * hang CI and startle whoever ran the suite. Every test here says what the
   * person at the keyboard would have said.
   */
  let answerWhere: (start: string) => Promise<FolderChoice>;

  const RESISTOR = "R|10k|0402";
  const CAPACITOR = "C|100n|0603";

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "kinv-buy-"));
    project = join(dir, "board.bom.csv");
    writeFileSync(
      project,
      [
        '"Reference","Value","Footprint","QUANTITY","DNP"',
        '"R1,R2","10k","Resistor_SMD:R_0402_1005Metric","2",""',
        '"C1","100n","Capacitor_SMD:C_0603_1608Metric","1",""',
      ].join("\n"),
      "utf8",
    );
    // The catalog is one directory for every board, so it is shared by every
    // test in this file: each starts from an empty one.
    writeCatalog([]);
    writeAssignments([]);

    // by default: "yes, beside the board" — the directory the panel already
    // offered, which is the answer these tests were written before there was
    // a question
    answerWhere = (): Promise<FolderChoice> =>
      Promise.resolve({ status: "chosen", dir } as FolderChoice);

    const started = await startUiServer(project, {
      port: 0,
      chooseFolder: (start) => answerWhere(start),
    });
    server = started.server;
    base = started.url;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  const post = (path: string, body: unknown): Promise<Response> =>
    fetch(new URL(path, base), {
      method: "POST",
      headers: { "content-type": "application/json", "x-kinv": "1" },
      body: JSON.stringify(body),
    });

  /** Gives a key an MPN, which is what a vendor hangs off. */
  const resolveIt = (key: string, mpn: string): void => {
    const result = assignPart(
      key,
      { mpn, manufacturer: "Yageo" },
      readCatalog(),
      readAssignments(),
    );
    writeCatalog(result.catalog);
    writeAssignments(result.assignments);
  };

  describe("recording who you buy it from", () => {
    it("writes the vendor and their number onto the catalog part", async () => {
      resolveIt(RESISTOR, "RC0402FR-0710KL");

      const res = await post("api/supplier", {
        key: RESISTOR,
        supplier: "digikey",
        orderNumber: "311-10.0KLRCT-ND",
      });
      expect(res.status).toBe(200);

      expect(readCatalog()).toMatchObject([
        { mpn: "RC0402FR-0710KL", supplier: "digikey", orderNumber: "311-10.0KLRCT-ND" },
      ]);
    });

    it("overwrites a vendor you got wrong, and a blank clears it", async () => {
      // assignPart fills gaps and never overwrites, which is right beside an
      // MPN and wrong for a column you have to be able to correct
      resolveIt(RESISTOR, "RC0402FR-0710KL");
      await post("api/supplier", { key: RESISTOR, supplier: "digikey", orderNumber: "311-ND" });
      await post("api/supplier", { key: RESISTOR, supplier: "mouser", orderNumber: "603-RC04" });
      expect(readCatalog()).toMatchObject([{ supplier: "mouser", orderNumber: "603-RC04" }]);

      await post("api/supplier", { key: RESISTOR, supplier: "", orderNumber: "" });
      const part = readCatalog()[0];
      expect(part).toBeDefined();
      // absent, not empty: the catalog is read by eye and by git diff
      expect(part && "supplier" in part).toBe(false);
      expect(part && "orderNumber" in part).toBe(false);
    });

    it("refuses a vendor for a part with no MPN yet", async () => {
      const res = await post("api/supplier", { key: RESISTOR, supplier: "digikey" });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(/no part yet/);
      expect(readCatalog()).toEqual([]);
    });

    it("refuses a write that did not come from this page", async () => {
      resolveIt(RESISTOR, "RC0402FR-0710KL");
      const res = await fetch(new URL("api/supplier", base), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: RESISTOR, supplier: "digikey" }),
      });
      expect(res.status).toBe(403);
      expect(readCatalog()[0]?.supplier).toBeUndefined();
    });
  });

  describe("the export", () => {
    beforeEach(async () => {
      resolveIt(RESISTOR, "RC0402FR-0710KL");
      resolveIt(CAPACITOR, "CL10B104KB8NNNC");
      await post("api/supplier", { key: RESISTOR, supplier: "digikey", orderNumber: "311-ND" });
      await post("api/supplier", { key: CAPACITOR, supplier: "digikey", orderNumber: "1276-ND" });
    });

    it("writes one file per supplier beside the board, and says what is in it", async () => {
      const res = await post("api/order", { boards: 5 });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        boards: number;
        dir: string;
        files: { name: string; lines: number; pieces: number }[];
        noSupplier: number;
        unresolved: number;
      };

      expect(body.boards).toBe(5);
      expect(body.files).toHaveLength(1);
      // 2 lines; 5 boards x (2 + 1) placements
      expect(body.files[0]).toMatchObject({ name: "order.digikey.csv", lines: 2, pieces: 15 });
      expect(body.noSupplier).toBe(0);
      expect(body.unresolved).toBe(0);

      const csv = readFileSync(join(dir, "order.digikey.csv"), "utf8");
      // two columns: the page writes the file the upload form expects
      expect(csv).toBe(["Quantity,Part Number", "5,1276-ND", "10,311-ND", ""].join("\r\n"));
    });

    it("counts the parts it left out rather than guessing at them", async () => {
      writeCatalog([]);
      writeAssignments([]);
      resolveIt(RESISTOR, "RC0402FR-0710KL"); // an MPN but nobody to buy it from

      const body = (await (await post("api/order", { boards: 1 })).json()) as {
        files: unknown[];
        noSupplier: number;
        unresolved: number;
      };
      expect(body.files).toEqual([]);
      expect(body.noSupplier).toBe(1);
      expect(body.unresolved).toBe(1);
    });

    it("lists the files on disk, counted out of the files themselves", async () => {
      await post("api/order", { boards: 2 });
      const listed = (await (await fetch(new URL("api/exports", base))).json()) as {
        dir: string;
        files: { name: string; supplier: string; lines: number; pieces: number }[];
      };

      expect(listed.dir).toContain("kinv-buy-");
      expect(listed.files).toHaveLength(1);
      expect(listed.files[0]).toMatchObject({
        name: "order.digikey.csv",
        supplier: "digikey",
        lines: 2,
        pieces: 6,
      });
    });

    it("writes into a directory you chose, and lists that one afterwards", async () => {
      // the folder dialog hands back a path; this is what the page then does
      // with it, and it is the half a machine with no dialog types by hand
      const elsewhere = join(dir, "orders");
      mkdirSync(elsewhere);

      const body = (await (await post("api/order", { boards: 1, dir: elsewhere })).json()) as {
        dir: string;
        files: { path: string }[];
      };
      expect(body.dir).toBe(elsewhere);
      expect(existsSync(join(elsewhere, "order.digikey.csv"))).toBe(true);
      expect(existsSync(join(dir, "order.digikey.csv"))).toBe(false);

      // and the panel follows: what is on disk *there* is what you upload
      const listed = (await (await fetch(new URL("api/exports", base))).json()) as {
        dir: string;
        files: unknown[];
      };
      expect(listed.dir).toBe(elsewhere);
      expect(listed.files).toHaveLength(1);
    });

    it("says so rather than creating a directory you mistyped", async () => {
      const typo = join(dir, "odrers");
      const res = await post("api/order", { boards: 1, dir: typo });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(/no such directory/);
      expect(existsSync(typo)).toBe(false);

      // and the export the page had before is still where it was
      const listed = (await (await fetch(new URL("api/exports", base))).json()) as { dir: string };
      expect(listed.dir).toBe(dir);
    });

    it("refuses to write into something that is not a directory", async () => {
      const res = await post("api/order", { boards: 1, dir: project });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(/not a directory/);
    });

    it("refuses an export that did not come from this page", async () => {
      const res = await fetch(new URL("api/order", base), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ boards: 1 }),
      });
      expect(res.status).toBe(403);
    });
  });

  describe("the table in a browser", () => {
    async function open(): Promise<JSDOM> {
      const html = await (await fetch(base)).text();
      const dom = new JSDOM(html, {
        url: base,
        runScripts: "dangerously",
        pretendToBeVisual: true,
        beforeParse(window) {
          // a real fetch pointed at the real server, so a click goes all the
          // way to disk and back
          (window as unknown as { fetch: typeof fetch }).fetch = ((
            input: string,
            init?: RequestInit,
          ) => fetch(new URL(String(input), base), init)) as typeof fetch;
        },
      });
      for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 5));
      return dom;
    }

    const settle = async (ticks = 80): Promise<void> => {
      for (let i = 0; i < ticks; i++) await new Promise((r) => setTimeout(r, 5));
    };

    it("puts the two columns you fill in beside what the board says", async () => {
      const dom = await open();
      const doc = dom.window.document;
      doc.querySelector<HTMLButtonElement>('[data-tab="parts"]')?.click();
      await settle(20);

      const headers = [...doc.querySelectorAll("#tbl-parts thead th")].map((th) =>
        (th.textContent ?? "").trim(),
      );
      // the board's own columns first, then the three you fill in, then the rest
      expect(headers.slice(0, 9)).toEqual([
        "key",
        "value",
        "class",
        "package",
        "used",
        "issues",
        "bought as",
        "vendor",
        "vendor part number",
      ]);

      const rows = [...doc.querySelectorAll("#tbl-parts tbody tr")] as HTMLElement[];
      expect(rows).toHaveLength(2);
      expect(rows[0]?.dataset["key"]).toBe(RESISTOR); // most placements first
      expect(rows[0]?.textContent).toContain("2×");

      // nothing is resolved yet, so there is nothing to hang a vendor on — and
      // the box that fixes it is the cell to the left, in the same row
      expect(rows[0]?.textContent).toContain("needs an MPN");
      expect(rows[0]?.querySelector(".vend")).toBeNull();
      expect(rows[0]?.querySelector(".mpn")).not.toBeNull();

      // a row with no vendor boxes still has every later column in place, so
      // the sort reads the same column on every row
      const width = rows[0]?.children.length;
      expect(rows.every((tr) => tr.children.length === width)).toBe(true);
      dom.window.close();
    });

    it("names each row the way a distributor does, with the key on the tooltip", async () => {
      const dom = await open();
      const doc = dom.window.document;
      doc.querySelector<HTMLButtonElement>('[data-tab="parts"]')?.click();
      await settle(20);

      const cell = doc.querySelector(
        `#tbl-parts tr[data-key="${RESISTOR}"] td.key-cell`,
      ) as HTMLElement;
      expect(cell.querySelector(".kname")?.textContent).toBe("RES 10K OHM 0402");
      // the canonical key is what the catalog and the .kinv files know it by,
      // so it stays one hover away
      expect(cell.querySelector(".kname")?.getAttribute("title")).toBe(RESISTOR);
      // and the column sorts by what it shows
      expect(cell.dataset["sort"]).toBe("RES 10K OHM 0402");

      const copy = cell.querySelector(".copykey") as HTMLElement;
      expect(copy.dataset["copyLabel"]).toBe("RES 10K OHM 0402");
      expect(
        doc
          .querySelector(`#tbl-parts tr[data-key="${CAPACITOR}"] .copykey`)
          ?.getAttribute("data-copy-label"),
      ).toBe("CAP CER 0.1UF 0603");
      dom.window.close();
    });

    it("finds a row by the distributor's wording as well as the board's", async () => {
      const dom = await open();
      const doc = dom.window.document;
      doc.querySelector<HTMLButtonElement>('[data-tab="parts"]')?.click();
      await settle(20);

      const filter = doc.getElementById("filter") as HTMLInputElement;
      filter.value = "cap cer";
      filter.dispatchEvent(new dom.window.Event("input", { bubbles: true }));

      const shown = [...doc.querySelectorAll("#tbl-parts tbody tr")].filter(
        (tr) => (tr as HTMLElement).style.display !== "none",
      );
      expect(shown).toHaveLength(1);
      expect((shown[0] as HTMLElement).dataset["key"]).toBe(CAPACITOR);
      dom.window.close();
    });

    it("takes an MPN and a vendor for the same row without changing tabs", async () => {
      const dom = await open();
      const doc = dom.window.document;
      doc.querySelector<HTMLButtonElement>('[data-tab="parts"]')?.click();
      await settle(20);

      const row = (): HTMLElement =>
        doc.querySelector(`#tbl-parts tr[data-key="${RESISTOR}"]`) as HTMLElement;
      (row().querySelector(".mpn") as HTMLInputElement).value = "RC0402FR-0710KL";
      (row().querySelector(".save") as HTMLElement).click();
      await settle();

      // the vendor boxes appear in the row you were already looking at
      expect(row().classList.contains("done")).toBe(true);
      (row().querySelector(".vend") as HTMLInputElement).value = "digikey";
      (row().querySelector(".savevendor") as HTMLElement).click();
      await settle();

      expect(row().classList.contains("sourced")).toBe(true);
      expect(readCatalog()).toMatchObject([{ mpn: "RC0402FR-0710KL", supplier: "digikey" }]);
      expect(doc.getElementById("view")?.textContent).toContain(
        "1 of 2 have a part number · 1 have a vendor",
      );
      dom.window.close();
    });

    it("offers the vendors this board already buys from", async () => {
      // the completion list is the board's own vendors, so the second row you
      // fill in is a pick rather than a retype — and a typo is visible as a
      // name that is not on the list
      resolveIt(RESISTOR, "RC0402FR-0710KL");
      resolveIt(CAPACITOR, "CL10B104KB8NNNC");
      await post("api/supplier", { key: CAPACITOR, supplier: "mouser", orderNumber: "80-C0603" });

      const dom = await open();
      const doc = dom.window.document;
      doc.querySelector<HTMLButtonElement>('[data-tab="parts"]')?.click();
      await settle(20);

      const options = [...doc.querySelectorAll("#view datalist#vendors option")].map((o) =>
        o.getAttribute("value"),
      );
      expect(options).toEqual(["mouser"]);

      // every vendor box points at it, including the one still empty
      const boxes = [...doc.querySelectorAll(".vend")] as HTMLInputElement[];
      expect(boxes).toHaveLength(2);
      expect(boxes.every((b) => b.getAttribute("list") === "vendors")).toBe(true);

      // filing a second vendor adds it, sorted, without a reload
      const row = doc.querySelector(`#tbl-parts tr[data-key="${RESISTOR}"]`) as HTMLElement;
      (row.querySelector(".vend") as HTMLInputElement).value = "digikey";
      (row.querySelector(".savevendor") as HTMLElement).click();
      await settle();

      expect(
        [...doc.querySelectorAll("#view datalist#vendors option")].map((o) =>
          o.getAttribute("value"),
        ),
      ).toEqual(["digikey", "mouser"]);
      dom.window.close();
    });

    it("saves a vendor typed into the row, and exports what it wrote", async () => {
      resolveIt(RESISTOR, "RC0402FR-0710KL");
      const dom = await open();
      const doc = dom.window.document;
      doc.querySelector<HTMLButtonElement>('[data-tab="parts"]')?.click();
      await settle(20);

      const row = doc.querySelector(`#tbl-parts tr[data-key="${RESISTOR}"]`) as HTMLElement;
      (row.querySelector(".vend") as HTMLInputElement).value = "digikey";
      (row.querySelector(".vnum") as HTMLInputElement).value = "311-10.0KLRCT-ND";
      (row.querySelector(".savevendor") as HTMLElement).click();
      await settle();

      expect(readCatalog()).toMatchObject([
        { mpn: "RC0402FR-0710KL", supplier: "digikey", orderNumber: "311-10.0KLRCT-ND" },
      ]);

      // and the export button turns that into the file a form eats
      (doc.getElementById("export") as HTMLElement).click();
      await settle();

      const panel = doc.querySelector("#exports .panel")?.textContent ?? "";
      expect(panel).toContain("wrote 1 file");
      expect(panel).toContain("order.digikey.csv");
      expect(panel).toContain("1 line");
      expect(panel).toContain("2 pieces");
      // the capacitor has no MPN at all, and is reported rather than invented
      expect(panel).toContain("1 with no MPN");
      expect(readFileSync(join(dir, "order.digikey.csv"), "utf8")).toContain("2,311-10.0KLRCT-ND");
      dom.window.close();
    });

    it("asks where before it writes, and writes where you said", async () => {
      resolveIt(RESISTOR, "RC0402FR-0710KL");
      await post("api/supplier", { key: RESISTOR, supplier: "digikey", orderNumber: "311-ND" });
      const elsewhere = join(dir, "baskets");
      mkdirSync(elsewhere);
      let askedFrom = "";
      answerWhere = (start): Promise<FolderChoice> => {
        askedFrom = start;
        return Promise.resolve({ status: "chosen", dir: elsewhere } as FolderChoice);
      };

      const dom = await open();
      const doc = dom.window.document;
      doc.querySelector<HTMLButtonElement>('[data-tab="parts"]')?.click();
      await settle(20);

      (doc.getElementById("export") as HTMLElement).click();
      await settle();

      // the dialog opens where the files would otherwise have gone
      expect(askedFrom).toBe(dir);
      expect(existsSync(join(elsewhere, "order.digikey.csv"))).toBe(true);
      const panel = doc.querySelector("#exports .panel")?.textContent ?? "";
      expect(panel).toContain("wrote 1 file");
      expect(panel).toContain(elsewhere);
      dom.window.close();
    });

    it("says what it is waiting for while the dialog is open", async () => {
      // the dialog is a separate process and takes about two seconds to
      // appear; a button that only greyed itself read as one that did nothing
      resolveIt(RESISTOR, "RC0402FR-0710KL");
      await post("api/supplier", { key: RESISTOR, supplier: "digikey", orderNumber: "311-ND" });
      let answer: (choice: FolderChoice) => void = () => {};
      answerWhere = (): Promise<FolderChoice> =>
        new Promise<FolderChoice>((resolve) => {
          answer = resolve;
        });

      const dom = await open();
      const doc = dom.window.document;
      doc.querySelector<HTMLButtonElement>('[data-tab="parts"]')?.click();
      await settle(20);

      const btn = (): HTMLButtonElement => doc.getElementById("export") as HTMLButtonElement;
      expect(btn().textContent).toBe("export CSVs");
      btn().click();
      await settle(10);

      expect(btn().disabled).toBe(true);
      expect(btn().textContent).toContain("folder dialog");
      expect(doc.querySelector("#exports .panel")?.textContent).toContain("on your desktop");

      answer({ status: "chosen", dir });
      await settle();

      expect(btn().disabled).toBe(false);
      expect(btn().textContent).toBe("export CSVs");
      expect(existsSync(join(dir, "order.digikey.csv"))).toBe(true);
      dom.window.close();
    });

    it("refuses to stack a second dialog on top of the first", async () => {
      // pressing export again is exactly what you do when the first dialog has
      // not surfaced yet, and four stacked dialogs are a mess to clear up
      let answer: (choice: FolderChoice) => void = () => {};
      answerWhere = (): Promise<FolderChoice> =>
        new Promise<FolderChoice>((resolve) => {
          answer = resolve;
        });

      const asked = (res: Response): Promise<unknown> => res.json() as Promise<unknown>;
      const first = post("api/order/where", {});
      await new Promise((r) => setTimeout(r, 50));
      expect(await asked(await post("api/order/where", {}))).toEqual({ status: "busy" });

      answer({ status: "cancelled" });
      expect(await asked(await first)).toEqual({ status: "cancelled" });

      // and once it is answered, asking again opens a new one
      answerWhere = (): Promise<FolderChoice> =>
        Promise.resolve({ status: "cancelled" } as FolderChoice);
      expect(await asked(await post("api/order/where", {}))).toEqual({ status: "cancelled" });
    });

    it("writes nothing when you cancel the dialog", async () => {
      resolveIt(RESISTOR, "RC0402FR-0710KL");
      await post("api/supplier", { key: RESISTOR, supplier: "digikey", orderNumber: "311-ND" });
      answerWhere = (): Promise<FolderChoice> =>
        Promise.resolve({ status: "cancelled" } as FolderChoice);

      const dom = await open();
      const doc = dom.window.document;
      doc.querySelector<HTMLButtonElement>('[data-tab="parts"]')?.click();
      await settle(20);

      (doc.getElementById("export") as HTMLElement).click();
      await settle();

      expect(existsSync(join(dir, "order.digikey.csv"))).toBe(false);
      // and the button is usable again: a cancel is not a failure
      expect((doc.getElementById("export") as HTMLButtonElement).disabled).toBe(false);
      dom.window.close();
    });

    it("takes a typed path where the machine has no dialog at all", async () => {
      resolveIt(RESISTOR, "RC0402FR-0710KL");
      await post("api/supplier", { key: RESISTOR, supplier: "digikey", orderNumber: "311-ND" });
      const elsewhere = join(dir, "headless");
      mkdirSync(elsewhere);
      answerWhere = (): Promise<FolderChoice> =>
        Promise.resolve({ status: "unavailable", reason: "zenity is not installed" });

      const dom = await open();
      const doc = dom.window.document;
      doc.querySelector<HTMLButtonElement>('[data-tab="parts"]')?.click();
      await settle(20);

      (doc.getElementById("export") as HTMLElement).click();
      await settle();

      // no dialog, so the panel says why and offers the path as a box
      const box = doc.querySelector("#exports .pathbox") as HTMLInputElement;
      expect(box).not.toBeNull();
      expect(doc.querySelector("#exports .panel")?.textContent).toContain(
        "zenity is not installed",
      );

      box.value = elsewhere;
      (doc.querySelector("#exports .pathwrite") as HTMLElement).click();
      await settle();

      expect(existsSync(join(elsewhere, "order.digikey.csv"))).toBe(true);
      expect(doc.querySelector("#exports .panel")?.textContent).toContain("wrote 1 file");
      dom.window.close();
    });

    it("keeps a half-typed vendor through a re-render", async () => {
      // a save in KiCad re-renders the table under you; what you have typed is
      // a decision in progress and outlives it, caret included
      resolveIt(RESISTOR, "RC0402FR-0710KL");
      const dom = await open();
      const doc = dom.window.document;
      doc.querySelector<HTMLButtonElement>('[data-tab="parts"]')?.click();
      await settle(20);

      const vend = doc.querySelector(".vend") as HTMLInputElement;
      vend.focus();
      vend.value = "digik";
      vend.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      expect(vend.classList.contains("dirty")).toBe(true);

      writeFileSync(project, readFileSync(project, "utf8"), "utf8");
      await new Promise((r) => setTimeout(r, 2600));

      const after = doc.querySelector(".vend") as HTMLInputElement;
      expect(after.value).toBe("digik");
      expect(after.classList.contains("dirty")).toBe(true);
      expect(doc.activeElement?.classList.contains("vend")).toBe(true);
      dom.window.close();
    }, 15000);

    it("multiplies by the number of boards you type, and by nothing else", async () => {
      resolveIt(RESISTOR, "RC0402FR-0710KL");
      const dom = await open();
      const doc = dom.window.document;
      doc.querySelector<HTMLButtonElement>('[data-tab="parts"]')?.click();
      await settle(20);

      const row = doc.querySelector(`#tbl-parts tr[data-key="${RESISTOR}"]`) as HTMLElement;
      (row.querySelector(".vend") as HTMLInputElement).value = "digikey";
      (row.querySelector(".savevendor") as HTMLElement).click();
      await settle();

      const boards = doc.getElementById("boards") as HTMLInputElement;
      boards.value = "10";
      boards.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      (doc.getElementById("export") as HTMLElement).click();
      await settle();

      // no order number: the MPN is the fallback, because most forms take one
      expect(readFileSync(join(dir, "order.digikey.csv"), "utf8")).toContain("20,RC0402FR-0710KL");
      expect(doc.querySelector("#exports .panel")?.textContent).toContain("for 10 boards");
      dom.window.close();
    });
  });
});
