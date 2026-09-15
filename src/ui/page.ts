import { sortScript } from "./sort.js";
import { viewerScript } from "./viewer.js";

/**
 * The whole UI: one self-contained page, no build step and no CDN, so it works
 * offline and the server stays a static-string-plus-JSON affair.
 */
export const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>kinv</title>
<style>
:root {
  color-scheme: light dark;
  --bg: #fbfaf8;
  --panel: #ffffff;
  --line: #e5e1da;
  --ink: #1c1a17;
  --muted: #6f6a62;
  --accent: #b4530a;
  --error: #b3261e;
  --warn: #8a6100;
  --info: #4a5a6a;
  --ok: #2e6b3e;
  --mono: ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #16161a;
    --panel: #1e1e23;
    --line: #32323a;
    --ink: #e8e6e3;
    --muted: #9b958c;
    --accent: #e8934a;
    --error: #f2857c;
    --warn: #d6ac57;
    --info: #9db4c8;
    --ok: #7fc08e;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
}
header {
  position: sticky; top: 0; z-index: 10;
  background: var(--bg);
  border-bottom: 1px solid var(--line);
  padding: 14px 20px 0;
}
.title { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
.title h1 { font-size: 17px; margin: 0; letter-spacing: -0.01em; }
.title .path { color: var(--muted); font-size: 12px; font-family: var(--mono); }
.stats { display: flex; gap: 22px; flex-wrap: wrap; margin: 12px 0 4px; }
.stat b { display: block; font-size: 21px; font-weight: 600; letter-spacing: -0.02em; }
.stat span { font-size: 11px; text-transform: uppercase; letter-spacing: 0.07em; color: var(--muted); }
.stat.err b { color: var(--error); }
.stat.warn b { color: var(--warn); }
.stat.ok b { color: var(--ok); }
nav { display: flex; gap: 2px; margin-top: 10px; }
nav button {
  background: none; border: 0; border-bottom: 2px solid transparent;
  color: var(--muted); font: inherit; padding: 7px 12px; cursor: pointer;
}
nav button[aria-selected="true"] { color: var(--ink); border-bottom-color: var(--accent); }
main { padding: 20px; max-width: 1180px; }
/* Cards read best at a text width; a twelve-column table does not. The tab
   decides, rather than every tab paying for the widest one.
   No cap at all on a table tab: 1600px left a third of a wide monitor empty
   beside a table that had columns waiting for the room. */
main.wide { max-width: none; }
section h2 {
  font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em;
  color: var(--muted); margin: 26px 0 10px; font-weight: 600;
}
section h2:first-child { margin-top: 0; }
.card {
  background: var(--panel); border: 1px solid var(--line);
  border-radius: 7px; padding: 12px 14px; margin-bottom: 8px;
}
.card .head { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; }
.key { font-family: var(--mono); font-weight: 600; }
.muted { color: var(--muted); }
.advice { color: var(--accent); margin-top: 6px; }
/* A reference list is not decoration: it is the thing you read off the card and
   type into KiCad's search box. It was set two sizes down and in the muted
   grey, which is legible in a heading and hard work over 58 designators. Same
   size as the key beside it now, in the body colour — the key still stands
   apart, by weight rather than by making this one harder to read. */
.refs {
  font-family: var(--mono); font-size: 14px; color: var(--ink);
  margin-top: 5px; word-break: break-all; cursor: copy;
}
.refs:hover { color: var(--accent); }
.pkgs { margin-top: 8px; display: grid; gap: 4px; }
.pkgrow {
  display: grid; grid-template-columns: 58px 62px 1fr; gap: 8px; align-items: baseline;
  cursor: copy; border-radius: 4px; padding: 1px 4px; margin-left: -4px;
}
.pkgrow:hover { background: color-mix(in srgb, var(--accent) 8%, transparent); }
.pill {
  font-family: var(--mono); font-size: 11px; padding: 1px 7px;
  border: 1px solid var(--line); border-radius: 99px;
}
/* "keep" and "move" are the tool's reading of the finding, not buttons that
   perform it: a footprint change belongs to a human in the PCB editor, because
   the board already has that footprint placed and routed. They were drawn as
   bordered pills, which is the shape of a control, and invited a click that
   could never arrive. A label is a label. */
.verdict {
  font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em;
  font-family: inherit;
}
.verdict.keep { color: var(--ok); }
.verdict.move { color: var(--accent); }
.pill.keep { color: var(--ok); border-color: currentColor; }
.pill.move { color: var(--accent); border-color: currentColor; }
/* settling a finding, and the rewrite it can offer instead */
.solve {
  margin-left: auto; background: none; border: 1px solid var(--line); border-radius: 5px;
  color: var(--muted); font: inherit; font-size: 12px; padding: 2px 9px; cursor: pointer;
}
.solve:hover { color: var(--ok); border-color: currentColor; }
.card.settled { opacity: 0.62; }
.card.settled:hover { opacity: 1; }
.card.settled .solve:hover { color: var(--accent); }
.single {
  display: inline-flex; align-items: baseline; gap: 4px;
  min-width: 168px; margin-bottom: 2px;
}
.solve.mini {
  border: 0; padding: 0 4px; font-size: 11px; opacity: 0; line-height: 1;
}
.single:hover .solve.mini { opacity: 1; }
.spellrow {
  display: grid; grid-template-columns: 120px 190px 1fr; gap: 8px; align-items: baseline;
  cursor: copy; border-radius: 4px; padding: 1px 4px; margin-left: -4px;
}
.spellrow:hover { background: color-mix(in srgb, var(--accent) 8%, transparent); }
.usethis {
  background: none; border: 1px solid var(--line); border-radius: 5px; color: var(--accent);
  font: inherit; font-size: 12px; padding: 1px 8px; cursor: pointer; text-align: left;
}
.usethis:hover { border-color: currentColor; }
.usethis.open { border-color: currentColor; background: color-mix(in srgb, var(--accent) 12%, transparent); }
.panel {
  margin-top: 10px; padding: 10px 12px; border: 1px solid var(--line);
  border-radius: 6px; background: var(--bg); font-size: 13px;
}
.panel.warn { border-color: var(--warn); color: var(--warn); }
.panel.ok { border-color: var(--ok); color: var(--ok); }
.phead { color: var(--muted); margin-bottom: 7px; }
.pfile { font-family: var(--mono); font-size: 12px; color: var(--muted); margin: 6px 0 2px; }
.pedit { display: flex; gap: 8px; flex-wrap: wrap; align-items: baseline; font-size: 12px; }
.pedit .key { min-width: 72px; }
.alsoaffects { color: var(--warn); }
.pskip { margin-top: 7px; color: var(--muted); font-size: 12px; }
.pactions { display: flex; gap: 10px; align-items: center; margin-top: 10px; }
.apply, .pathwrite, #export {
  background: var(--accent); border: 0; border-radius: 5px; color: var(--bg);
  font: inherit; padding: 4px 14px; cursor: pointer;
}
.apply:disabled, .pathwrite:disabled, #export:disabled { opacity: 0.5; cursor: default; }
.pactions .linkish { margin-left: 0; }
/* step 2: the MPN a generic is bought as */
td.assign { white-space: nowrap; }
tr.done td.assign .key { color: var(--ok); }
.assignform { display: inline-flex; gap: 6px; align-items: center; }
.assignform input {
  padding: 3px 7px; border: 1px solid var(--line); border-radius: 5px;
  background: var(--bg); color: var(--ink); font: inherit; font-size: 13px;
  font-family: var(--mono);
}
.assignform .mpn { width: 18ch; }
.assignform .mfr { width: 12ch; }
.assignform .save {
  background: var(--accent); border: 0; border-radius: 5px; color: var(--bg);
  font: inherit; font-size: 12px; padding: 3px 11px; cursor: pointer;
}
.editassign { text-decoration: none; font-size: 12px; }
.needsmpn { font-size: 12px; }
/* The two directions of the schematic round trip. Bordered rather than filled:
   each one opens a plan, and the filled button is the one inside that panel
   that actually writes. */
.sync {
  background: none; border: 1px solid var(--line); border-radius: 5px; color: var(--ink);
  font: inherit; font-size: 12px; padding: 4px 11px; cursor: pointer; white-space: nowrap;
}
.sync:hover { border-color: var(--accent); color: var(--accent); }
.sync.open { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, transparent); }
#syncpanel { max-width: 720px; }
#syncpanel .panel { margin-top: 0; margin-bottom: 12px; }
.fieldsapply, .adoptapply {
  background: var(--accent); border: 0; border-radius: 5px; color: var(--bg);
  font: inherit; padding: 4px 14px; cursor: pointer;
}
.fieldsapply:disabled, .adoptapply:disabled { opacity: 0.5; cursor: default; }
/* step 3: who you buy it from, and what they call it */
td.vendor { white-space: nowrap; }
td.vendor input {
  padding: 3px 7px; border: 1px solid var(--line); border-radius: 5px;
  background: var(--bg); color: var(--ink); font: inherit; font-size: 13px;
  font-family: var(--mono); width: 14ch;
}
td.vendor .savevendor {
  background: none; border: 1px solid var(--line); border-radius: 5px; color: var(--muted);
  font: inherit; font-size: 12px; padding: 3px 9px; margin-left: 6px; cursor: pointer;
}
td.vendor .savevendor:hover { color: var(--ink); border-color: var(--accent); }
/* An edit nobody has saved yet is visible as one, so a row you typed into and
   walked away from does not look like a row that is filed. */
td.vendor input.dirty { border-color: var(--accent); }
/* A part you have found a vendor for is marked at the vendor, not at the key:
   the key's own left edge already says whether it has an MPN. */
