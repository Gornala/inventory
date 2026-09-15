import type { Server } from "node:http";
import { Script } from "node:vm";
import { JSDOM } from "jsdom";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildReport, footprintDetail, sourceSignature } from "../../src/report.js";
import { page } from "../../src/ui/page.js";
import { startUiServer } from "../../src/ui/server.js";
import { fixture } from "../fixtures/index.js";

const board = fixture("kicad10", "transformer_test.bom.csv");

let server: Server;
let base: string;

beforeAll(async () => {
  // port 0 lets the OS pick, so tests never collide with a running `kinv ui`
  const started = await startUiServer(board, { port: 0 });
  server = started.server;
  base = started.url;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("report", () => {
  it("carries the summary, findings, issues and parts", async () => {
    const report = await buildReport(board);
    // 11 test-point placements over 6 lines are board features, not purchases
    expect(report.summary).toEqual({ placements: 343, lines: 94, parts: 89 });
    expect(report.excluded).toHaveLength(6);
    expect(report.counts).toEqual({
      errors: 0,
      warnings: 4,
      infos: 5,
      findings: 34,
      settled: 0,
      assigned: 0,
      resolved: 5,
      excluded: 11,
      footprintFindings: report.counts.footprintFindings,
    });
    expect(report.parts[0]?.key).toBe("C|100n|0603"); // most placements first
    expect(report.parts[0]?.placements).toBe(58);
  });

  it("keeps both spellings visible in a merged part", async () => {
    const report = await buildReport(board);
    const merged = report.parts.find((p) => p.key === "C|100n|0603");
    expect(merged?.sources.map((s) => s.value).sort()).toEqual(["100n", "100nF"]);
  });

  it("fingerprints the source so the cache knows when to re-read", () => {
    // mtime and size: a filesystem timestamp alone is only millisecond-fine,
    // and saving a hierarchy writes every sheet at once
    expect(sourceSignature(board)).toMatch(/^[\d.]+:\d+$/);
    expect(sourceSignature("does-not-exist.csv")).toBe("");
  });
});

describe("the client script", () => {
  it("parses", () => {
    // the page is a string in a template literal, so a stray escaped quote
    // compiles fine in TypeScript and reaches the browser as a syntax error —
    // which shows up as a blank page, with nothing in the test output
    const script = /<script>([\s\S]*?)<\/script>/.exec(page)?.[1] ?? "";
    expect(script.length).toBeGreaterThan(1000);
    expect(() => new Script(script)).not.toThrow();
  });
});

describe("server", () => {
  it("serves the page", async () => {
    const res = await fetch(base);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("<title>kinv</title>");
  });

  it("stamps the page and the report with the same build", async () => {
    // the page re-renders from JSON and never reloads itself, so a rebuilt UI
    // reaching an already-open tab is silent: the old script runs against the
    // new data for as long as the tab stays open. Matching stamps let the page
    // notice and reload itself.
    const html = await (await fetch(base)).text();
    const report = (await (await fetch(`${base}api/report`)).json()) as { build?: string };

    expect(report.build).toMatch(/^[0-9a-f]{12}$/);
    expect(html).toContain(`var BUILD = "${report.build}"`);
    expect(html).not.toContain("__KINV_BUILD__");
  });

  it("tells the browser never to cache the page", async () => {
    // it is a live view of files on disk; a cached copy is a wrong one
    const res = await fetch(base);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("serves the report as JSON", async () => {
    const res = await fetch(`${base}api/report`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { summary: { parts: number }; findings: unknown[] };
    expect(body.summary.parts).toBe(89);
    expect(body.findings).toHaveLength(34);
  });

  it("404s anything else", async () => {
    expect((await fetch(`${base}nope`)).status).toBe(404);
  });
});

describe("the page in a browser", () => {
  /** Loads the real page with a stubbed fetch, so render() genuinely runs. */
  async function renderPage(): Promise<JSDOM> {
    const html = await (await fetch(base)).text();
    const report: unknown = await (await fetch(`${base}api/report`)).json();

    // fetch must exist before the page's script runs — it polls immediately
    const dom = new JSDOM(html, {
      url: "http://localhost/",
      runScripts: "dangerously",
      pretendToBeVisual: true,
      beforeParse(window) {
        (window as unknown as { fetch: () => Promise<unknown> }).fetch = () =>
          Promise.resolve({ ok: true, json: () => Promise.resolve(report), text: () => "" });
      },
    });

    // give the page's promise chain a few turns to settle
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5));
    return dom;
  }

  it("renders the stats, tabs and findings without throwing", async () => {
    const dom = await renderPage();
    const doc = dom.window.document;

    const stats = doc.getElementById("stats")?.textContent ?? "";
    expect(stats).toContain("343");
    expect(stats).toContain("placements");
    expect(stats).toContain("89");

    // Parts, Resolve and Parts to buy were three tabs over the same rows: one
    // table carries all three sets of columns now.
    expect(doc.querySelectorAll("nav button")).toHaveLength(5);
    expect(doc.querySelector('[data-tab="parts"]')?.textContent).toBe("Parts");

    const view = doc.getElementById("view")?.textContent ?? "";
    expect(view).toContain("Same part, spelled differently");
    expect(view).toContain("C|100n|0603");
    expect(view).toContain("standardise on 0402");
    expect(view).toContain("2.2% apart");
    expect(doc.getElementById("status")?.textContent).toContain("updated");
    dom.window.close();
  });

  it("switches to the parts tab and filters", async () => {
    const dom = await renderPage();
    const doc = dom.window.document;

    doc.querySelector<HTMLButtonElement>('[data-tab="parts"]')?.click();
    const rows = doc.querySelectorAll("tbody tr");
    expect(rows).toHaveLength(89);

    const filter = doc.getElementById("filter") as HTMLInputElement;
    filter.value = "rp2040";
    filter.dispatchEvent(new dom.window.Event("input", { bubbles: true }));

    const visible = [...doc.querySelectorAll("tbody tr")].filter(
      (tr) => (tr as HTMLElement).style.display !== "none",
    );
    expect(visible).toHaveLength(1);
    expect(visible[0]?.textContent).toContain("RP2040");
    dom.window.close();
  });

  it("shows the footprints tab", async () => {
    const dom = await renderPage();
    const doc = dom.window.document;

    doc.querySelector<HTMLButtonElement>('[data-tab="footprints"]')?.click();
    const view = doc.getElementById("view")?.textContent ?? "";
    // the CSV fixture has no project directory, so libraries cannot resolve;
    // the tab must still render rather than blowing up
    expect(view.length).toBeGreaterThan(0);
    dom.window.close();
  });

  it("shows the issues tab with severities", async () => {
    const dom = await renderPage();
    const doc = dom.window.document;

    doc.querySelector<HTMLButtonElement>('[data-tab="issues"]')?.click();
    const view = doc.getElementById("view")?.textContent ?? "";
    expect(view).toContain("warnings (4)");
    expect(view).toContain("class-mismatch");
    expect(view).toContain("infos (5)");
    expect(view).toContain("pre-resolved");
    dom.window.close();
  });
});

describe("footprint detail", () => {
  const project = fixture("kicad10", "footprints", "R_0603_1608Metric.kicad_mod");

  it("serves everything needed to draw and measure", () => {
    // resolve through the installed KiCad libraries when they are present
    const detail = footprintDetail(project, "Resistor_SMD:R_0603_1608Metric");
    if (!detail) return; // no KiCad install on this machine
    expect(detail.pads).toHaveLength(2);
    expect(detail.courtyard).toEqual({ x: -1.48, y: -0.73, width: 2.96, height: 1.46 });
    expect(detail.measured.span.x).toBe(2.45);
    expect(detail.findings).toEqual([]);
  });

  it("reports an unknown footprint as not found", async () => {
    const res = await fetch(`${base}api/footprint?ref=No_Such_Lib:No_Such_Part`);
    expect(res.status).toBe(404);
    expect(await res.text()).toMatch(/not found/);
  });
});

describe("the measuring tool", () => {
  const detail = {
    reference: "Test:Two_Pads",
    name: "Two_Pads",
    path: "/tmp/Two_Pads.kicad_mod",
    // two 1x1 pads with centres exactly 4 mm apart
    pads: [
      {
        number: "1",
        type: "smd",
        shape: "rect",
        x: -2,
        y: 0,
        width: 1,
        height: 1,
        angle: 0,
        layers: ["F.Cu"],
        drill: undefined,
      },
      {
        number: "2",
        type: "smd",
        shape: "rect",
        x: 2,
        y: 0,
        width: 1,
        height: 1,
        angle: 0,
        layers: ["F.Cu"],
        drill: undefined,
      },
    ],
    courtyard: { x: -3, y: -1, width: 6, height: 2 },
    measured: {
      padCount: 2,
      distinctPads: 2,
      pitch: 4,
      span: { x: 5, y: 1 },
      padSize: { width: 1, height: 1 },
      exposedPads: [],
      pasteOnlyPads: 0,
      mechanicalPads: 0,
      mounting: "smd",
      drills: [],
    },
    declared: {
      name: "Two_Pads",
      chip: undefined,
      pitch: undefined,
      pinCount: undefined,
      body: undefined,
      exposedPad: undefined,
      family: undefined,
    },
    findings: [],
  };

  /** Loads the page, stubs both endpoints, and opens the viewer. */
  async function openViewer(): Promise<{ dom: JSDOM; reference: string }> {
    const html = await (await fetch(base)).text();
    const report: unknown = await (await fetch(`${base}api/report`)).json();

    const dom = new JSDOM(html, {
      url: "http://localhost/",
      runScripts: "dangerously",
      pretendToBeVisual: true,
      beforeParse(window) {
        (window as unknown as { fetch: (u: string) => Promise<unknown> }).fetch = (url: string) =>
          Promise.resolve({
            ok: true,
            json: () => Promise.resolve(url.includes("footprint") ? detail : report),
            text: () => Promise.resolve(""),
          });
      },
    });
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5));

    const doc = dom.window.document;
    doc.querySelector<HTMLButtonElement>('[data-tab="footprints"]')?.click();

    // click a row that is really in the table, so selection can be observed;
    // the stubbed endpoint returns the same detail whichever one it is
    const row = doc.querySelector<HTMLElement>("[data-fp]");
    if (!row) throw new Error("no footprint rows rendered");
    const reference = row.dataset["fp"] as string;
    row.click();
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5));
    return { dom, reference };
  }

  it("marks the row it is showing, and keeps it marked across a re-render", async () => {
    const { dom, reference } = await openViewer();
    const doc = dom.window.document;
    const selector = `[data-fp="${reference}"]`;

    expect(doc.querySelector(selector)?.classList.contains("sel")).toBe(true);

    // leaving the tab and coming back rebuilds the table from scratch; the
    // mark has to be re-applied from state, not left in the DOM
    doc.querySelector<HTMLButtonElement>('[data-tab="parts"]')?.click();
    doc.querySelector<HTMLButtonElement>('[data-tab="footprints"]')?.click();
    expect(doc.querySelector(selector)?.classList.contains("sel")).toBe(true);
    dom.window.close();
  });

  it("clears the mark when the viewer is closed", async () => {
    const { dom } = await openViewer();
    const doc = dom.window.document;
    expect(doc.querySelector("[data-fp].sel")).not.toBeNull();

    doc.querySelector<HTMLButtonElement>("#fpclose")?.click();
    expect(doc.querySelector("[data-fp].sel")).toBeNull();
    dom.window.close();
  });

  it("draws the pads, the courtyard and the measurement overlay", async () => {
    const { dom } = await openViewer();
    const doc = dom.window.document;

    const svg = doc.getElementById("fpsvg");
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute("viewBox")).toBeTruthy();
    expect(doc.querySelectorAll("#fpsvg .pad")).toHaveLength(2);
    expect(doc.querySelectorAll("#fpsvg .crtyd")).toHaveLength(1);
    expect(doc.getElementById("fpruler")).not.toBeNull();
    expect(doc.getElementById("fpsnap")).not.toBeNull();
    dom.window.close();
  });

  it("shows the measurements and what the name claims alongside", async () => {
    const { dom } = await openViewer();
    const meta = dom.window.document.querySelector(".fpmeta")?.textContent ?? "";
    expect(meta).toContain("pad centres");
    expect(meta).toContain("geometry agrees with the name");
    dom.window.close();
  });

  it("snaps to pad geometry and measures between two points", async () => {
    const { dom } = await openViewer();
    const doc = dom.window.document;
    const svg = doc.getElementById("fpsvg") as unknown as SVGSVGElement;

    // jsdom has no layout, so supply the screen transform the tool asks for
    const ctm = { a: 50, b: 0, c: 0, d: 50, e: 300, f: 200 };
    const inverse = (x: number, y: number) => ({ x: (x - ctm.e) / ctm.a, y: (y - ctm.f) / ctm.d });
    (svg as unknown as { getScreenCTM: () => unknown }).getScreenCTM = () => ({
      ...ctm,
      inverse: () => ({
        a: 1 / ctm.a,
        b: 0,
        c: 0,
        d: 1 / ctm.d,
        e: 0,
        f: 0,
      }),
    });
    (svg as unknown as { createSVGPoint: () => unknown }).createSVGPoint = () => {
      const point = {
        x: 0,
        y: 0,
        matrixTransform: () => inverse(point.x, point.y),
      };
      return point;
    };

    const move = (clientX: number, clientY: number) =>
      svg.dispatchEvent(
        new dom.window.MouseEvent("mousemove", { clientX, clientY, bubbles: true }),
      );
    const click = (clientX: number, clientY: number) =>
      svg.dispatchEvent(new dom.window.MouseEvent("click", { clientX, clientY, bubbles: true }));

    // a hair off the centre of pad 1 (-2, 0) -> snaps to it
    move(ctm.e + -2.05 * ctm.a, ctm.f + 0.05 * ctm.d);
    expect(doc.getElementById("fpread")?.textContent).toContain("centre, pad 1");

    click(ctm.e + -2.05 * ctm.a, ctm.f + 0.05 * ctm.d);
    expect((doc.getElementById("fpanchor") as unknown as HTMLElement).style.display).toBe("");

    // over the centre of pad 2 (2, 0): exactly 4 mm away
    move(ctm.e + 2.02 * ctm.a, ctm.f + 0.02 * ctm.d);
    const read = doc.getElementById("fpread")?.textContent ?? "";
    expect(read).toContain("4 mm");
    expect(read).toContain("dx 4");
    expect((doc.getElementById("fpruler") as unknown as HTMLElement).style.display).toBe("");

    // clicking again clears the measurement
    click(ctm.e + 2.02 * ctm.a, ctm.f + 0.02 * ctm.d);
    expect((doc.getElementById("fpruler") as unknown as HTMLElement).style.display).toBe("none");
    dom.window.close();
  });

  it("falls back to a free position away from any pad", async () => {
    const { dom } = await openViewer();
    const doc = dom.window.document;
    const svg = doc.getElementById("fpsvg") as unknown as SVGSVGElement;
    (svg as unknown as { getScreenCTM: () => unknown }).getScreenCTM = () => ({
      a: 50,
      b: 0,
      c: 0,
      d: 50,
      e: 0,
      f: 0,
      inverse: () => ({ a: 0.02, b: 0, c: 0, d: 0.02, e: 0, f: 0 }),
    });
    (svg as unknown as { createSVGPoint: () => unknown }).createSVGPoint = () => {
      const point = { x: 0, y: 0, matrixTransform: () => ({ x: point.x / 50, y: point.y / 50 }) };
      return point;
    };

    svg.dispatchEvent(
      new dom.window.MouseEvent("mousemove", { clientX: 0, clientY: 0, bubbles: true }),
    );
    expect(doc.getElementById("fpread")?.textContent).toContain("free");
    dom.window.close();
  });
});

