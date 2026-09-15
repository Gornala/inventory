/**
 * The TypeScript core's answers, for the Python port to reproduce exactly.
 *
 * Everything is written through JSON.stringify, and the Python side compares
 * its own stringify output as a *string*: key order, number formatting and
 * omitted undefineds all have to match, not just the values.
 *
 *   npx tsx scripts/golden/core.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";

import { readBomCsv } from "../../src/adapters/kicad/bom.js";
import { parseCsv } from "../../src/adapters/kicad/csv.js";
import { canonicalKey, displayValue, searchLabel } from "../../src/core/canonical.js";
import { compareColumns, consolidate, partsByKey } from "../../src/core/consolidate/findings.js";
import { findingId, findingSignature } from "../../src/core/consolidate/identity.js";
import { analyzeBom, analyzeLine } from "../../src/core/parse/spec.js";
import { classOfRef, expandRefs } from "../../src/core/parse/refdes.js";
import { packageOf, parseFootprint } from "../../src/core/parse/footprint.js";
import { parseValue } from "../../src/core/parse/value.js";
import { formatMagnitude } from "../../src/core/units.js";
import type { BomLine } from "../../src/core/types.js";

let seed = 915;
function rand(): number {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;

// --- boards -------------------------------------------------------------------

/** Each item as the exact text JSON.stringify gives it. */
const enc = (x: unknown): string => JSON.stringify(x);

function board(path: string) {
  const lines = analyzeBom(readBomCsv(path));
  return {
    lines: lines.map(enc),
    findings: consolidate(lines).map((f) =>
      enc({ finding: f, id: findingId(f), signature: findingSignature(f) }),
    ),
    parts: partsByKey(lines).map(enc),
  };
}

const boards = {
  reference: board("tests/fixtures/kicad10/transformer_test.bom.csv"),
  customFields: board("tests/fixtures/kicad10/custom-fields.bom.csv"),
};

// --- values, footprints, references -------------------------------------------

const values = [
  "10k",
  "10K",
  "5k6",
  "5K6",
  "4k7",
  "0R1",
  "4R7",
  "100n",
  "100nF",
  "100 nF",
  "0.1uF",
  "0.1µF",
  "0.1μF",
  "4u7",
  "4.7µ",
  "10Ω",
  "10Ω",
  "10 ohm",
  "10ohms",
  "1M",
  "1m",
  "2.2mH",
  "150uH",
  "22p",
  "22pF",
  "3n3",
  "1F",
  "10H",
  "TBD",
  "LED",
  "RP2040",
  "575-4",
  "",
  " ",
  "0",
  "00",
  "0.0",
  "100",
  "4",
  "1.5",
  "1e3",
  "IHLP6767GZER100M01",
  "R",
  "C",
  "10k 1%",
  "0402",
  "farad",
  "10farads",
  "2henries",
  "1G",
  "1g",
  "5mm",
  "12V",
  "10k/0402",
  "4.7u/16V",
];
const prefixes = [
  "",
  "0.",
  "1",
  "4.7",
  "10",
  "22",
  "33",
  "47",
  "68",
  "100",
  "220",
  "470",
  "999",
  "1000",
];
const letters = ["", "p", "n", "u", "µ", "m", "k", "K", "M", "G", "R", "r", "F", "H", "x"];
for (let i = 0; i < 600; i++)
  values.push(
    `${pick(prefixes)}${pick(letters)}${rand() < 0.3 ? pick(["F", "H", "Ω", " ohm", "nF"]) : ""}`,
  );