#tbl-parts tr.sourced td.vend-cell { box-shadow: inset 3px 0 0 var(--ok); }
.boards { color: var(--muted); font-size: 12px; white-space: nowrap; }
.boards input {
  width: 6ch; padding: 5px 7px; margin-left: 4px;
  border: 1px solid var(--line); border-radius: 5px;
  background: var(--panel); color: var(--ink); font: inherit;
}
#export { padding: 5px 15px; }
#exports { margin-top: 14px; max-width: 720px; }
/* Where a machine with no file dialog types the path instead. */
.pathbox {
  flex: 1 1 22ch; min-width: 0; padding: 4px 8px;
  border: 1px solid var(--line); border-radius: 5px;
  background: var(--panel); color: var(--ink); font: inherit; font-size: 13px;
  font-family: var(--mono);
}
.sev { font-family: var(--mono); font-size: 11px; font-weight: 600; }
.sev.error { color: var(--error); }
.sev.warning { color: var(--warn); }
.sev.info { color: var(--info); }
.tablewrap { overflow-x: auto; border: 1px solid var(--line); border-radius: 7px; background: var(--panel); }
table { border-collapse: collapse; width: 100%; font-size: 13px; }
th, td { text-align: left; padding: 7px 11px; border-bottom: 1px solid var(--line); white-space: nowrap; }
th { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); font-weight: 600; }
th[data-col] { cursor: pointer; user-select: none; white-space: nowrap; }
th[data-col]:hover { color: var(--ink); }
th.sorted { color: var(--accent); }
.sortmark { font-size: 9px; margin-left: 3px; letter-spacing: 0; }
tr:last-child td { border-bottom: 0; }
td.k { font-family: var(--mono); }
/* A single long key or package sets the column width for the whole table, and
   white-space: nowrap means it sets it to the full 70 characters of
   Y|ECS-2520MV-120-BL-TR|Oscillator_SMD_ECS_2520MV-xxx-xx-4Pin_2.5x2.0mm.
   One such part pushed every column after "package" off the right-hand edge,
   behind a scrollbar at the bottom of an 89-row table. Both are capped, with
   the full text on the cell's title. */
#tbl-parts td.k { max-width: 24ch; overflow: hidden; text-overflow: ellipsis; }
/* Whether this is a part you buy at all, at the left edge of the row it is
   about. Muted until you go near it: it is the one control on the table that
   takes a row away, and it should not compete with the boxes you came to fill
   in. Nothing is lost — the part lands on "Not bought" with a button back. */
.nobuy {
  background: none; border: 0; padding: 0 6px 0 0; margin: 0;
  color: var(--muted); opacity: 0.45; font: inherit; line-height: 1; cursor: pointer;
}
tr:hover .nobuy { opacity: 1; }
.nobuy:hover { color: var(--accent); opacity: 1; }
/* The clamp moves off the cell and onto the key itself, so the buttons either
   side of it are never the thing the ellipsis eats. */
#tbl-parts td.key-cell { max-width: none; overflow: visible; }
#tbl-parts td.key-cell .kname {
  display: inline-block; max-width: 26ch; overflow: hidden; text-overflow: ellipsis;
  vertical-align: bottom; white-space: nowrap;
}
/* The distributor's own wording is only useful in their search box, so it sits
   next to a button that puts it on the clipboard. Muted until the row is under
   the pointer: 89 rows of blue would be a table of buttons with some parts in
   it. */
.copykey {
  background: none; border: 0; padding: 0 0 0 6px; margin: 0;
  color: var(--muted); opacity: 0.45; font: inherit; line-height: 1; cursor: pointer;
}
tr:hover .copykey { opacity: 1; }
.copykey:hover { color: var(--accent); opacity: 1; }
/* The way back: on a card in "Not bought", where the row now lives. */
.buythis {
  margin-left: auto; background: none; border: 1px solid var(--line); border-radius: 5px;
  color: var(--muted); font: inherit; font-size: 12px; padding: 2px 9px; cursor: pointer;
}
.buythis:hover { color: var(--accent); border-color: currentColor; }
/* The key stays put while the rest scrolls sideways, so a row never becomes
   anonymous. */
#tbl-parts th:first-child, #tbl-parts td:first-child {
  position: sticky; left: 0; background: var(--panel);
  box-shadow: 1px 0 0 var(--line);
}
#tbl-parts thead th:first-child { background: var(--panel); z-index: 1; }
/* A part with an MPN is marked at the left edge. The sticky column's own
   divider is repeated here because a second box-shadow replaces it. */
#tbl-parts tr.done td:first-child {
  box-shadow: inset 3px 0 0 var(--ok), 1px 0 0 var(--line);
}
/* A reference list is collapsed to its count. Without that cap, one part with
   58 references made the table ~3000px wide and pushed every column after
   "package" off the right edge — and now that the BOM's own fields have columns
   too, there is far less room to spend. Opening one wraps it in place rather
   than adding a row, so the sort order is unaffected. */
td.r { font-family: var(--mono); font-size: 13px; color: var(--ink); }
/* the toggle stays muted — it is a control, not the data */
.reftoggle {
  background: none; border: 0; color: var(--muted); font: inherit;
  cursor: pointer; padding: 0; white-space: nowrap;
}
.reftoggle:hover { color: var(--ink); }
.caret { display: inline-block; margin-right: 4px; transition: transform .12s; }
tr.open .caret { transform: rotate(90deg); }
tr.open .reftoggle { color: var(--ink); }
.reflist { display: none; }
tr.open .reflist {
  display: block; white-space: normal; word-break: break-all;
  max-width: 52ch; margin-top: 4px; cursor: copy;
}
tr.open .reflist:hover { color: var(--accent); }
/* A description is one line tall at most: it runs long, and the title attribute
   carries the rest. It is also the column that takes up the slack — width:100%
   with a shrinkable max-width is what makes one cell in an auto-layout table
   absorb the leftover room instead of it being shared out as padding, and the
   min-width stops it collapsing when the window is narrow. */
td.bom { width: 100%; max-width: 0; min-width: 24ch; }
td.bom .clip {
  display: block;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
/* One cell holds whatever the BOM knows about this part. Chips wrap, so a
   connector with four fields grows a row taller and a plain resistor stays on
   one line — which is the shape of real board data. */
td.fields { white-space: normal; max-width: 30ch; }
.fchip {
  display: inline-block; font-size: 11px; line-height: 1.6;
  padding: 0 7px; margin: 1px 4px 1px 0;
  border: 1px solid var(--line); border-radius: 99px;
  max-width: 32ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  vertical-align: middle; font-family: var(--mono);
}
.fchip b { font-weight: 500; color: var(--muted); }
a.fchip { color: var(--accent); text-decoration: none; }
a.fchip:hover { border-color: currentColor; }
.toolbar { display: flex; align-items: center; gap: 14px; margin-bottom: 10px; flex-wrap: wrap; }
/* the counts and the export controls sit at the far end of the toolbar */
.toolbar .grow { margin-left: auto; }
.toolbar input[type="search"] { margin-bottom: 0; }
.toolbar .linkish { margin-left: 0; }
td.n { text-align: right; font-variant-numeric: tabular-nums; }
input[type="search"] {
  width: 100%; max-width: 340px; padding: 7px 10px; margin-bottom: 10px;
  border: 1px solid var(--line); border-radius: 6px;
  background: var(--panel); color: var(--ink); font: inherit;
}
.status {
  position: fixed; right: 14px; bottom: 12px; font-size: 12px; color: var(--muted);
  background: var(--panel); border: 1px solid var(--line);
  border-radius: 99px; padding: 5px 12px;
}
.status.busy { color: var(--accent); }
.empty { color: var(--muted); padding: 8px 0; }
.toast {
  position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%);
  background: var(--ink); color: var(--bg); padding: 7px 14px; border-radius: 6px;
  font-size: 13px; opacity: 0; transition: opacity .15s; pointer-events: none;
}
.toast.show { opacity: 1; }

/* footprint viewer */
/* The viewer rides in a table tab, and a 420px-tall drawing stretched over a
   whole 4K window is mostly empty background. */
.fpcard { padding: 14px; max-width: 1180px; }
.fpgrid { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 16px; margin-top: 10px; }
@media (max-width: 820px) { .fpgrid { grid-template-columns: minmax(0, 1fr); } }
.fpstage { min-width: 0; }
#fpsvg {
  width: 100%; height: 420px; display: block; cursor: crosshair;
  background: var(--bg); border: 1px solid var(--line); border-radius: 6px;
}
#fpsvg .pad { fill: #c8721f; }
#fpsvg .ep { fill: #8a5a2b; }
#fpsvg .paste { fill: none; stroke: #b4530a; stroke-width: 0.02; stroke-dasharray: 0.1 0.1; }
#fpsvg .drill { fill: var(--bg); stroke: var(--muted); stroke-width: 0.02; }
#fpsvg .crtyd { fill: none; stroke: var(--muted); stroke-width: 0.03; stroke-dasharray: 0.25 0.15; }
#fpsvg .pnum { fill: #fff; text-anchor: middle; pointer-events: none; }
#fpsvg .ruler { stroke: var(--ink); stroke-width: 0.035; stroke-dasharray: 0.12 0.08; }
#fpsvg .mark { fill: none; stroke: var(--ink); stroke-width: 0.035; }
#fpsvg .mark.snap { stroke: var(--accent); }
#fpsvg .mark.snap.free { stroke: var(--muted); }
@media (prefers-color-scheme: dark) {
  #fpsvg .pad { fill: #e8934a; }
  #fpsvg .ep { fill: #a8703a; }
  #fpsvg .pnum { fill: #1a1a1a; }
}
.fpread {
  font-family: var(--mono); font-size: 12px; margin-top: 7px;
  min-height: 20px; color: var(--ink);
}
.fpread .muted { color: var(--muted); }
.fpmeta { font-size: 13px; min-width: 0; }
table.kv { border-collapse: collapse; width: 100%; margin-bottom: 10px; }
table.kv th {
  text-align: left; font-weight: 500; color: var(--muted); padding: 3px 10px 3px 0;
  white-space: nowrap; font-size: 12px; text-transform: none; letter-spacing: 0;
}
table.kv td { font-family: var(--mono); padding: 3px 0; border: 0; white-space: normal; }
.fpfind { margin-top: 6px; font-size: 12px; }
.fpfind.ok { color: var(--ok); }
.fppath { margin-top: 10px; font-size: 11px; color: var(--muted); word-break: break-all; }
.linkish {
  background: none; border: 0; color: var(--muted); font: inherit;
  cursor: pointer; margin-left: auto; text-decoration: underline;
}
tr[data-fp] { cursor: pointer; }
tr[data-fp]:hover td { background: color-mix(in srgb, var(--accent) 8%, transparent); }
tr[data-fp].sel td { background: color-mix(in srgb, var(--accent) 16%, transparent); }
tr[data-fp].sel td:first-child { box-shadow: inset 3px 0 0 var(--accent); font-weight: 600; }
</style>
</head>
<body>
<header>
  <div class="title"><h1>kinv</h1><span class="path" id="path"></span></div>
  <div class="stats" id="stats"></div>
  <nav id="tabs"></nav>
