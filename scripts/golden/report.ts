/**
 * The TypeScript report, footprint measurement and catalog writes, for the
 * Python port to reproduce as exact text.
 *
 *   npx tsx scripts/golden/report.ts
 *
 * The report is built twice over the reference board: once with nothing
 * decided, and once with a catalog, settled findings, buy choices and a
 * package mismatch — the state lives in pytests/fixtures/state, written here
 * deterministically, so both versions read the very same files.
 */
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve("pytests/fixtures/state");
rmSync(root, { recursive: true, force: true });
mkdirSync(join(root, "home"), { recursive: true });
process.env["KINV_HOME"] = join(root, "home");

// imported after KINV_HOME is set, though the store reads it on every call anyway
const { buildReport, footprintDetail } = await import("../../src/report.js");
const { parseFootprintFile } = await import("../../src/adapters/kicad/mod.js");
const { measure } = await import("../../src/core/footprint/measure.js");
const { parseFootprintName } = await import("../../src/core/footprint/name.js");
const { checkFootprint, checkPinNumbers } = await import("../../src/core/footprint/check.js");
const { readAssignments, readCatalog, writeAssignments, writeCatalog } =
  await import("../../src/adapters/store/inventory.js");
const { writeSolved } = await import("../../src/adapters/store/solved.js");
const { writeBuyChoices } = await import("../../src/adapters/store/buy.js");
const { assignPart, setSupplier, partId } = await import("../../src/core/inventory/resolve.js");
const { normalisePackage } = await import("../../src/core/inventory/package-check.js");

const enc = (x: unknown): string => JSON.stringify(x);
/**
 * The report minus what is about *when* and *where*, not *what*: the build
 * time, the file-time signature, and the absolute project path — which names
 * this machine's user directory and has no business in a public repository.
 */
const without = (value: object, drop: readonly string[]): Record<string, unknown> =>
  Object.fromEntries(Object.entries(value).filter(([k]) => !drop.includes(k)));
const reportText = (r: object): string =>
  enc(without(r, ["generatedAt", "sourceSignature", "project"]));

// --- an empty inventory ---------------------------------------------------------

const empty = join(root, "empty");
mkdirSync(empty, { recursive: true });
copyFileSync("tests/fixtures/kicad10/transformer_test.bom.csv", join(empty, "board.bom.csv"));
const emptyReport = reportText(await buildReport(join(empty, "board.bom.csv")));

// --- a board with decisions on it ------------------------------------------------

const decided = join(root, "decided");
mkdirSync(decided, { recursive: true });
copyFileSync("tests/fixtures/kicad10/transformer_test.bom.csv", join(decided, "board.bom.csv"));
const project = join(decided, "board.bom.csv");

let clock = 0;
const now = (): string => new Date(Date.UTC(2026, 8, 15, 12, 0, clock++)).toISOString();

let catalog = readCatalog();
let assignments = readAssignments();
const steps: string[] = [];
const assign = (key: string, entry: Record<string, string>): void => {
  const result = assignPart(key, entry as never, catalog, assignments, now);
  catalog = result.catalog;
  assignments = result.assignments;
  steps.push(enc(result));
};
assign("C|100n|0603", { mpn: "CL10B104KB8NNNC", manufacturer: "Samsung" });
assign("R|10k|0402", { mpn: " RC0402FR-0710KL ", manufacturer: "", package: "0603" }); // wrong size on purpose
assign("C|10u|0805", {
  mpn: "CL21A106KAYNNNE",
  supplier: "digikey",
  orderNumber: "1276-2891-1-ND",
});
assign("R|1k|0402", { mpn: "rc0402fr-0710kl", manufacturer: "Yageo", datasheet: "https://x" }); // same part id
assign("C|2.2u|0603", { mpn: "GRM188R61E225KA12D", notes: "  low ESR  ", package: "1608Metric" });
const supplied = setSupplier(
  "C|100n|0603",
  { supplier: "lcsc", orderNumber: "C1591" },
  catalog,
  assignments,
);
catalog = supplied.catalog;
steps.push(enc(supplied));
const cleared = setSupplier("C|10u|0805", { supplier: "", orderNumber: " " }, catalog, assignments);
catalog = cleared.catalog;
steps.push(enc(cleared));
writeCatalog(catalog);
writeAssignments(assignments);

writeSolved(project, [
  { id: "singleton:R|1|0805", signature: "R2005", at: "2026-09-15T12:00:00.000Z" },
  { id: "multi-package:resistor:0ohm", signature: "stale × 1", at: "2026-09-15T12:00:01.000Z" },
]);
writeBuyChoices(project, [
  { key: "R|4|0805", buy: false, at: "2026-09-15T12:00:02.000Z" },
  { key: "TP|TestPoint|TestPoint_Pad_1.0x1.0mm", buy: true, at: "2026-09-15T12:00:03.000Z" },
]);
const decidedReport = reportText(await buildReport(project));

// --- footprints ----------------------------------------------------------------

const fixtureDir = "tests/fixtures/kicad10/footprints";
const footprints = readdirSync(fixtureDir)
  .filter((f) => f.endsWith(".kicad_mod"))
  .sort()
  .map((f) => {
    const file = parseFootprintFile(readFileSync(join(fixtureDir, f), "utf8"));
    const measured = measure(file.pads);
    const declared = parseFootprintName(file.name);
    return enc({ f, file, measured, declared, findings: checkFootprint(declared, measured) });
  });
// every footprint the reference board's report could reach, from the real libraries
const audited = (JSON.parse(emptyReport) as { footprints: { reference: string }[] }).footprints;
const detail: string[] = audited
  .map((a) => a.reference)
  .map((reference) => {
    const found = footprintDetail(empty + "/board.bom.csv", reference);
    if (found === undefined) return enc(null);
    // `path` is where the library sits on this machine — for a personal
    // library, inside the user's own documents. Everything else is compared.
    return enc(without(found, ["path"]));
  });

const pinChecks = [
  [
    ["1", "2", "3"],
    ["1", "2", "3"],
  ],
  [
    ["1", "2", "3", "EP"],
    ["1", "2", "3"],
  ],
  [[], ["1"]],
  [["1", "1", "2"], []],
  [Array.from({ length: 12 }, (_, i) => String(i + 1)), ["1"]],
].map(([symbols, pads]) => enc(checkPinNumbers(symbols as string[], pads as string[])));

const packages = [
  "0603",
  " 0603 ",
  "1608",
  "1608Metric",
  "R0603",
  "FB0402",
  "C1005",
  "SOIC-8",
  "soic-8",
  "?",
  "n/a",
  "",
  "0201",
  "2012",
  "2013",
  "l3225metric",
  "QFN-56",
  "r 0402",
].map((p) => enc([p, normalisePackage(p)]));
const ids = ["RC0402FR-0710KL", " rc0402fr/0710kl ", "--A--", "µPart", "", "ab__cd"].map((m) =>
  enc([m, partId(m)]),
);

writeFileSync(
  "pytests/golden/report.json",
  JSON.stringify({
    emptyReport,
    decidedReport,
    steps,
    catalogFile: readFileSync(join(root, "home", "catalog.json"), "utf8"),
    assignmentsFile: readFileSync(join(root, "home", "assignments.json"), "utf8"),
    footprints,
    detail,
    pinChecks,
    packages,
    ids,
  }),
  "utf8",
);
console.log(
  `report goldens written; ${footprints.length} fixture footprints, ${detail.length} library footprints`,
);