describe("the not-bought tab", () => {
  it("lists what was left out and why", async () => {
    const html = await (await fetch(base)).text();
    const report: unknown = await (await fetch(`${base}api/report`)).json();
    const dom = new JSDOM(html, {
      url: "http://localhost/",
      runScripts: "dangerously",
      pretendToBeVisual: true,
      beforeParse(window) {
        (window as unknown as { fetch: () => Promise<unknown> }).fetch = () =>
          Promise.resolve({ ok: true, json: () => Promise.resolve(report), text: () => "" });
      },
    });
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5));

    const doc = dom.window.document;
    doc.querySelector<HTMLButtonElement>('[data-tab="excluded"]')?.click();
    const view = doc.getElementById("view")?.textContent ?? "";
    expect(view).toContain("test point with no part number");
    expect(view).toContain("TP7001");
    dom.window.close();
  });
});

describe("sortable tables", () => {
  async function openParts(): Promise<JSDOM> {
    const html = await (await fetch(base)).text();
    const report: unknown = await (await fetch(`${base}api/report`)).json();
    const dom = new JSDOM(html, {
      url: "http://localhost/",
      runScripts: "dangerously",
      pretendToBeVisual: true,
      beforeParse(window) {
        (window as unknown as { fetch: () => Promise<unknown> }).fetch = () =>
          Promise.resolve({ ok: true, json: () => Promise.resolve(report), text: () => "" });
      },
    });
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5));
    dom.window.document.querySelector<HTMLButtonElement>('[data-tab="parts"]')?.click();
    return dom;
  }

  const column = (doc: Document, index: number): string[] =>
    [...doc.querySelectorAll("#tbl-parts tbody tr")].map(
      (tr) => tr.children[index]?.textContent?.trim() ?? "",
    );

  /**
   * What the sort actually reads: `data-sort` where a cell carries one.
   *
   * The key cell's text is the distributor's wording wrapped in two buttons,
   * so comparing its `textContent` would be comparing the glyphs as much as
   * the part.
   */
  const sortKeys = (doc: Document, index: number): string[] =>
    [...doc.querySelectorAll("#tbl-parts tbody tr")].map((tr) => {
      const cell = tr.children[index] as HTMLElement | undefined;
      return cell?.dataset["sort"] ?? cell?.textContent?.trim() ?? "";
    });

  /** The page's own comparator: numeric, and blind to case the way it is. */
  const cmp = (a: string, b: string): number =>
    a.localeCompare(b, "en", { numeric: true, sensitivity: "base" });

  it("sorts by a column when its header is clicked, and reverses on a second click", async () => {
    const dom = await openParts();
    const doc = dom.window.document;

    const header = doc.querySelectorAll<HTMLElement>("#tbl-parts thead th");
    header[0]?.click(); // key, ascending
    const asc = sortKeys(doc, 0);
    expect(asc).toEqual([...asc].sort(cmp));

    header[0]?.click(); // key, descending
    const desc = sortKeys(doc, 0);
    expect(desc).toEqual([...desc].sort((a, b) => -cmp(a, b)));
    // the same rows the other way round — not the literal reverse of the
    // ascending list, because two parts can share a label and a stable sort
    // keeps tied rows in the order it found them, whichever way it is going
    expect([...desc].sort(cmp)).toEqual([...asc].sort(cmp));
    dom.window.close();
  });

  it("puts the references last, on one line, ready to copy", async () => {
    const dom = await openParts();
    const doc = dom.window.document;

    const headers = [...doc.querySelectorAll("#tbl-parts thead th")].map((th) =>
      th.textContent?.trim(),
    );
    expect(headers[headers.length - 1]).toBe("references");

    const rows = [...doc.querySelectorAll("#tbl-parts tbody tr")];
    const cells = rows.map((tr) => tr.children[tr.children.length - 1] as HTMLElement);

    // every row ends with the same kind of cell, so they all render one line tall
    expect(cells.every((td) => td.classList.contains("r"))).toBe(true);

    // collapsed, a cell shows only its count. Spelled out, the column grows to
    // its content width — 58 references is ~3000px — and shoves every column
    // after "package" off the right-hand edge of the table.
    expect(cells.every((td) => td.querySelector(".reftoggle") !== null)).toBe(true);
    expect(cells.every((td) => !td.closest("tr")?.classList.contains("open"))).toBe(true);
    expect(cells.map((td) => td.querySelector(".reftoggle")?.textContent)).toContain("▸58 refs");

    // and each cell carries its full reference list for the clipboard
    const biggest = cells
      .map((td) => td.querySelector(".reflist") as HTMLElement)
      .find((el) => (el.dataset["copy"] ?? "").split(" ").length === 58);
    expect(biggest).toBeDefined();
    expect(biggest?.dataset["copy"]).toContain("C1001");
    expect(biggest?.textContent).toContain("C1001");
    dom.window.close();
  });

  it("opens one reference list without disturbing the others", async () => {
    const dom = await openParts();
    const doc = dom.window.document;

    const row = doc.querySelector("#tbl-parts tbody tr") as HTMLElement;
    row.querySelector<HTMLButtonElement>(".reftoggle")?.click();
    expect(row.classList.contains("open")).toBe(true);
    expect([...doc.querySelectorAll("#tbl-parts tbody tr.open")].length).toBe(1);

    row.querySelector<HTMLButtonElement>(".reftoggle")?.click();
    expect(row.classList.contains("open")).toBe(false);
    dom.window.close();
  });

  it("keeps an opened reference list open across a re-render", async () => {
    // the page re-renders whenever the poll finds a change; a list you opened
    // to read must not fold itself two seconds later
    const dom = await openParts();
    const doc = dom.window.document;

    const key = (doc.querySelector("#tbl-parts tbody tr") as HTMLElement).dataset["key"];
    (doc.querySelector("#tbl-parts tbody tr .reftoggle") as HTMLElement).click();

    // a tab round trip re-renders the table from the report, as the poll does
    doc.querySelector<HTMLButtonElement>('[data-tab="issues"]')?.click();
    doc.querySelector<HTMLButtonElement>('[data-tab="parts"]')?.click();

    const again = doc.querySelector(`#tbl-parts tbody tr[data-key="${key}"]`) as HTMLElement;
    expect(again.classList.contains("open")).toBe(true);
    dom.window.close();
  });

  it("expands and collapses every reference list at once", async () => {
    const dom = await openParts();
    const doc = dom.window.document;

    const all = () => doc.querySelectorAll("#tbl-parts tbody tr").length;
    const open = () => doc.querySelectorAll("#tbl-parts tbody tr.open").length;

    doc
      .getElementById("allrefs")
      ?.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    expect(open()).toBe(all());
    expect(doc.getElementById("allrefs")?.textContent).toContain("collapse");

    doc
      .getElementById("allrefs")
      ?.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    expect(open()).toBe(0);
    dom.window.close();
  });

  it("sorts the used column as numbers, decoration and all", async () => {
    const dom = await openParts();
    const doc = dom.window.document;
    doc.querySelectorAll<HTMLElement>("#tbl-parts thead th")[4]?.click();

    // the cell reads "58×", so it carries the bare number for the sort to use
    const cells = [...doc.querySelectorAll("#tbl-parts tbody tr")].map(
      (tr) => tr.children[4] as HTMLElement,
    );
    expect(cells[0]?.textContent?.trim()).toMatch(/^\d+×$/);

    const used = cells.map((td) => Number(td.dataset["sort"]));
    expect(used).toEqual([...used].sort((a, b) => a - b));
    dom.window.close();
  });

  it("keeps earlier sorts inside later ones", async () => {
    // click value, then class: rows group by class, and stay ordered by value
    // within each group — the point of sorting the live rows, stably
    const dom = await openParts();
    const doc = dom.window.document;
    const header = doc.querySelectorAll<HTMLElement>("#tbl-parts thead th");

    header[1]?.click(); // value
    header[2]?.click(); // class

    const classes = column(doc, 2);
    const values = column(doc, 1);
    expect([...classes].sort((a, b) => a.localeCompare(b, "en"))).toEqual(classes);

    for (let i = 1; i < classes.length; i++) {
      if (classes[i] !== classes[i - 1]) continue;
      const previous = values[i - 1] as string;
      const current = values[i] as string;
      expect(previous.localeCompare(current, "en", { numeric: true })).toBeLessThanOrEqual(0);
    }
    dom.window.close();
  });

  it("shows which columns are sorting, and in what order", async () => {
    const dom = await openParts();
    const doc = dom.window.document;
    const header = doc.querySelectorAll<HTMLElement>("#tbl-parts thead th");

    header[1]?.click();
    header[2]?.click();
    expect(header[2]?.classList.contains("sorted")).toBe(true);
    expect(header[2]?.querySelector(".sortmark")?.textContent).toBe("▲1");
    expect(header[1]?.querySelector(".sortmark")?.textContent).toBe("▲2");
    expect(header[0]?.querySelector(".sortmark")?.textContent).toBe("");
    dom.window.close();
  });

  it("survives a re-render", async () => {
    const dom = await openParts();
    const doc = dom.window.document;
    doc.querySelectorAll<HTMLElement>("#tbl-parts thead th")[0]?.click();
    const sorted = column(doc, 0);

    doc.querySelector<HTMLButtonElement>('[data-tab="issues"]')?.click();
    doc.querySelector<HTMLButtonElement>('[data-tab="parts"]')?.click();
    expect(column(doc, 0)).toEqual(sorted);
    dom.window.close();
  });
});