</header>
<main><div id="fpview"></div><div id="view"><p class="empty">Reading the project…</p></div></main>
<div class="status" id="status">connecting…</div>
<div class="toast" id="toast"></div>
<script>
var TABS = [
  { id: "findings", label: "Consolidation" },
  { id: "issues", label: "Issues" },
  { id: "parts", label: "Parts" },
  { id: "footprints", label: "Footprints" },
  { id: "excluded", label: "Not bought" }
];
var active = "findings";
var data = null;
/**
 * Stamped by the server with a hash of this page. The page re-renders from
 * JSON and never reloads itself, so editing the UI and restarting the server
 * used to leave an open tab running the old script against the new data —
 * silently, and for as long as the tab stayed open.
 */
var BUILD = "__KINV_BUILD__";
/**
 * Which parts have their reference list open, by canonical key.
 *
 * Kept outside the render so a two-second poll that finds a change does not
 * fold every list you just opened.
 */
var partsOpen = {};
/**
 * The rewrite panel a card is currently showing: which card, which spelling it
 * would keep, and the panel as rendered.
 *
 * Kept outside the render for the same reason the open reference lists are:
 * the page re-renders whenever the two-second poll finds a change, and the
 * panel is something you are in the middle of reading. It closes when you say
 * so — the same button again, cancel, or apply — and not before.
 */
var rewriteOpen = null;
/** The part key whose MPN box is open for editing, if any. */
var resolveOpen = null;
/**
 * How many boards the export is for. The only number the tool asks you for,
 * and the only one it multiplies by: a quantity is placements x boards and
 * nothing else — no spares, no pack sizes, no price breaks.
 */
var buyBoards = 1;
/**
 * What is typed into a row but not yet saved, by "part key + box".
 *
 * The page re-renders whenever the report changes — you save in KiCad, or a
 * part gets assigned — and a re-render rebuilds every input from the report,
 * which used to take a half-typed manufacturer with it. What you typed is a
 * decision in progress: it outlives the render, and the box you were in keeps
 * the focus and the caret. It is forgotten the moment the row is filed.
 */
var typed = {};
/**
 * The upload files, as last read from disk — kept outside the render because
 * the two-second poll re-renders the table and the panel is not part of the
 * report. Null until the tab has asked for them once.
 */
var exportsInfo = null;
/**
 * Whether the export is waiting on the folder dialog.
 *
 * The dialog is a separate process and takes about two seconds to appear —
 * long enough that a button which only greyed itself read as a button that did
 * nothing. It says what it is waiting for instead, and it says it in the
 * button you just pressed rather than in a panel at the bottom of an 89-row
 * table where you would never look.
 */
var exportBusy = false;
/**
 * The open schematic-sync panel: which direction, and the panel as rendered.
 *
 * Kept outside the render for the reason every other panel is — the poll
 * re-renders the table, and a plan you are reading before writing to your
 * schematic is the last thing that should vanish under you. It closes when you
 * say so: the same button again, cancel, or apply.
 */
var syncOpen = null;

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
  });
}
function refs(list) {
  return '<div class="refs" title="click to copy" data-copy="' + esc(list.join(" ")) + '">' +
    esc(list.join(", ")) + "</div>";
}
function toast(msg) {
  var t = document.getElementById("toast");
  t.textContent = msg;
  t.className = "toast show";
  setTimeout(function () { t.className = "toast"; }, 1200);
}

/**
 * A box's identity across renders: which row it is in, and which box it is.
 *
 * The MPN boxes sit in a form of their own carrying the same key, so the
 * nearest data-key is the right one either way.
 */
function boxKey(input) {
  var holder = input.closest("[data-key]");
  if (!holder || !input.dataset.box) return null;
  return holder.dataset.key + " " + input.dataset.box;
}

/** What goes in the box: what you typed if you have typed, else what is filed. */
function draft(key, box, stored) {
  var pending = typed[key + " " + box];
  return pending === undefined ? stored : pending;
}

/** Forgets a row's typing, once the row is filed. */
function clearDrafts(key) {
  Object.keys(typed).forEach(function (id) {
    if (id.indexOf(key + " ") === 0) delete typed[id];
  });
}

/** Where the caret is, so a re-render does not steal it mid-word. */
function focusedBox() {
  var el = document.activeElement;
  if (!el || !el.dataset || !el.dataset.box) return null;
  var id = boxKey(el);
  return id === null ? null : { id: id, start: el.selectionStart, end: el.selectionEnd };
}

function restoreFocus(spot) {
  if (!spot) return;
  var boxes = document.querySelectorAll("[data-box]");
  for (var i = 0; i < boxes.length; i++) {
    if (boxKey(boxes[i]) !== spot.id) continue;
    boxes[i].focus();
    // A number box has no caret to place, and says so by throwing.
    try { boxes[i].setSelectionRange(spot.start, spot.end); } catch (ignored) { /* no caret */ }
    return;
  }
}

/** An edit that has not been saved yet looks different from one that has. */
function markDirty(input) {
  if (input.dataset.was === undefined) return;
  input.classList.toggle("dirty", input.value.trim() !== input.dataset.was);
}

function paintDirty() {
  document.querySelectorAll("[data-was]").forEach(markDirty);
}

function renderStats(d) {
  var s = d.summary, c = d.counts;
  var tiles = [
    { v: s.placements, l: "placements" },
    { v: s.lines, l: "BOM lines" },
    { v: s.parts, l: "distinct parts" },
    { v: c.findings, l: "findings" },
    { v: c.errors, l: "errors", cls: c.errors ? "err" : "ok" },
    { v: c.warnings, l: "warnings", cls: c.warnings ? "warn" : "" },
    { v: c.resolved, l: "already resolved", cls: "ok" },
    { v: c.footprintFindings, l: "footprint findings", cls: c.footprintFindings ? "warn" : "ok" },
    { v: c.excluded, l: "not bought" }
  ];
  document.getElementById("stats").innerHTML = tiles.map(function (t) {
    return '<div class="stat ' + (t.cls || "") + '"><b>' + t.v + "</b><span>" + t.l + "</span></div>";
  }).join("");
}

/** Sortable header cells: every data table gets the same treatment. */
function head(labels) {
  return labels.map(function (label, i) {
    return '<th data-col="' + i + '">' + esc(label) + '<span class="sortmark"></span></th>';
  }).join("");
}

function group(list, kind) {
  return list.filter(function (f) { return f.kind === kind; });
}

/**
 * The control that settles a finding.
 *
 * Fixing something in KiCad makes its finding disappear on the next save, so
 * this is for the other case: the finding is right, you have looked at it, and
 * the answer is "yes, on purpose". It records the finding's current wording,
 * so the same question asked about a *different* state of the board comes back.
 */
function solveButton(f, settled) {
  return '<button type="button" class="solve" data-id="' + esc(f.id) +
    '" data-signature="' + esc(f.signature) + '" data-solved="' + (settled ? "false" : "true") +
    '">' + (settled ? "reopen" : "mark solved") + "</button>";
}

function cardHead(f, settled, inner) {
  return '<div class="head">' + inner + solveButton(f, settled) + "</div>";
}

/** One spelling of a duplicate, and the button that makes it the only one. */
function spellingCard(f, settled) {
  var rows = f.spellings.map(function (sp) {
    var others = f.spellings.filter(function (o) { return o.value !== sp.value; });
    var groups = others.map(function (o) { return { from: o.value, refs: o.refs }; });
    var moving = others.reduce(function (n, o) { return n + o.placements; }, 0);
    return '<div class="spellrow" data-copy="' + esc(sp.refs.join(" ")) + '">' +
      '<span class="key">' + esc(sp.value) + " ×" + sp.placements + "</span>" +
      (settled || others.length === 0
        ? '<span class="muted"></span>'
        : '<button type="button" class="usethis" data-to="' + esc(sp.value) +
          '" data-groups="' + esc(JSON.stringify(groups)) + '">use this everywhere' +
          '<span class="muted"> · ' + moving + " to change</span></button>") +
      refs(sp.refs) + "</div>";
  }).join("");

  return '<div class="card" data-finding="' + esc(f.id) + '">' +
    cardHead(f, settled, '<span class="key">' + esc(f.key) + '</span><span class="muted">' +
      f.placements + " placements</span>") +
    '<div class="pkgs">' + rows + '</div><div class="rewrite"></div></div>';
}

function renderSettled(d) {
  var list = d.settled || [];
  if (!list.length) return "";
  var rows = list.map(function (f) {
    var what = f.kind === "duplicate-spelling" || f.kind === "mixed-footprint" ||
      f.kind === "singleton" ? f.key : f.kind === "multi-package" ? f.value + f.unit
      : f.members.map(function (m) { return m.value; }).join(" / ");
    return '<div class="card settled">' +
      cardHead(f, true, '<span class="sev info">' + esc(f.kind) + '</span><span class="key">' +
        esc(what) + '</span><span class="muted">' + esc(f.signature) + "</span>") + "</div>";
  }).join("");
  return '<section><h2>Settled (' + list.length + ") — decided on purpose, and kept out of the way</h2>" +
    rows + "</section>";
}

