// Cases for kinv/js.py, answered by JavaScript itself.
//
//   npx tsx scripts/golden/js.ts
//
// The Python emulation of String(number), toFixed, toPrecision, Math.round and
// localeCompare is only as good as the cases it is checked against, so the
// cases are many, seeded, and include the ties and edges where the two
// languages actually disagree.
import { mkdirSync, writeFileSync } from "node:fs";

let seed = 20260915;
function rand(): number {
  // mulberry32: small, seeded, the same sequence on every machine
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;

const numbers: number[] = [
  0,
  1,
  -1,
  0.1,
  0.2,
  0.1 + 0.2,
  4.7,
  4.700000000000001,
  5.62e3,
  100,
  1e21,
  1e-7,
  1.5e-7,
  0.000001,
  0.0000015,
  123456789012345680000,
  2.5,
  1.005,
  0.125,
  1.45,
  -2.5,
  -0.5,
  0.5,
  1234565,
  4.35,
  22e-12,
  100e-9,
  150e-6,
  5e-3,
  1e6,
  999999.5,
  0.49999999999999994,
];
for (let i = 0; i < 1500; i++) {
  const magnitude = 10 ** Math.floor(rand() * 34 - 12);
  const sign = rand() < 0.15 ? -1 : 1;
  const x =
    rand() < 0.3
      ? Math.round(rand() * 2000) / pick([1, 2, 4, 8, 10, 100, 1000])
      : rand() * magnitude;
  numbers.push(sign * x);
}

const numStr = numbers.map((x) => [x, String(x)] as const);
const toFixed: [number, number, string][] = [];
const toPrecision: [number, number, number][] = [];
const round: [number, number][] = [];
for (const x of numbers) {
  if (Math.abs(x) < 1e21) for (const d of [0, 1, 2, 3, 6]) toFixed.push([x, d, x.toFixed(d)]);
  if (x !== 0) for (const p of [1, 3, 6, 10]) toPrecision.push([x, p, Number(x.toPrecision(p))]);
  round.push([x, Math.round(x)]);
}

const alphabet = "RCLUDQJ|0123456789kKnNuUpPmM._- abcABCxyzXYZ";
const words: string[] = [
  "R|10k|0402",
  "R|1k|0402",
  "C|100n|0603",
  "C|10u|0805",
  "digikey",
  "DigiKey",
  "lcsc",
  "mouser",
  "R2",
  "R10",
  "R100",
  "0402",
  "0603",
  "1206",
  "a-b",
  "a_b",
  "x.y",
  "x-y",
  "U|RP2040|QFN-56",
  "FB|600|0603",
  "Resistor_SMD",
  "resistor_smd",
  "10.0",
  "9.0",
  "10.0.1",
  "",
  "a",
  "A",
  "aa",
  "Aa",
];
for (let i = 0; i < 1500; i++) {
  let w = "";
  const n = 1 + Math.floor(rand() * 9);
  for (let j = 0; j < n; j++) w += pick([...alphabet]);
  words.push(w);
}
const compare: [string, string, number, number, number][] = [];
for (let i = 0; i < 4000; i++) {
  const a = pick(words);
  const b = rand() < 0.2 ? a.toUpperCase() : pick(words);
  compare.push([
    a,
    b,
    Math.sign(a.localeCompare(b)),
    Math.sign(a.localeCompare(b, "en", { sensitivity: "base" })),
    Math.sign(a.localeCompare(b, "en", { numeric: true })),
  ]);
}

mkdirSync("pytests/golden", { recursive: true });
writeFileSync(
  "pytests/golden/js.json",
  JSON.stringify({ numStr, toFixed, toPrecision, round, compare }),
  "utf8",
);
console.log(
  `numStr ${numStr.length}, toFixed ${toFixed.length}, toPrecision ${toPrecision.length}, ` +
    `round ${round.length}, compare ${compare.length}`,
);
