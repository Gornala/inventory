import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readBuyChoices } from "../../src/adapters/store/buy.js";
import { notBoughtReason } from "../../src/core/parse/spec.js";
import { startUiServer } from "../../src/ui/server.js";

/**
 * Whether a part is one you buy at all — the one thing about a row the board
 * cannot tell you.
 *
 * The rules leave test points and mounting holes out and are right most of the
 * time. What they cannot know is that this board's connectors come out of the
 * drawer, or that this mounting hole is a standoff somebody ordered. Both
 * directions are a button, and both are driven here through the real server so
 * a click genuinely reaches `.kinv/buy.json` and genuinely changes the report.
 */
describe("do not buy", () => {
  let dir: string;
  let project: string;
  let server: Server;
  let base: string;

  const RESISTOR = "R|10k|0402";
  const TESTPOINT = "TP|TestPoint|TestPoint_Pad_1.0x1.0mm";

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "kinv-nobuy-"));
    project = join(dir, "board.bom.csv");
    writeFileSync(
      project,
      [
        '"Reference","Value","Footprint","QUANTITY","DNP"',
        '"R1,R2","10k","Resistor_SMD:R_0402_1005Metric","2",""',
        '"C1","100n","Capacitor_SMD:C_0603_1608Metric","1",""',
        '"TP1","TestPoint","TestPoint:TestPoint_Pad_1.0x1.0mm","1",""',
      ].join("\n"),
      "utf8",
    );

    const started = await startUiServer(project, { port: 0 });
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

  type Report = {
    parts: { key: string }[];
    excluded: { key: string; reason: string }[];
    counts: { excluded: number };
  };

  const report = async (): Promise<Report> =>
    (await (await fetch(new URL("api/report", base))).json()) as Report;

  describe("the endpoint", () => {
    it("moves a part to the not-bought list, and back again", async () => {
      const before = await report();
      expect(before.parts.map((p) => p.key)).toContain(RESISTOR);

      expect((await post("api/buy", { key: RESISTOR, buy: false })).status).toBe(200);
      const out = await report();
      expect(out.parts.map((p) => p.key)).not.toContain(RESISTOR);
      expect(out.excluded).toContainEqual(
        expect.objectContaining({ key: RESISTOR, reason: notBoughtReason }),
      );
      // the placements go with it: two resistors and the test point
      expect(out.counts.excluded).toBe(3);

      await post("api/buy", { key: RESISTOR, buy: true });
      const back = await report();
      expect(back.parts.map((p) => p.key)).toContain(RESISTOR);
      expect(back.excluded.map((e) => e.key)).not.toContain(RESISTOR);
    });

    it("buys a part the rules left out, when you say so", async () => {
      const before = await report();
      expect(before.excluded.map((e) => e.key)).toContain(TESTPOINT);

      await post("api/buy", { key: TESTPOINT, buy: true });
      const after = await report();
      expect(after.parts.map((p) => p.key)).toContain(TESTPOINT);
      expect(after.excluded).toEqual([]);
    });

    it("writes the decision beside the board, both answers alike", async () => {
      await post("api/buy", { key: RESISTOR, buy: false });
      expect(readBuyChoices(project)).toMatchObject([{ key: RESISTOR, buy: false }]);

      // and the way back is a decision too, not the absence of one: the button
      // must do the same thing whichever rule took the part out
      await post("api/buy", { key: RESISTOR, buy: true });
      expect(readBuyChoices(project)).toMatchObject([{ key: RESISTOR, buy: true }]);
    });

    it("refuses a key-less body, and a write that did not come from this page", async () => {
      const blank = await post("api/buy", { buy: false });
      expect(blank.status).toBe(400);

      const foreign = await fetch(new URL("api/buy", base), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: RESISTOR, buy: false }),
      });
      expect(foreign.status).toBe(403);
      expect(readBuyChoices(project)).toEqual([]);
    });
  });

  describe("the two buttons in a browser", () => {
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
      return dom;
    }

    const settle = async (ticks = 80): Promise<void> => {
      for (let i = 0; i < ticks; i++) await new Promise((r) => setTimeout(r, 5));
    };

    const tab = (doc: Document, id: string): void => {
      doc.querySelector<HTMLButtonElement>(`[data-tab="${id}"]`)?.click();
    };

    it("takes a row out of the parts table and hands it back from Not bought", async () => {
      const dom = await open();
      const doc = dom.window.document;

      tab(doc, "parts");
      await settle(20);
      const row = doc.querySelector(`#tbl-parts tr[data-key="${RESISTOR}"]`) as HTMLElement;
      expect(row).not.toBeNull();
      // the cell shows and sorts by the distributor's wording; the canonical
      // key is on the tooltip and in the row's own data-key
      expect(row.children[0]?.getAttribute("data-sort")).toBe("RES 10K OHM 0402");
      expect(row.querySelector(".kname")?.getAttribute("title")).toBe(RESISTOR);

      (row.querySelector(".nobuy") as HTMLElement).click();
      await settle();
      expect(doc.querySelector(`#tbl-parts tr[data-key="${RESISTOR}"]`)).toBeNull();
      expect(readBuyChoices(project)).toMatchObject([{ key: RESISTOR, buy: false }]);

      // and there it is, under a heading that says whose decision it was
      tab(doc, "excluded");
      await settle(20);
      const card = doc.querySelector(`.buythis[data-key="${RESISTOR}"]`) as HTMLElement;
      expect(card).not.toBeNull();
      expect(doc.getElementById("view")?.textContent).toContain(notBoughtReason);

      card.click();
      await settle();
      expect(doc.querySelector(`.buythis[data-key="${RESISTOR}"]`)).toBeNull();

      tab(doc, "parts");
      await settle(20);
      expect(doc.querySelector(`#tbl-parts tr[data-key="${RESISTOR}"]`)).not.toBeNull();
      dom.window.close();
    });

    it("buys a test point the rules dropped, from the tab it was dropped into", async () => {
      const dom = await open();
      const doc = dom.window.document;

      tab(doc, "excluded");
      await settle(20);
      const buy = doc.querySelector(`.buythis[data-key="${TESTPOINT}"]`) as HTMLElement;
      expect(buy).not.toBeNull();

      buy.click();
      await settle();

      tab(doc, "parts");
      await settle(20);
      expect(doc.querySelector(`#tbl-parts tr[data-key="${TESTPOINT}"]`)).not.toBeNull();
      dom.window.close();
    });
  });
});