function renderFindings(d) {
  var out = "";
  if (d.counts.settled) {
    out += '<div class="toolbar"><span class="muted">' + d.counts.settled +
      ' settled</span><button type="button" id="resetsolved" class="linkish">' +
      "reopen everything</button></div>";
  }
  var dup = group(d.findings, "duplicate-spelling");
  if (dup.length) {
    var saved = dup.reduce(function (n, f) { return n + f.linesSaved; }, 0);
    out += "<section><h2>Same part, spelled differently — " + saved + " BOM lines disappear for free</h2>";
    dup.forEach(function (f) { out += spellingCard(f); });
    out += "</section>";
  }

  var multi = group(d.findings, "multi-package");
  if (multi.length) {
    out += "<section><h2>One value, several packages — a decision for you, in KiCad</h2>";
    multi.forEach(function (f) {
      var rows = f.groups.map(function (g) {
        var keep = !f.tied && g.pkg === f.suggested;
        // The whole row copies, not just the reference text: "move" reads like
        // a button, and the useful thing to do with it is take those refs to
        // KiCad's search box. Changing the footprint is not ours to do — the
        // PCB already has it placed.
        return '<div class="pkgrow" data-copy="' + esc(g.refs.join(" ")) +
          '" title="click to copy these references"><span class="verdict ' +
          (keep ? "keep" : "move") + '">' + (keep ? "keep" : "move") +
          '</span><span class="key">' + esc(g.pkg) + " ×" + g.placements +
          "</span>" + refs(g.refs) + "</div>";
      }).join("");
      var advice = f.tied
        ? f.groups.length + " equally common sizes — pick one: −" + f.linesSaved + " line items"
        : "→ standardise on " + esc(f.suggested) + ": −" + f.linesSaved + " line item" +
          (f.linesSaved === 1 ? "" : "s");
      out += '<div class="card" data-finding="' + esc(f.id) + '">' +
        cardHead(f, false, '<span class="key">' + esc(f.value) + '</span><span class="muted">' +
          esc(f.cls) + "</span>") +
        '<div class="pkgs">' + rows + '</div><div class="advice">' + advice + "</div></div>";
    });
    out += "</section>";
  }

  var near = group(d.findings, "near-value");
  if (near.length) {
    out += "<section><h2>Values suspiciously close together — probably unintentional</h2>";
    near.forEach(function (f) {
      out += '<div class="card" data-finding="' + esc(f.id) + '">' +
        cardHead(f, false, '<span class="key">' + f.spreadPercent.toFixed(1) +
          '% apart</span><span class="muted">' +
          f.members.map(function (m) { return esc(m.value) + " ×" + m.placements; }).join("  ·  ") +
          "</span>") +
        refs(f.members.reduce(function (a, m) { return a.concat(m.refs); }, [])) + "</div>";
    });
    out += "</section>";
  }

  var mixed = group(d.findings, "mixed-footprint");
  if (mixed.length) {
    out += "<section><h2>One part, different footprints</h2>";
    mixed.forEach(function (f) {
      out += '<div class="card" data-finding="' + esc(f.id) + '">' +
        cardHead(f, false, '<span class="key">' + esc(f.key) + "</span>") +
        f.footprints.map(function (fp) {
          return '<div class="pkgrow" data-copy="' + esc(fp.refs.join(" ")) +
            '" title="click to copy these references"><span class="pill">×' + fp.placements +
            '</span><span class="key" style="grid-column:2/4">' + esc(fp.footprint) + "</span></div>" +
            refs(fp.refs);
        }).join("") + "</div>";
    });
    out += "</section>";
  }

  var single = group(d.findings, "singleton");
  if (single.length) {
    out += "<section><h2>Generic values used once (" + single.length +
      ") — candidates for substitution</h2><div class=\\"card\\">" +
      single.map(function (f) {
        // each one settles on its own: "yes, that 133k is deliberate" is a
        // decision about one part, not about the list
        return '<span class="single"><span class="key">' + esc(f.value) +
          ' <span class="muted">@' + esc(f.ref) + "</span></span>" +
          '<button type="button" class="solve mini" title="mark solved" data-id="' + esc(f.id) +
          '" data-signature="' + esc(f.signature) + '" data-solved="true">✓</button></span>';
      }).join("") + "</div></section>";
  }

  out += renderSettled(d);
  return out || '<p class="empty">Nothing to consolidate — the BOM is already tidy.</p>';
}

function renderIssues(d) {
  if (!d.issues.length) return '<p class="empty">No issues found.</p>';
  var out = "";
  ["error", "warning", "info"].forEach(function (sev) {
    var group = d.issues.filter(function (i) { return i.severity === sev; });
    if (!group.length) return;
    out += "<section><h2>" + sev + "s (" + group.length + ")</h2>";
    group.forEach(function (i) {
      out += '<div class="card"><div class="head"><span class="sev ' + sev + '">' + esc(i.code) +
        '</span><span>' + esc(i.message) + "</span></div>" + refs(i.refs) + "</div>";
    });
    out += "</section>";
  });
  return out;
}

function renderExcluded(d) {
  var list = d.excluded || [];
  if (!list.length) return '<p class="empty">Everything on this board is a part you buy.</p>';

  var byReason = {};
  list.forEach(function (e) { (byReason[e.reason] = byReason[e.reason] || []).push(e); });

  return '<p class="empty">Board features rather than purchases. They are left out of the parts ' +
    "list, the consolidation report and the order — but a part number in the value or an MPN field " +
    'puts one back in, and so does "buy this".</p>' +
    Object.keys(byReason).map(function (reason) {
      var rows = byReason[reason];
      var n = rows.reduce(function (a, e) { return a + e.refs.length; }, 0);
      return "<section><h2>" + esc(reason) + " (" + n + ")</h2>" +
        rows.map(function (e) {
          return '<div class="card"><div class="head"><span class="key">' + esc(e.value || "—") +
            '</span><span class="muted">' + esc(e.footprint) + "</span>" +
            '<button type="button" class="buythis" data-key="' + esc(e.key) +
            '" title="' + esc(e.key) + '">buy this ↑</button></div>' +
            refs(e.refs) + "</div>";
        }).join("") + "</section>";
    }).join("");
}

function renderFootprints(d) {
  var list = d.footprints || [];
  if (!list.length) return '<p class="empty">No footprints could be read.</p>';

  var problems = list.filter(function (f) { return f.findings.length; });
  var out = "";

  if (problems.length) {
    out += "<section><h2>Footprint findings</h2>";
    problems.forEach(function (f) {
      out += '<div class="card"><div class="head"><span class="key">' + esc(f.reference) +
        '</span><span class="muted">×' + f.placements + "</span></div>" +
        f.findings.map(function (x) {
          return '<div><span class="sev ' + x.severity + '">' + esc(x.code) + "</span> " +
            esc(x.message) + "</div>";
        }).join("") + refs(f.refs) + "</div>";
    });
    out += "</section>";
  }

  out += '<section><h2>Measured (' + list.length + ')</h2>' +
    '<div class="tablewrap"><table id="tbl-footprints"><thead><tr>' +
    head(["footprint", "pads", "pitch", "outer span", "pad size", "EP", "mounting", "used"]) +
    "</tr></thead><tbody>" +
    list.map(function (f) {
      var m = f.measured;
      if (!m) {
        return '<tr><td class="k">' + esc(f.reference) +
          '</td><td colspan="6" class="muted">not found in any library</td><td class="n">' +
          f.placements + "</td></tr>";
      }
      var ep = m.exposedPads.length
        ? m.exposedPads[0].width + "×" + m.exposedPads[0].height
        : "";
      return '<tr data-fp="' + esc(f.reference) + '"' +
        (f.reference === fpSelected ? ' class="sel"' : "") + '><td class="k">' + esc(f.reference) +
        '</td><td class="n" data-sort="' + m.padCount + '">' + m.padCount +
        (m.pasteOnlyPads ? ' <span class="muted">+' + m.pasteOnlyPads + "p</span>" : "") +
        '</td><td class="n">' + (m.pitch == null ? "—" : m.pitch) +
        '</td><td class="n" data-sort="' + m.span.x + '">' + m.span.x + " × " + m.span.y +
        '</td><td class="n">' + (m.padSize ? m.padSize.width + " × " + m.padSize.height : "—") +
        '</td><td class="n">' + ep +
        '</td><td class="muted">' + esc(m.mounting) +
        '</td><td class="n">' + f.placements + "</td></tr>";
    }).join("") + "</tbody></table></div></section>";

  return out;
}

/**
 * The BOM's own data for one part, as chips.
 *
 * A column per field looked obvious and was wrong on a real board: nine custom
 * fields, six of them on a single part, produced an eighteen-column table that
 * was almost entirely dashes. Only the fields a part actually carries are
 * drawn, so a row says what is known about *that* part and nothing else.
 */
function bomChips(p, names) {
  return names.map(function (name) {
    var value = p.fields[name];
    if (!value) return "";
    if (name === "Datasheet") {
      var url = value.slice(0, 7).toLowerCase() === "http://" ||
        value.slice(0, 8).toLowerCase() === "https://";
      // The scheme is noise; a file:// or bare path is shown as written.
      var shown = url ? value.slice(value.indexOf("//") + 2) : value;
      if (!url) return '<span class="fchip"><b>datasheet</b> ' + esc(shown) + "</span>";
      return '<a class="fchip" href="' + esc(value) + '" target="_blank" ' +
        'rel="noreferrer noopener" title="' + esc(value) + '"><b>datasheet</b> ' +
        esc(shown) + "</a>";
    }
    return '<span class="fchip" title="' + esc(name + ": " + value) + '"><b>' + esc(name) +
      "</b> " + esc(value) + "</span>";
  }).join("");
}