const footprints = [
  "Capacitor_SMD:C_0603_1608Metric",
  "Capacitor_SMD:C_1210_3225Metric_Pad1.33x2.70mm_HandSolder",
  "Resistor_SMD:R_0402_1005Metric",
  "Inductor_SMD:L_0805_2012Metric",
  "LED_SMD:LED_0603_1608Metric",
  "Package_DFN_QFN:QFN-56-1EP_7x7mm_P0.4mm_EP3.2x3.2mm",
  "Package_TO_SOT_SMD:SOT-23-6",
  "Connector_USB:USB_C_Receptacle",
  "TestPoint:TestPoint_Pad_1.0x1.0mm",
  "MountingHole:MountingHole_2.2mm",
  "Mounting_Wuerth:Mounting_Wuerth_WA-SMSI",
  "R_0603_1608Metric",
  "C_0402_1005Metric",
  "",
  "  ",
  "MyLib:Custom_Thing",
  "Crystal:Crystal_SMD_2520",
  "Diode_SMD:D_SMA",
  "Ferrite:FB_0603_1608Metric",
  "Button_Switch_SMD:SW_Push",
  "Fuse:Fuse_1206_3216Metric",
  "Relay_THT:Relay_SPDT",
];
const refs = [
  "R1",
  "C12",
  "L3",
  "FB1",
  "TH1",
  "U1",
  "Q2",
  "D5",
  "LED1",
  "J1",
  "TP3",
  "H1",
  "MH2",
  "Y1",
  "SW1",
  "F1",
  "K1",
  "LCD1",
  "BT1",
  "ANT1",
  "LS1",
  "MOD1",
  "X1",
  "LEDR1",
  "REG3",
  "r5",
  "",
  "?",
  "R",
];
const refCells = [
  "R1,R2,R3",
  "C6001-C6004",
  "C1001,C2004,C6001-C6004",
  "R10-R8",
  "R1-C3",
  "R1-",
  "-R1",
  "A1-A3",
  " R1 , R2 ",
  "R1,,R2",
  "",
  "TP1-TP2",
];

const parsed = {
  values: values.map((v) => enc({ v, parsed: parseValue(v) })),
  footprints: footprints.map((f) => {
    const fp = parseFootprint(f);
    return enc({ f, fp, pkg: packageOf(fp) });
  }),
  refs: refs.map((r) => enc({ r, cls: classOfRef(r) })),
  refCells: refCells.map((c) => enc({ c, refs: expandRefs(c) })),
};

// --- synthetic lines: every class × many values × many footprints --------------

const synthetic: unknown[] = [];
for (let i = 0; i < 1500; i++) {
  const ref = pick(refs);
  const quantityRefs = rand() < 0.1 ? [ref, pick(refs)] : [ref];
  const line: BomLine = {
    refs: quantityRefs,
    value: pick(values),
    footprint: pick(footprints),
    datasheet: undefined,
    description: undefined,
    quantity: rand() < 0.05 ? 3 : quantityRefs.length,
    dnp: false,
    fields: rand() < 0.1 ? { MPN: pick(["", "RC0402FR", "  "]) } : {},
    source: "synthetic",
  };
  const analyzed = analyzeLine(line);
  const spec = analyzed.spec;
  synthetic.push(
    enc({
      line,
      analyzed,
      label: searchLabel(spec),
      display: displayValue(spec),
      key: canonicalKey(spec),
    }),
  );
}

// --- magnitudes -----------------------------------------------------------------

const magnitudes: string[] = [];
for (const m of [
  0, 1, -1, 1e-13, 1e-12, 999.9999e-12, 1e10, 4.7e-6, 5.6e3, 49.9e3, 0.1, 10e-3, 1e-3, 123456789,
]) {
  magnitudes.push(enc([m, formatMagnitude(m)]));
}
for (let i = 0; i < 2000; i++) {
  const m = (rand() < 0.1 ? -1 : 1) * rand() * 10 ** Math.floor(rand() * 26 - 14);
  magnitudes.push(enc([m, formatMagnitude(m)]));
}

const columns = [
  "MPN",
  "Description",
  "Datasheet",
  "mpn",
  "Manufacturer",
  "supplier",
  "Supplier",
  "Voltage",
  "a",
  "A",
  "_x",
];
const sortedColumns = [...columns].sort(compareColumns);

const csvInputs = [
  "a,b\r\n1,2\r\n",
  'a,b\n"x,y",2\n',
  '﻿a,b\n1,"he said ""hi"""\n',
  "a\n\n\nb\n",
  "a,b",
  '"a\r\nb",c\r\n',
  'a,"b"c,d\n',
  "x,y\r",
  "",
  "\n",
];
const csv = csvInputs.map((input) => enc({ input, rows: parseCsv(input) }));

mkdirSync("pytests/golden", { recursive: true });
writeFileSync(
  "pytests/golden/core.json",
  JSON.stringify({ boards, parsed, synthetic, magnitudes, columns, sortedColumns, csv }),
  "utf8",
);
console.log("pytests/golden/core.json written");
