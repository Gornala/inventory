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
import { readSolved, solvedPath } from "../../src/adapters/store/solved.js";
import { buildReport, createReportCache } from "../../src/report.js";
import { startUiServer } from "../../src/ui/server.js";
import { fixture } from "../fixtures/index.js";

/**
 * The write half of the UI, driven through the real server against a throwaway
 * copy of a real sheet. Nothing here touches a fixture or a checked-in file.
 */
describe("settling findings and rewriting spellings", () => {
  let dir: string;
  let project: string;
  let sheet: string;
  let server: Server;
  let base: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "kinv-ui-"));
    sheet = join(dir, "encoder.kicad_sch");
    project = join(dir, "board.bom.csv");
    copyFileSync(fixture("kicad10", "encoder.kicad_sch"), sheet);
    // A CSV project keeps the report off kicad-cli; the rewrite endpoints read
    // the .kicad_sch files beside it either way.
    writeFileSync(
      project,
      [
        '"Reference","Value","Footprint","QUANTITY","DNP"',
        '"R10002","10k","Resistor_SMD:R_0402_1005Metric","1",""',
      ].join("\n"),
      "utf8",
    );
    // The catalog is one directory for every board, so it is also shared by
    // every test in this file: each starts from an empty one.
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

  // `base` already ends in a slash; a leading one here would make "//api/…",
  // which is a different path and not one the server routes.
  const post = (
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<Response> =>
    fetch(new URL(path, base), {
      method: "POST",
      headers: { "content-type": "application/json", "x-kinv": "1", ...headers },
      body: JSON.stringify(body),
    });

  describe("the solved list", () => {
    it("writes a mark beside the project, and the report drops the finding", async () => {
      const before = await buildReport(project);
      const finding = before.findings[0];
      expect(finding).toBeDefined();

      const res = await post("/api/solved", {
        id: finding?.id,
        signature: finding?.signature,
        solved: true,
      });
      expect(res.status).toBe(200);
      expect(existsSync(solvedPath(project))).toBe(true);

      const after = await buildReport(project);
      expect(after.findings.map((f) => f.id)).not.toContain(finding?.id);
      expect(after.settled.map((f) => f.id)).toContain(finding?.id);
      expect(after.counts.settled).toBe(1);
    });

    it("brings a settled finding back when what it says changes", async () => {
      // you settled "used once at R10002"; a second one appearing is a new
      // question, and the old answer does not cover it
      const before = await buildReport(project);
      const finding = before.findings[0];
      await post("/api/solved", { id: finding?.id, signature: "something else entirely" });

      const after = await buildReport(project);
      expect(after.findings.map((f) => f.id)).toContain(finding?.id);
      expect(after.counts.settled).toBe(0);
    });

    it("reopens one, and resets all", async () => {
      const before = await buildReport(project);
      const finding = before.findings[0];
      await post("/api/solved", { id: finding?.id, signature: finding?.signature });
      expect(readSolved(project)).toHaveLength(1);

      await post("/api/solved", { id: finding?.id, signature: finding?.signature, solved: false });
      expect(readSolved(project)).toHaveLength(0);

      await post("/api/solved", { id: finding?.id, signature: finding?.signature });
      await post("/api/solved/reset", {});
      expect(readSolved(project)).toHaveLength(0);
    });

    it("refuses a write that did not come from this page", async () => {
      // any page anywhere can POST to 127.0.0.1 without a preflight; it cannot
      // set a custom header, and these endpoints write to disk
      const res = await fetch(`${base}api/solved`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "x", signature: "y" }),
      });
      expect(res.status).toBe(403);
      expect(existsSync(solvedPath(project))).toBe(false);
    });

    it("refuses a GET", async () => {
      expect((await fetch(`${base}api/solved`)).status).toBe(405);
    });
  });

  describe("rewriting a spelling", () => {
    const groups = [{ from: "10k", refs: ["R10002"] }];

    it("plans without writing anything", async () => {
      const original = readFileSync(sheet, "utf8");
      const res = await post("/api/rewrite/plan", { to: "10K", groups });
      const plan = (await res.json()) as { edits: { ref: string; to: string }[]; locked: string[] };

      expect(plan.edits).toHaveLength(1);
      expect(plan.edits[0]?.ref).toBe("R10002");
      expect(plan.edits[0]?.to).toBe("10K");
      expect(plan.locked).toEqual([]);
      expect(readFileSync(sheet, "utf8")).toBe(original);
    });

    it("applies the plan and leaves a backup", async () => {
      const original = readFileSync(sheet, "utf8");
      const res = await post("/api/rewrite/apply", { to: "10K", groups });
      expect(res.status).toBe(200);

      expect(readFileSync(sheet, "utf8")).toContain('(property "Value" "10K"');
      expect(readFileSync(`${sheet}.bak`, "utf8")).toBe(original);
    });

    it("reports the lock instead of writing under it", async () => {
      writeFileSync(join(dir, "~encoder.kicad_sch.lck"), "", "utf8");
      const original = readFileSync(sheet, "utf8");

      const res = await post("/api/rewrite/apply", { to: "10K", groups });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toMatch(
        /KiCad has this project open/,
      );
      expect(readFileSync(sheet, "utf8")).toBe(original);
    });
  });

  describe("the report cache", () => {
    it("hands back the same report until something actually changes", async () => {
      // it never did: the cached report was stamped with the schematic
      // fingerprint and compared against schematic + solved + inventory, so
      // every poll re-ran the whole read — and re-rendered the page over
      // whatever was being typed into it
      const get = createReportCache(project);
      const first = await get();
      expect(await get()).toBe(first);
    });

    it("notices a part being assigned, which touches no schematic", async () => {
      const get = createReportCache(project);
      const before = await get();
      expect(before.counts.assigned).toBe(0);

      await post("/api/assign", { key: "R|10k|0402", mpn: "RC0402FR-0710KL" });

      const after = await get();
      expect(after).not.toBe(before);
      expect(after.counts.assigned).toBe(1);
    });

    it("notices an edit to the board", async () => {
      const get = createReportCache(project);
      const before = await get();
      writeFileSync(
        project,
        [
          '"Reference","Value","Footprint","QUANTITY","DNP"',
          '"R10002","10k","Resistor_SMD:R_0402_1005Metric","1",""',
          '"R10003","47k","Resistor_SMD:R_0402_1005Metric","1",""',
        ].join("\n"),
        "utf8",
      );

      const after = await get();
      expect(after).not.toBe(before);
      expect(after.summary.parts).toBe(2);
    });
  });

  describe("the buttons in the page", () => {
    async function open(): Promise<JSDOM> {
      const html = await (await fetch(base)).text();
      const dom = new JSDOM(html, {
        url: base,
        runScripts: "dangerously",
        pretendToBeVisual: true,
        beforeParse(window) {
          // jsdom has no fetch; give the page a real one pointed at the real
          // server, so the buttons go all the way to disk and back
          (window as unknown as { fetch: typeof fetch }).fetch = ((
            input: string,
            init?: RequestInit,
          ) => fetch(new URL(String(input), base), init)) as typeof fetch;
        },
      });
      for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 5));
      return dom;
    }

    /**
     * Two spellings of one part, in a temp copy: the sheet ships with C10001
     * and C10002 both reading "10n", so one of them is renamed here to create
     * the disagreement the card is about.
     */
    function makeSpellingDisagreement(): void {
      const text = readFileSync(sheet, "utf8");
      const at = text.indexOf('(property "Reference" "C10002"');
      const value = text.indexOf('(property "Value" "10n"', at);
      writeFileSync(
        sheet,
        text.slice(0, value) +
          '(property "Value" "10nF"' +
          text.slice(value + '(property "Value" "10n"'.length),
        "utf8",
      );
      writeFileSync(
        project,
        [
          '"Reference","Value","Footprint","QUANTITY","DNP"',
          '"C10001","10n","Capacitor_SMD:C_0603_1608Metric","1",""',
          '"C10002","10nF","Capacitor_SMD:C_0603_1608Metric","1",""',
        ].join("\n"),
        "utf8",
      );
    }

    it("unifies a spelling in the schematic, after showing what it will change", async () => {
      makeSpellingDisagreement();
      const dom = await open();
      const doc = dom.window.document;
      const settle = async (): Promise<void> => {
        for (let i = 0; i < 80; i++) await new Promise((r) => setTimeout(r, 5));
      };

      // the card offers each spelling as the one to keep
      const buttons = [...doc.querySelectorAll(".usethis")] as HTMLElement[];
      expect(buttons.map((b) => b.dataset["to"]).sort()).toEqual(["10n", "10nF"]);

      // asking to keep "10n" plans the other one away, and writes nothing yet
      const keep10n = buttons.find((b) => b.dataset["to"] === "10n") as HTMLElement;
      keep10n.click();
      await settle();

      const panel = doc.querySelector(".rewrite .panel") as HTMLElement;
      expect(panel.textContent).toContain("1 symbol in 1 file will change");
      expect(panel.textContent).toContain("C10002");
      expect(panel.textContent).toContain("a .bak is written first");
      expect(readFileSync(sheet, "utf8")).toContain('(property "Value" "10nF"');

      // the apply button carries the spelling to keep: it used to read it off
      // the plan, and generalising the plan away from a single field left it
      // posting an empty one, which the server refused as "nothing to rewrite"
      const applyButton = doc.querySelector(".apply") as HTMLElement;
      expect(applyButton.dataset["to"]).toBe("10n");

      // and applying does it
      applyButton.click();
      await settle();

      const after = readFileSync(sheet, "utf8");
      expect(after).not.toContain('(property "Value" "10nF"');
      expect(after.match(/\(property "Value" "10n"/g)).toHaveLength(2);
      expect(doc.getElementById("toast")?.textContent).toBe("rewrote 1 symbol · .bak written");
      // and the result stays put through the polls that follow
      expect(doc.querySelector(".rewrite .panel")?.textContent).toContain("1 symbol rewritten");
      dom.window.close();
    });

    it("keeps the panel open until you close it, through the two-second poll", async () => {
      // the poll re-renders the whole view; a panel you are in the middle of
      // reading must not disappear a second after it opened
      makeSpellingDisagreement();
      const dom = await open();
      const doc = dom.window.document;
      const settle = async (ticks: number): Promise<void> => {
        for (let i = 0; i < ticks; i++) await new Promise((r) => setTimeout(r, 5));
      };

      const keep = doc.querySelector('.usethis[data-to="10n"]') as HTMLElement;
      keep.click();
      await settle(80);
      expect(doc.querySelector(".rewrite .panel")).not.toBeNull();

      // two full poll intervals
      await new Promise((r) => setTimeout(r, 4200));
      expect(doc.querySelector(".rewrite .panel")?.textContent).toContain("will change");
      expect((doc.querySelector('.usethis[data-to="10n"]') as HTMLElement).classList).toContain(
        "open",
      );

      // the same button again closes it
      (doc.querySelector('.usethis[data-to="10n"]') as HTMLElement).click();
      await settle(20);
      expect(doc.querySelector(".rewrite .panel")).toBeNull();
      dom.window.close();
      // two real poll intervals have to pass for this to prove anything
    }, 20000);

    it("assigns a part number from the parts tab, and reuses it next time", async () => {
      const dom = await open();
      const doc = dom.window.document;
      const settle = async (): Promise<void> => {
        for (let i = 0; i < 80; i++) await new Promise((r) => setTimeout(r, 5));
      };

      doc.querySelector<HTMLButtonElement>('[data-tab="parts"]')?.click();
      const row = doc.querySelector("#tbl-parts tbody tr") as HTMLElement;
      expect(row.dataset["key"]).toBe("R|10k|0402");
      expect(row.classList.contains("done")).toBe(false);

      (row.querySelector(".mpn") as HTMLInputElement).value = "RC0402FR-0710KL";
      (row.querySelector(".mfr") as HTMLInputElement).value = "Yageo";
      (row.querySelector(".save") as HTMLElement).click();
      await settle();

      // it went to the catalog, which is shared across every board
      expect(readCatalog().map((p) => p.mpn)).toEqual(["RC0402FR-0710KL"]);
      expect(readAssignments()).toMatchObject([
        { key: "R|10k|0402", partId: "rc0402fr-0710kl", by: "user" },
      ]);
      expect(readAssignments()[0]?.decidedAt).toMatch(/^\d{4}-/);

      // and the page says so without being reloaded
      const after = doc.querySelector("#tbl-parts tbody tr") as HTMLElement;
      expect(after.classList.contains("done")).toBe(true);
      expect(after.textContent).toContain("RC0402FR-0710KL");
      expect(doc.getElementById("view")?.textContent).toContain("1 of 1 have a part number");
      dom.window.close();
    });

    it("clears an assignment again", async () => {
      const dom = await open();
      const doc = dom.window.document;
      const settle = async (): Promise<void> => {
        for (let i = 0; i < 80; i++) await new Promise((r) => setTimeout(r, 5));
      };

      doc.querySelector<HTMLButtonElement>('[data-tab="parts"]')?.click();
      (doc.querySelector(".mpn") as HTMLInputElement).value = "AAA-1";
      (doc.querySelector(".save") as HTMLElement).click();
      await settle();
      expect(readAssignments()).toHaveLength(1);

      (doc.querySelector(".editassign") as HTMLElement).click();
      (doc.querySelector(".clearassign") as HTMLElement).click();
      await settle();

      expect(readAssignments()).toHaveLength(0);
      // the part stays in the catalog: it is still a part you know about
      expect(readCatalog()).toHaveLength(1);
      dom.window.close();
    });

    it("keeps a half-typed manufacturer through a re-render", async () => {
      // The report was rebuilt on every two-second poll — the cache compared
      // its composite key against a field holding the schematic fingerprint
      // alone, so it never hit — and the re-render rebuilt every box from the
      // report. A manufacturer typed into an assigned row lasted a second.
      const dom = await open();
      const doc = dom.window.document;
      const settle = async (): Promise<void> => {
        for (let i = 0; i < 80; i++) await new Promise((r) => setTimeout(r, 5));
      };

      doc.querySelector<HTMLButtonElement>('[data-tab="parts"]')?.click();
      (doc.querySelector(".mpn") as HTMLInputElement).value = "RC0402FR-0710KL";
      (doc.querySelector(".save") as HTMLElement).click();
      await settle();

      (doc.querySelector(".editassign") as HTMLElement).click();
      await settle();
      const mfr = doc.querySelector(".mfr") as HTMLInputElement;
      mfr.focus();
      mfr.value = "Yageo";
      mfr.setSelectionRange(5, 5);
      mfr.dispatchEvent(new dom.window.Event("input", { bubbles: true }));

      // a save in KiCad, which is a re-render nobody asked for
      writeFileSync(project, readFileSync(project, "utf8"), "utf8");
      await new Promise((r) => setTimeout(r, 2600));

      const after = doc.querySelector(".mfr") as HTMLInputElement;
      expect(after.value).toBe("Yageo");
      // and the caret is still in it, so the next keystroke lands where it should
      expect(doc.activeElement?.classList.contains("mfr")).toBe(true);
      expect(after.selectionStart).toBe(5);
      dom.window.close();
    }, 15000);

    it("settles a finding from the page and shows it as settled", async () => {
      const dom = await open();
      const doc = dom.window.document;

      const solve = doc.querySelector(".solve") as HTMLElement;
      expect(solve).not.toBeNull();
      solve.click();
      for (let i = 0; i < 60; i++) await new Promise((r) => setTimeout(r, 5));

      expect(readSolved(project)).toHaveLength(1);
      expect(doc.getElementById("view")?.textContent).toContain("Settled (1)");
      expect(doc.querySelector(".card.settled")).not.toBeNull();
      dom.window.close();
    });
  });
});