/**
 * Step 2, as one cell: the real part a generic is bought as.
 *
 * Typed by hand and stored in one catalog for every board, so the next board
 * asks nothing about 10k 0603. Nothing here needs a network — that is the whole
 * point of doing the manual leg first.
 */
function assignCell(p, r) {
  var part = r.part;
  var open = resolveOpen === p.key;
  var mpn = part ? part.mpn : (r.suggestedMpn || "");

  var inner = part && !open
    ? '<span class="key">' + esc(part.mpn) + "</span>" +
      (part.manufacturer ? ' <span class="muted">' + esc(part.manufacturer) + "</span>" : "") +
      ' <button type="button" class="editassign linkish" data-key="' + esc(p.key) + '">edit</button>'
    : '<span class="assignform" data-key="' + esc(p.key) + '">' +
      '<input class="mpn" data-box="mpn" type="text" placeholder="MPN" value="' +
      esc(draft(p.key, "mpn", mpn)) + '">' +
      '<input class="mfr" data-box="mfr" type="text" placeholder="manufacturer" value="' +
      esc(draft(p.key, "mfr", part ? part.manufacturer : "")) + '">' +
      '<button type="button" class="save">save</button>' +
      (part ? '<button type="button" class="clearassign linkish">clear</button>' : "") +
      (!part && r.suggestedMpn
        ? '<span class="muted" title="the value is already a part number">from the value</span>'
        : "") + "</span>";

  // Sorts by the filed MPN, so the parts still to decide gather at one end.
  return '<td class="assign" data-sort="' + esc(part ? part.mpn : "") + '">' + inner + "</td>";
}

/**
 * Step 3, as two cells: who you buy each part from, and what they call it.
 *
 * No MPN means nothing to hang a vendor on — the catalog is keyed by part
 * number, and inventing an entry to hold "digikey" would be the tool making the
 * decision step 2 exists to ask you for. The row says so and leaves the boxes
 * out; the box that fixes it is the cell to the left, which is the whole reason
 * these are one table and not three tabs.
 *
 * Two cells rather than one spanning both: a colspan would shift every column
 * after it on that row alone, and the sort reads a column by position.
 */
function vendorCells(p, r) {
  var part = r.part;
  if (!part) {
    return '<td class="vendor vend-cell"><span class="muted needsmpn">needs an MPN</span></td>' +
      '<td class="vendor vnum-cell"></td>';
  }
  var supplier = part.supplier || "";
  var number = part.orderNumber || "";
  return '<td class="vendor vend-cell" data-sort="' + esc(supplier) + '">' +
    '<input class="vend" data-box="vend" type="text" placeholder="vendor" list="vendors" value="' +
    esc(draft(p.key, "vend", supplier)) + '" data-was="' + esc(supplier) + '"></td>' +
    '<td class="vendor vnum-cell" data-sort="' + esc(number) + '">' +
    '<input class="vnum" data-box="vnum" type="text" placeholder="their part number" value="' +
    esc(draft(p.key, "vnum", number)) + '" data-was="' + esc(number) + '">' +
    '<button type="button" class="savevendor">save</button></td>';
}


/** The export button, which doubles as the only place the wait is visible. */
function paintExportButton() {
  var btn = document.getElementById("export");
  if (!btn) return;
  btn.disabled = exportBusy;
  btn.textContent = exportBusy ? "waiting for the folder dialog…" : "export CSVs";
}

/** The upload files on disk, with enough detail to tell them apart. */
function paintExports() {
  // The read is a fetch, and a fetch can land after the page it was for is
  // gone. There is nothing to paint then.
  if (typeof document === "undefined") return;
  var host = document.getElementById("exports");
  if (!host) return;
  if (!exportsInfo) { host.innerHTML = '<div class="panel"><div class="phead">reading…</div></div>'; return; }

  var files = exportsInfo.files || [];
  var rows = files.map(function (f) {
    return '<div class="pedit"><span class="key">' + esc(f.name) + "</span>" +
      '<span class="muted">' + f.lines + " line" + (f.lines === 1 ? "" : "s") + " · " +
      f.pieces + " piece" + (f.pieces === 1 ? "" : "s") +
      (f.writtenAt ? " · " + new Date(f.writtenAt).toLocaleString() : "") + "</span></div>";
  }).join("");

  // No dialog on this machine, so the path is typed. Prefilled with where the
  // files would have gone, because that is the answer most of the time.
  var ask = exportsInfo.ask
    ? '<div class="pactions"><input class="pathbox" type="text" value="' +
      esc(exportsInfo.dir || "") + '" spellcheck="false">' +
      '<button type="button" class="pathwrite">write files here</button>' +
      '<button type="button" class="cancel linkish">cancel</button></div>'
    : "";

  host.innerHTML = '<div class="panel' + (exportsInfo.ok ? " ok" : "") +
    (exportsInfo.ask ? " warn" : "") + '"><div class="phead">' +
    esc(exportsInfo.note || (files.length ? "upload files on disk" : "nothing exported yet")) +
    "</div>" + rows + ask +
    (exportsInfo.ask ? "" : '<div class="pfile">' + esc(exportsInfo.dir || "") + "</div>") +
    "</div>";
}

/**
 * Writes the upload files into one directory, and says what went where.
 *
 * The directory travels with the request rather than being remembered by the
 * page: the server is the one that knows where the last export went, and the
 * panel's path line is read back off what it actually wrote.
 */
function writeOrders(dir) {
  return post("/api/order", { boards: buyBoards, dir: dir || "" })
    .then(function (r) {
      var pieces = r.files.reduce(function (n, f) { return n + f.pieces; }, 0);
      var left = [];
      if (r.noSupplier) left.push(r.noSupplier + " with no vendor");
      if (r.unresolved) left.push(r.unresolved + " with no MPN");
      exportsInfo = {
        dir: r.dir,
        files: r.files,
        ok: r.files.length > 0,
        note: r.files.length
          ? "wrote " + r.files.length + " file" + (r.files.length === 1 ? "" : "s") +
            " for " + r.boards + " board" + (r.boards === 1 ? "" : "s") + " · " +
            pieces + " pieces" + (left.length ? " · left out: " + left.join(", ") : "")
          : "no part has a vendor yet — nothing to write",
      };
      paintExports();
      toast(r.files.length ? "wrote " + r.files.length + " file" +
        (r.files.length === 1 ? "" : "s") : "nothing to write");
    })
    .catch(function (err) {
      toast(err.message);
      throw err;
    });
}

/** Reads the directory, so the panel says what is there rather than what this tab wrote. */
function loadExports() {
  fetch("/api/exports")
    .then(function (r) { return r.json(); })
    .then(function (d) {
      exportsInfo = { dir: d.dir, files: d.files || [] };
      paintExports();
    })
    .catch(function (err) {
      exportsInfo = { dir: "", files: [], note: "could not read the directory: " + err.message };
      paintExports();
    });
}

/**
 * Every part, in one table.
 *
 * The columns run in three bands, left to right: what the board says and you
 * cannot argue with, then the two decisions that are yours — the MPN and the
 * vendor — then the detail you read rather than act on. This was three tabs
 * over the same 89 rows, which meant finding the same row three times to
 * finish one part.
 */