describe("the consolidation tab", () => {
  /** The page with a clipboard, so a copy can be observed. */
  async function openFindings(): Promise<{ dom: JSDOM; copied: string[] }> {
    const report: unknown = JSON.parse(JSON.stringify(await buildReport(board)));
    const copied: string[] = [];
    const dom = new JSDOM(page, {
      url: "http://localhost/",
      runScripts: "dangerously",
      pretendToBeVisual: true,
      beforeParse(window) {
        (window as unknown as { fetch: () => Promise<unknown> }).fetch = () =>
          Promise.resolve({ ok: true, json: () => Promise.resolve(report), text: () => "" });
        Object.defineProperty(window.navigator, "clipboard", {
          value: {
            writeText: (text: string) => {
              copied.push(text);
              return Promise.resolve();
            },
          },
        });
      },
    });
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5));
    return { dom, copied };
  }

  it("says keep and move as labels, not as controls", async () => {
    // the tool never changes a footprint: the PCB already has that footprint
    // placed, and swapping it there can break routing. A bordered pill looked
    // like a button that would do the move, and no such button can exist.
    const { dom } = await openFindings();
    const doc = dom.window.document;

    const verdicts = [...doc.querySelectorAll(".verdict")].map((v) => v.textContent);
    expect(verdicts).toContain("keep");
    expect(verdicts).toContain("move");
    expect(doc.querySelectorAll(".verdict button, button .verdict")).toHaveLength(0);
    dom.window.close();
  });

  it("copies a package group's references when its row is clicked", async () => {
    // what you actually do with "move R2001, R3001" is paste it into KiCad's
    // search box, so the whole row — label included — is the copy target
    const { dom, copied } = await openFindings();
    const doc = dom.window.document;

    const row = doc.querySelector(".pkgrow[data-copy]") as HTMLElement;
    const expected = row.dataset["copy"] as string;
    expect(expected).not.toBe("");

    (row.querySelector(".verdict") as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 5));

    expect(copied).toEqual([expected]);
    expect(doc.getElementById("toast")?.textContent).toBe(
      `copied ${expected.split(" ").length} references`,
    );
    dom.window.close();
  });
});