function renderParts(d) {
  var cols = d.partColumns || [];
  // Description is prose every part has and reads as a column of its own; the
  // rest is per-part and goes in one cell.
  var chipCols = cols.filter(function (c) { return c !== "Description"; });
  var hasDescription = cols.indexOf("Description") >= 0;

  var byKey = {};
  (d.resolutions || []).forEach(function (r) { byKey[r.key] = r; });

  var withVendor = 0;
  var vendors = {};
  var rows = d.parts.map(function (p) {
    var r = byKey[p.key] || {};
    var part = r.part;
    var supplier = part && part.supplier ? part.supplier : "";
    if (supplier) { withVendor++; vendors[supplier] = true; }

    var chips = bomChips(p, chipCols);
    // What you decided is as findable as what the board said: one filter box
    // over the whole row, MPN and vendor included.
    var haystack = [
      p.key, p.label || "", p.value, p.cls, p.pkg, p.refs.join(" "),
      part ? part.mpn : "", part && part.manufacturer ? part.manufacturer : "",
      supplier, part && part.orderNumber ? part.orderNumber : ""
    ].concat(cols.map(function (c) { return c + " " + (p.fields[c] || ""); }))
      .join(" ").toLowerCase();

    // "done" is step 2 settled, "sourced" is step 3; a row can be either, both
    // or neither, and "open" is the reference list on top of that.
    var cls = [partsOpen[p.key] ? "open" : "", part ? "done" : "", supplier ? "sourced" : ""]
      .filter(function (c) { return c; }).join(" ");

    return '<tr data-key="' + esc(p.key) + '"' + (cls ? ' class="' + cls + '"' : "") +
      ' data-search="' + esc(haystack) + '">' +
      // What the row is, in the words a distributor uses, with the canonical
      // key on the tooltip — that is the name the catalog and .kinv files
      // know it by, and it is still what the filter box searches.
      // The sort reads the cell, and the cell holds two buttons as well as the
      // text, so the label is spelled out again for it.
      '<td class="k key-cell" data-sort="' + esc(p.label || p.key) + '">' +
      '<button type="button" class="nobuy" title="do not buy this — move it to Not bought">' +
      "⊘</button>" +
      '<span class="kname" title="' + esc(p.key) + '">' + esc(p.label || p.key) + "</span>" +
      '<button type="button" class="copykey" data-copy-label="' + esc(p.label || p.key) +
      '" title="copy &quot;' + esc(p.label || p.key) + '&quot;">⧉</button></td>' +
      "<td>" + esc(p.value) +
        (p.resolved ? ' <span class="pill keep">resolved</span>' : "") + "</td>" +
      '<td class="muted">' + esc(p.cls) + "</td>" +
      '<td class="k" title="' + esc(p.pkg) + '">' + esc(p.pkg) + "</td>" +
      // "used" reads as a count, and sorts as one: the × is decoration only
      '<td class="n" data-sort="' + p.placements + '">' + p.placements + "×</td>" +
      '<td class="n">' + (p.issueCount || "") + "</td>" +
      assignCell(p, r) + vendorCells(p, r) +
      // Sorting groups the parts that carry fields at all, which is the only
      // ordering a mixed cell can honestly offer.
      (chipCols.length
        ? '<td class="fields" data-sort="' + esc(chipSortKey(p, chipCols)) + '">' + chips + "</td>"
        : "") +
      (hasDescription
        ? '<td class="bom" title="' + esc(p.fields["Description"] || "") +
          '"><span class="clip">' + esc(p.fields["Description"] || "") + "</span></td>"
        : "") +
      // Sorts by the first reference, so the table can be grouped by sheet
      '<td class="r" data-sort="' + esc(p.refs[0] || "") + '">' +
      '<button type="button" class="reftoggle"><span class="caret">▸</span>' +
      p.refs.length + " refs</button>" +
      '<span class="reflist" title="click to copy" data-copy="' + esc(p.refs.join(" ")) + '">' +
      esc(p.refs.join(", ")) + "</span></td></tr>";
  }).join("");

  var labels = ["key", "value", "class", "package", "used", "issues"]
    .concat(["bought as", "vendor", "vendor part number"])
    .concat(chipCols.length ? ["bom fields"] : [])
    .concat(hasDescription ? ["description"] : [])
    .concat(["references"]);

  var anyOpen = Object.keys(partsOpen).length > 0;
  return '<div class="toolbar">' +
    '<input type="search" id="filter" ' +
    'placeholder="filter by value, package, field, MPN, vendor or reference…">' +
    '<button type="button" id="allrefs" class="linkish">' +
    (anyOpen ? "collapse" : "expand") + " all references</button>" +
    '<span class="grow muted">' + d.counts.assigned + " of " + d.parts.length +
    " have a part number · " + withVendor + " have a vendor</span></div>" +
    // A row of its own for the controls that write files, schematic included.
    '<div class="toolbar">' +
    '<span class="muted">schematic</span>' +
    '<button type="button" id="adoptread" class="sync">read MPNs and vendors ←</button>' +
    '<button type="button" id="fieldswrite" class="sync">→ write them onto the symbols</button>' +
    '<label class="grow boards">boards ' +
    '<input type="number" id="boards" min="1" step="1" value="' + buyBoards + '"></label>' +
    '<button type="button" id="export">export CSVs</button></div>' +
    '<div id="syncpanel"></div>' +
    '<div class="tablewrap"><table id="tbl-parts"><thead><tr>' + head(labels) +
    "</tr></thead><tbody>" + rows + "</tbody></table></div>" +
    vendorList(vendors) +
    '<div id="exports"></div>';
}

/**
 * What the vendor box offers: the vendors this board already buys from.
 *
 * A native datalist, so it costs no script and behaves the way the browser's
 * own completion does — it suggests, it does not restrict, because the first
 * time you buy from someone the list cannot contain them yet.
 *
 * Spellings are not folded together. "digikey" and "DigiKey" are two entries
 * because they are two entries in the catalog, and a list that quietly showed
 * one would hide the drift this tool exists to make visible.
 */
function vendorList(vendors) {
  return '<datalist id="vendors">' +
    Object.keys(vendors).sort().map(function (v) {
      return '<option value="' + esc(v) + '"></option>';
    }).join("") + "</datalist>";
}

/** Field names first, so a click groups the parts that share one. */
function chipSortKey(p, names) {
  return names.filter(function (n) { return p.fields[n]; })
    .map(function (n) { return n + " " + p.fields[n]; }).join(" ");
}

function render() {
  if (!data) return;
  document.getElementById("path").textContent = data.project;
  renderStats(data);
  document.getElementById("tabs").innerHTML = TABS.map(function (t) {
    return '<button aria-selected="' + (t.id === active) + '" data-tab="' + t.id + '">' +
      t.label + "</button>";
  }).join("");
  var view = document.getElementById("view");
  // Taken before the view is replaced, and put back after: a render that lands
  // while you are typing must not move the caret out from under you.
  var caret = focusedBox();
  document.querySelector("main").className =
    active === "parts" || active === "footprints" ? "wide" : "";
  if (active !== "footprints") fpClearView();
  view.innerHTML = active === "findings" ? renderFindings(data)
    : active === "issues" ? renderIssues(data)
    : active === "footprints" ? renderFootprints(data)
    : active === "excluded" ? renderExcluded(data)
    : renderParts(data);
  if (active === "footprints") fpRestore();
  if (active === "parts") {
    paintExports();
    paintExportButton();
    paintSync();
    if (!exportsInfo) loadExports();
  }
  paintRewrite();
  paintDirty();
  restoreSorts();
  restoreFocus(caret);
}

/**
 * Every write goes through here.
 *
 * The x-kinv header is what the server checks: any page anywhere can make a
 * simple cross-origin POST, but it cannot set a custom header without a
 * preflight the server refuses. These endpoints edit files on disk, so that
 * matters more than it would for a read.
 */
async function post(path, body) {
  var res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-kinv": "1" },
    body: JSON.stringify(body || {}),
  });
  var data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

/** Paints the open panel into its card, if that card is on screen. */
function paintRewrite() {
  if (!rewriteOpen) return;
  var card = document.querySelector('[data-finding="' + rewriteOpen.id + '"]');
  var slot = card && card.querySelector(".rewrite");
  if (!slot) return;
  slot.innerHTML = rewriteOpen.html;
  // A spelling can contain a quote, so the button is found by comparing the
  // value rather than by building an attribute selector out of it.
  var buttons = card.querySelectorAll(".usethis");
  for (var i = 0; i < buttons.length; i++) {
    buttons[i].classList.toggle("open", buttons[i].dataset.to === rewriteOpen.to);
  }
}

/** Paints the open sync panel, if the parts tab is on screen. */
function paintSync() {
  var host = document.getElementById("syncpanel");
  if (!host) return;
  host.innerHTML = syncOpen ? syncOpen.html : "";
  var buttons = document.querySelectorAll(".sync");
  for (var i = 0; i < buttons.length; i++) {
    buttons[i].classList.toggle("open", !!syncOpen && buttons[i].id === syncOpen.id);
  }
}

function setSync(state) {
  syncOpen = state;
  paintSync();
}

/**
 * What writing the fields onto the symbols would change.
 *
 * The same shape the spelling rewrite uses, because it is the same act: a plan
 * you read, then a second click that writes. The guards are the writer's own —
 * KiCad holding the file open, and a working tree with changes already in it.
 */
function fieldsPanel(plan) {
  if (plan.locked && plan.locked.length) {
    return '<div class="panel warn"><b>KiCad has this project open.</b> Close the schematic ' +
      "editor first — saving from KiCad would overwrite the edit.</div>";
  }
  if (plan.dirty && plan.dirty.length) {
    return '<div class="panel warn"><b>Uncommitted changes in ' +
      esc(plan.dirty.map(function (f) { return baseName(f); }).join(", ")) +
      ".</b> Commit or stash first, so this edit is the only thing in the diff.</div>";
  }
  if (!plan.edits.length) {
    return '<div class="panel ok"><div class="phead">Nothing to write: every symbol already ' +
      "carries what the catalog knows.</div>" +
      '<div class="pactions"><button type="button" class="cancel linkish">close</button></div></div>';
  }

  var byFile = {};
  var files = [];
  plan.edits.forEach(function (e) {
    if (!byFile[e.file]) { byFile[e.file] = []; files.push(e.file); }
    byFile[e.file].push(e);
  });

  // A board writes hundreds of fields; the panel is a sample plus a count, not
  // a transcript nobody reads to the end.
  var shown = 0;
  var body = files.map(function (file) {
    var rows = byFile[file].filter(function () { return shown++ < 12; });
    if (!rows.length) return "";
    return '<div class="pfile">' + esc(baseName(file)) + "</div>" +
      rows.map(function (e) {
        return '<div class="pedit"><span class="key">' + esc(e.ref) + "</span>" +
          '<span class="muted">' + esc(e.field) + (e.from === undefined || e.from === ""
            ? " +</span>"
            : ' "' + esc(e.from) + '" →</span>') +
          '<span class="key">"' + esc(e.to) + '"</span></div>';
      }).join("");
  }).join("");
  if (plan.edits.length > 12) {
    body += '<div class="pskip">…and ' + (plan.edits.length - 12) + " more</div>";
  }

  var symbols = {};
  plan.edits.forEach(function (e) { symbols[e.file + "|" + e.uuid] = true; });
  var skipped = plan.skipped && plan.skipped.length
    ? '<div class="pskip">' + plan.skipped.length + " left alone: " +
      plan.skipped.slice(0, 4).map(function (x) {
        return esc(x.ref) + " (" + esc(x.reason) + ")";
      }).join(", ") + (plan.skipped.length > 4 ? " …" : "") + "</div>"
    : "";

  return '<div class="panel"><div class="phead">' + plan.edits.length + " field" +
    (plan.edits.length === 1 ? "" : "s") + " on " + Object.keys(symbols).length + " symbol" +
    (Object.keys(symbols).length === 1 ? "" : "s") + " in " + files.length + " file" +
    (files.length === 1 ? "" : "s") + " · a .bak is written first</div>" +
    body + skipped +
    '<div class="pactions"><button type="button" class="fieldsapply">write to the schematic</button>' +
    '<button type="button" class="cancel linkish">cancel</button></div></div>';
}

/**
 * What reading the symbols' own fields would add to the catalog.
 *
 * Three outcomes worth showing and one worth counting: a part the catalog does
 * not have, detail it is missing, and a part number the two disagree about —
 * which is never settled here, because only you know which of the two moved on.
 */
function adoptPanel(plan) {
  var take = plan.entries.filter(function (e) { return e.status === "new"; });
  var fill = plan.entries.filter(function (e) { return e.status === "fills"; });
  var clash = plan.entries.filter(function (e) { return e.status === "conflict"; });
  var agreed = plan.entries.length - take.length - fill.length - clash.length;

  if (!plan.entries.length) {
    return '<div class="panel"><div class="phead">No symbol on this board carries an MPN field ' +
      "yet — there is nothing to read back. Write them first.</div>" +
      '<div class="pactions"><button type="button" class="cancel linkish">close</button></div></div>';
  }

  var line = function (e, what) {
    return '<div class="pedit"><span class="key">' + esc(e.key) + "</span>" +
      '<span class="muted">' + what + "</span></div>";
  };
  var body =
    take.slice(0, 8).map(function (e) {
      return line(e, "adopt " + esc(e.mpn) +
        (Object.keys(e.fills).length ? " · " + esc(Object.keys(e.fills).join(", ")) : ""));
    }).join("") +
    fill.slice(0, 8).map(function (e) {
      return line(e, "fill in " + esc(Object.keys(e.fills).join(", ")) + " for " + esc(e.mpn));
    }).join("");

  var kept = [];
  plan.entries.forEach(function (e) {
    e.disagrees.forEach(function (d) {
      if (d.field === "MPN") return;
      kept.push(esc(e.key) + " " + esc(d.field) + ': keeping "' + esc(d.catalog) +
        '", schematic says "' + esc(d.schematic) + '"');
    });
  });

  var notes = "";
  if (clash.length) {
    notes += '<div class="pskip alsoaffects">' + clash.length + " part" +
      (clash.length === 1 ? " names a" : "s name") + " different part number than the catalog, " +
      "and is left alone: " +
      clash.slice(0, 3).map(function (e) {
        return esc(e.key) + " (" + esc(e.mpn) + " vs " + esc(e.disagrees[0].catalog) + ")";
      }).join(", ") + (clash.length > 3 ? " …" : "") + "</div>";
  }
  if (kept.length) {
    notes += '<div class="pskip">' + kept.length + " field" + (kept.length === 1 ? "" : "s") +
      " the catalog keeps: " + kept.slice(0, 3).join(" · ") + (kept.length > 3 ? " …" : "") +
      "</div>";
  }
  if (agreed) notes += '<div class="pskip">' + agreed + " already agree</div>";
  if (plan.silent) {
    notes += '<div class="pskip">' + plan.silent + " part" + (plan.silent === 1 ? "" : "s") +
      " carry no MPN field</div>";
  }

  var takeable = take.length + fill.length;
  return '<div class="panel"><div class="phead">' +
    (takeable
      ? takeable + " part" + (takeable === 1 ? "" : "s") +
        " to take from the schematic · nothing you typed is overwritten"
      : "Nothing to take: the catalog already has everything the symbols say") +
    "</div>" + body + notes +
    '<div class="pactions">' +
    (takeable ? '<button type="button" class="adoptapply">read into the catalog</button>' : "") +
    '<button type="button" class="cancel linkish">close</button></div></div>';
}

function setRewrite(state) {
  var previous = rewriteOpen;
  rewriteOpen = state;
  if (previous && (!state || state.id !== previous.id)) {
    var old = document.querySelector('[data-finding="' + previous.id + '"] .rewrite');
    if (old) old.innerHTML = "";
  }
  paintRewrite();
}

/**
 * Last path segment, on either separator.
 *
 * Written without a backslash escape on purpose: this whole script sits in a
 * template literal, where TypeScript eats the escape before the browser sees
 * it, and a half-eaten character class silently stops matching Windows paths.
 */
function baseName(p) {
  var parts = String(p).split("/");
  return parts[parts.length - 1].split(String.fromCharCode(92)).pop();
}

/** The panel under a spelling card: what will change, and the button to do it. */
function rewritePanel(plan, to, groups) {
  if (plan.locked.length) {
    return '<div class="panel warn"><b>KiCad has this project open.</b> Close the schematic ' +
      "editor first — saving there would overwrite the edit and say nothing. (" +
      plan.locked.map(function (l) { return esc(baseName(l)); }).join(", ") + ")</div>";
  }
  if (!plan.edits.length) {
    return '<div class="panel">Nothing to change' +
      (plan.skipped.length ? ": " + esc(plan.skipped[0].reason) : ".") + "</div>";
  }

  var byFile = {};
  plan.edits.forEach(function (e) { (byFile[e.file] = byFile[e.file] || []).push(e); });
  var files = Object.keys(byFile).sort();

  var body = files.map(function (file) {
    return '<div class="pfile">' + esc(baseName(file)) + "</div>" +
      byFile[file].map(function (e) {
        return '<div class="pedit"><span class="key">' + esc(e.ref) + "</span>" +
          '<span class="muted">"' + esc(e.from) + '" → </span><span class="key">"' +
          esc(e.to) + '"</span>' +
          (e.alsoAffects.length
            ? '<span class="alsoaffects">also ' + esc(e.alsoAffects.join(", ")) +
              " — one symbol, several placements</span>"
            : "") + "</div>";
      }).join("");
  }).join("");

  var skipped = plan.skipped.length
    ? '<div class="pskip">' + plan.skipped.length + " left alone: " +
      plan.skipped.slice(0, 4).map(function (s) {
        return esc(s.ref) + " (" + esc(s.reason) + ")";
      }).join(", ") + (plan.skipped.length > 4 ? " …" : "") + "</div>"
    : "";

  return '<div class="panel"><div class="phead">' + plan.edits.length + " symbol" +
    (plan.edits.length === 1 ? "" : "s") + " in " + files.length + " file" +
    (files.length === 1 ? "" : "s") + " will change · a .bak is written first</div>" +
    body + skipped +
    '<div class="pactions"><button type="button" class="apply" data-to="' + esc(to) +
    '" data-groups="' + esc(JSON.stringify(groups)) + '">apply</button>' +
    '<button type="button" class="cancel linkish">cancel</button></div></div>';
}