describe("the BOM's own columns in the parts table", () => {
  const withFields = fixture("kicad10", "custom-fields.bom.csv");

  /** The page, driven straight off a report — no server needed to render it. */
  async function openParts(project: string): Promise<JSDOM> {
    const report: unknown = JSON.parse(JSON.stringify(await buildReport(project)));
    const dom = new JSDOM(page, {
      url: "http://localhost/",
      runScripts: "dangerously",
      pretendToBeVisual: true,
      beforeParse(window) {
        (window as unknown as { fetch: () => Promise<unknown> }).fetch = () =>
          Promise.resolve({ ok: true, json: () => Promise.resolve(report), text: () => "" });
      },
    });
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5));
    dom.window.document.querySelector<HTMLButtonElement>('[data-tab="parts"]')?.click();
    return dom;
  }

  const headers = (d: Document): string[] =>
    [...d.querySelectorAll("#tbl-parts thead th")].map((th) => th.textContent?.trim() ?? "");

  let dom: JSDOM;
  let doc: Document;

  beforeAll(async () => {
    dom = await openParts(withFields);
    doc = dom.window.document;
  });

  afterAll(() => dom.window.close());

  const chips = (tr: Element): string[] =>
    [...tr.querySelectorAll(".fchip")].map((c) => c.textContent?.trim() ?? "");

  it("puts the BOM's own data in one cell per part", () => {
    // a column per field is the obvious layout and the wrong one: this board
    // has nine custom fields and six of them are on a single part, so the table
    // would have been eighteen columns of mostly nothing
    expect(headers(doc)).toEqual([
      // what the board says
      "key",
      "value",
      "class",
      "package",
      "used",
      "issues",
      // what you decide
      "bought as",
      "vendor",
      "vendor part number",
      // what else is known
      "bom fields",
      "description",
      "references",
    ]);
  });

  it("shows a part only the fields it actually has", async () => {
    const dom = await openParts(withFields);
    const doc = dom.window.document;
    const row = (key: string): Element =>
      doc.querySelector(`#tbl-parts tbody tr[data-key="${key}"]`) as Element;

    expect(chips(row("L|DFE322520F|1210"))).toEqual(["Inductivity 2u2"]);
    // the EDAC connector is the one part carrying the vendor's four fields
    expect(chips(row("J|690-005-299-043|EDAC_690-005-299-043"))).toEqual([
      "MANUFACTURER EDAC",
      "MAXIMUM_PACKAGE_HEIGHT 3.98mm",
      "PARTREV 11",
      "STANDARD Manufacturer Recommendations",
    ]);
    dom.window.close();
  });

  it("carries a field over to the merged part that only one spelling had", async () => {
    // 100n and 100nF are one purchase; the voltage was only ever typed on the
    // four 100nF parts, and it is the merged row that has to show it
    const dom = await openParts(withFields);
    const doc = dom.window.document;

    const row = doc.querySelector('#tbl-parts tbody tr[data-key="C|100n|0603"]') as Element;
    expect(chips(row)).toEqual(["Volrtage 50V"]);
    dom.window.close();
  });

  it("makes a datasheet a link", async () => {
    const dom = await openParts(withFields);
    const doc = dom.window.document;

    const link = doc.querySelector("#tbl-parts a.fchip") as HTMLAnchorElement;
    expect(link.href).toBe("https://www.ecsxtal.com/store/pdf/ECS-2520MV.pdf");
    // the scheme is noise in a chip this narrow
    expect(link.textContent).toBe("datasheet www.ecsxtal.com/store/pdf/ECS-2520MV.pdf");
    dom.window.close();
  });

  it("finds a part by a field value, not just by value or reference", async () => {
    const dom = await openParts(withFields);
    const doc = dom.window.document;

    const filter = doc.getElementById("filter") as HTMLInputElement;
    filter.value = "edac";
    filter.dispatchEvent(new dom.window.Event("input", { bubbles: true }));

    const visible = [...doc.querySelectorAll("#tbl-parts tbody tr")].filter(
      (tr) => (tr as HTMLElement).style.display !== "none",
    );
    expect(visible).toHaveLength(1);
    expect((visible[0] as HTMLElement).dataset["key"]).toContain("690-005-299-043");
    dom.window.close();
  });

  it("leaves the cell empty for a part the BOM says nothing extra about", async () => {
    // the reference export was taken before custom fields were asked for, so
    // its parts carry a description and, for a handful, a datasheet. Every
    // other row's cell has to be empty rather than a line of dashes.
    const dom = await openParts(board);
    const doc = dom.window.document;
    expect(headers(doc)).toEqual([
      // what the board says
      "key",
      "value",
      "class",
      "package",
      "used",
      "issues",
      // what you decide
      "bought as",
      "vendor",
      "vendor part number",
      // what else is known
      "bom fields",
      "description",
      "references",
    ]);

    const column = headers(doc).indexOf("bom fields");
    const cells = [...doc.querySelectorAll("#tbl-parts tbody tr")].map(
      (tr) => tr.children[column] as HTMLElement,
    );
    expect(cells.filter((td) => td.textContent === "").length).toBeGreaterThan(cells.length / 2);
    dom.window.close();
  });
});