document.addEventListener("click", function (e) {
  var tab = e.target.closest("[data-tab]");
  if (tab) { active = tab.dataset.tab; render(); return; }

  // The two directions of "is this a part you buy at all". Both write one
  // line to .kinv/buy.json and nothing else; neither is a decision the tool
  // cannot take back, which is why neither asks first.
  var nobuy = e.target.closest(".nobuy");
  if (nobuy) {
    var nobuyKey = nobuy.closest("tr").dataset.key;
    post("/api/buy", { key: nobuyKey, buy: false })
      .then(function () { toast(nobuyKey + " → not bought"); return poll(); })
      .catch(function (err) { toast(err.message); });
    return;
  }

  var buyit = e.target.closest(".buythis");
  if (buyit) {
    var buyKey = buyit.dataset.key;
    post("/api/buy", { key: buyKey, buy: true })
      .then(function () { toast(buyKey + " → parts list"); return poll(); })
      .catch(function (err) { toast(err.message); });
    return;
  }

  var solve = e.target.closest(".solve");
  if (solve) {
    post("/api/solved", {
      id: solve.dataset.id,
      signature: solve.dataset.signature,
      solved: solve.dataset.solved === "true",
    }).then(poll).catch(function (err) { toast(err.message); });
    return;
  }

  if (e.target.id === "resetsolved") {
    post("/api/solved/reset").then(poll).catch(function (err) { toast(err.message); });
    return;
  }

  var use = e.target.closest(".usethis");
  if (use) {
    var id = use.closest(".card").dataset.finding;
    var to = use.dataset.to;
    // the same button again closes it, which is how a disclosure behaves
    if (rewriteOpen && rewriteOpen.id === id && rewriteOpen.to === to) { setRewrite(null); return; }

    var groups = JSON.parse(use.dataset.groups);
    setRewrite({ id: id, to: to, html: '<div class="panel">reading the schematics…</div>' });
    post("/api/rewrite/plan", { to: to, groups: groups })
      .then(function (plan) { setRewrite({ id: id, to: to, html: rewritePanel(plan, to, groups) }); })
      .catch(function (err) {
        setRewrite({ id: id, to: to, html: '<div class="panel warn">' + esc(err.message) + "</div>" });
      });
    return;
  }

  var apply = e.target.closest(".apply");
  if (apply) {
    var applyId = apply.closest(".card").dataset.finding;
    var applyTo = apply.dataset.to;
    apply.disabled = true;
    post("/api/rewrite/apply", {
      to: applyTo,
      groups: JSON.parse(apply.dataset.groups),
    }).then(function (result) {
      setRewrite({ id: applyId, to: applyTo, html: '<div class="panel ok">' +
        result.symbolsChanged + " symbol" + (result.symbolsChanged === 1 ? "" : "s") +
        " rewritten · backup" + (result.backups.length === 1 ? "" : "s") + ": " +
        esc(result.backups.map(function (b) { return baseName(b); }).join(", ")) + "</div>" });
      // The card is about to go: the finding is fixed, and the next poll
      // re-exports the BOM without it. The toast outlives that.
      toast("rewrote " + result.symbolsChanged + " symbol" +
        (result.symbolsChanged === 1 ? "" : "s") + " · .bak written");
      poll();
    }).catch(function (err) {
      setRewrite({ id: applyId, to: applyTo,
        html: '<div class="panel warn">' + esc(err.message) + "</div>" });
    });
    return;
  }

  if (e.target.closest(".cancel")) {
    if (e.target.closest("#syncpanel")) { setSync(null); return; }
    if (e.target.closest("#exports")) { loadExports(); return; }
    setRewrite(null);
    return;
  }

  // Out to the schematic: what the catalog knows, onto the symbols.
  if (e.target.id === "fieldswrite") {
    if (syncOpen && syncOpen.id === "fieldswrite") { setSync(null); return; }
    setSync({ id: "fieldswrite", html: '<div class="panel">reading the schematics…</div>' });
    post("/api/fields/plan", {})
      .then(function (plan) { setSync({ id: "fieldswrite", html: fieldsPanel(plan) }); })
      .catch(function (err) {
        setSync({ id: "fieldswrite", html: '<div class="panel warn">' + esc(err.message) + "</div>" });
      });
    return;
  }

  if (e.target.closest(".fieldsapply")) {
    e.target.disabled = true;
    post("/api/fields/apply", {})
      .then(function (result) {
        setSync({ id: "fieldswrite", html: '<div class="panel ok">' + result.symbolsChanged +
          " symbol" + (result.symbolsChanged === 1 ? "" : "s") + " written · backup" +
          (result.backups.length === 1 ? "" : "s") + ": " +
          esc(result.backups.map(function (b) { return baseName(b); }).join(", ")) + "</div>" });
        toast("wrote " + result.symbolsChanged + " symbol" +
          (result.symbolsChanged === 1 ? "" : "s") + " · .bak written");
        poll();
      })
      .catch(function (err) {
        setSync({ id: "fieldswrite", html: '<div class="panel warn">' + esc(err.message) + "</div>" });
      });
    return;
  }

  // Back in from the schematic: what the symbols say, into the catalog.
  if (e.target.id === "adoptread") {
    if (syncOpen && syncOpen.id === "adoptread") { setSync(null); return; }
    setSync({ id: "adoptread", html: '<div class="panel">reading the schematics…</div>' });
    post("/api/adopt/plan", {})
      .then(function (plan) { setSync({ id: "adoptread", html: adoptPanel(plan) }); })
      .catch(function (err) {
        setSync({ id: "adoptread", html: '<div class="panel warn">' + esc(err.message) + "</div>" });
      });
    return;
  }

  if (e.target.closest(".adoptapply")) {
    e.target.disabled = true;
    post("/api/adopt/apply", {})
      .then(function (result) {
        setSync({ id: "adoptread", html: '<div class="panel ok">took ' + result.adopted +
          " part" + (result.adopted === 1 ? "" : "s") + " and filled in " + result.filled +
          (result.conflicts ? " · " + result.conflicts + " conflicts left for you" : "") +
          "</div>" });
        toast("read " + result.adopted + " part" + (result.adopted === 1 ? "" : "s") +
          " from the schematic");
        poll();
      })
      .catch(function (err) {
        setSync({ id: "adoptread", html: '<div class="panel warn">' + esc(err.message) + "</div>" });
      });
    return;
  }

  var edit = e.target.closest(".editassign");
  if (edit) { resolveOpen = edit.dataset.key; render(); return; }

  var save = e.target.closest(".assignform .save");
  if (save) {
    var form = save.closest(".assignform");
    saveAssignment(form);
    return;
  }

  var clear = e.target.closest(".clearassign");
  if (clear) {
    var key = clear.closest(".assignform").dataset.key;
    post("/api/assign/clear", { key: key })
      .then(function () { clearDrafts(key); resolveOpen = null; return poll(); })
      .catch(function (err) { toast(err.message); });
    return;
  }

  var savev = e.target.closest(".savevendor");
  if (savev) { saveVendor(savev.closest("tr")); return; }

  // Exporting asks where first. The dialog is the machine's own, opened by
  // the server on the desktop the browser is already sitting on, so it starts
  // where the last export went and can make a folder on the spot.
  if (e.target.id === "export") {
    exportBusy = true;
    paintExportButton();
    exportsInfo = {
      dir: exportsInfo ? exportsInfo.dir : "",
      files: exportsInfo ? exportsInfo.files : [],
      note: "a folder dialog is opening on your desktop — it takes a second or two",
    };
    paintExports();
    toast("look for the folder dialog on your desktop");

    post("/api/order/where", {})
      .then(function (choice) {
        exportBusy = false;
        paintExportButton();
        if (choice.status === "chosen") return writeOrders(choice.dir);
        if (choice.status === "busy") {
          loadExports();
          toast("a folder dialog is already open — answer or cancel that one");
          return;
        }
        if (choice.status === "unavailable") {
          // No dialog to open — say why, and take the path typed instead.
          exportsInfo = {
            dir: exportsInfo ? exportsInfo.dir : "",
            files: exportsInfo ? exportsInfo.files : [],
            ask: true,
            note: "no folder dialog on this machine (" + choice.reason + ") — type the path",
          };
          paintExports();
          return;
        }
        loadExports();
        toast("nothing written");
      })
      .catch(function (err) {
        exportBusy = false;
        paintExportButton();
        loadExports();
        toast(err.message);
      });
    return;
  }

  var pathwrite = e.target.closest(".pathwrite");
  if (pathwrite) {
    var box = document.querySelector("#exports .pathbox");
    pathwrite.disabled = true;
    writeOrders(box ? box.value.trim() : "").catch(function () { pathwrite.disabled = false; });
    return;
  }

  // Before the copy handler: the toggle sits inside the cell that copies.
  var toggle = e.target.closest(".reftoggle");
  if (toggle) {
    var row = toggle.closest("tr");
    var key = row.dataset.key;
    if (partsOpen[key]) delete partsOpen[key]; else partsOpen[key] = true;
    row.classList.toggle("open");
    var all = document.getElementById("allrefs");
    if (all) all.textContent = Object.keys(partsOpen).length ? "collapse all references" : "expand all references";
    return;
  }
  if (e.target.id === "allrefs") {
    var opening = Object.keys(partsOpen).length === 0;
    partsOpen = {};
    if (opening) data.parts.forEach(function (p) { partsOpen[p.key] = true; });
    render();
    return;
  }

  // The label, onto the clipboard and into a distributor's search box. Its
  // own handler rather than the reference-list one, because the toast has to
  // say what was copied — one string, not a count of designators.
  var copykey = e.target.closest("[data-copy-label]");
  if (copykey && navigator.clipboard) {
    var label = copykey.dataset.copyLabel;
    navigator.clipboard.writeText(label).then(function () { toast('copied "' + label + '"'); });
    return;
  }

  var copy = e.target.closest("[data-copy]");
  if (copy && navigator.clipboard) {
    navigator.clipboard.writeText(copy.dataset.copy).then(function () {
      toast("copied " + copy.dataset.copy.split(" ").length + " references");
    });
  }
});

function saveAssignment(form) {
  var mpn = form.querySelector(".mpn").value.trim();
  if (mpn === "") { toast("an assignment needs an MPN"); return; }
  post("/api/assign", {
    key: form.dataset.key,
    mpn: mpn,
    manufacturer: form.querySelector(".mfr").value.trim(),
  }).then(function () {
    clearDrafts(form.dataset.key);
    resolveOpen = null;
    toast("saved " + mpn);
    return poll();
  }).catch(function (err) { toast(err.message); });
}

/**
 * Files the vendor and their number for one row.
 *
 * Both cells go together because they are one decision — "I buy this from
 * them, and this is what they call it" — and a blank is a real answer: it
 * clears the field rather than being ignored.
 */
function saveVendor(row) {
  if (!row) return;
  var vend = row.querySelector(".vend");
  var vnum = row.querySelector(".vnum");
  if (!vend || !vnum) return;
  var key = row.dataset.key;
  var supplier = vend.value.trim();
  var number = vnum.value.trim();

  post("/api/supplier", { key: key, supplier: supplier, orderNumber: number })
    .then(function () {
      clearDrafts(key);
      vend.dataset.was = supplier;
      vnum.dataset.was = number;
      markDirty(vend);
      markDirty(vnum);
      toast(supplier ? key + " → " + supplier : "vendor cleared for " + key);
      return poll();
    })
    .catch(function (err) { toast(err.message); });
}

// Enter saves the row you are in: typing 87 part numbers with the mouse would
// be its own reason not to use the tool.
document.addEventListener("keydown", function (e) {
  if (e.key !== "Enter") return;
  if (!e.target.closest) return;
  var form = e.target.closest(".assignform");
  if (form) { e.preventDefault(); saveAssignment(form); return; }
  var vendorCell = e.target.closest("td.vendor");
  if (vendorCell) { e.preventDefault(); saveVendor(vendorCell.closest("tr")); }
});

document.addEventListener("input", function (e) {
  if (e.target.id === "boards") {
    var n = Math.floor(Number(e.target.value));
    buyBoards = n > 0 ? n : 1;
    return;
  }
  if (e.target.dataset && e.target.dataset.box) {
    var id = boxKey(e.target);
    if (id !== null) typed[id] = e.target.value;
    markDirty(e.target);
    return;
  }
  if (e.target.id !== "filter") return;
  var q = e.target.value.trim().toLowerCase();
  document.querySelectorAll("tbody tr").forEach(function (tr) {
    tr.style.display = !q || tr.dataset.search.indexOf(q) >= 0 ? "" : "none";
  });
});

function status(text, busy) {
  var el = document.getElementById("status");
  el.textContent = text;
  el.className = busy ? "status busy" : "status";
}

async function poll() {
  try {
    var res = await fetch("/api/report");
    if (!res.ok) throw new Error(await res.text());
    var next = await res.json();
    if (next.build && next.build !== BUILD) { location.reload(); return; }
    var changed = !data || next.generatedAt !== data.generatedAt;
    data = next;
    if (changed) { render(); status("updated " + new Date().toLocaleTimeString()); }
    else { status("watching " + data.project.split(/[\\\\/]/).pop()); }
  } catch (err) {
    status("error: " + err.message);
  }
}

poll();
setInterval(poll, 2000);
${sortScript}
${viewerScript}
</script>
</body>
</html>`;
