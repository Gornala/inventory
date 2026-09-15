import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join } from "node:path";

import { projectSheetsOrDirectory } from "./adapters/kicad/hierarchy.js";
import { libraryTable, resolveFootprint } from "./adapters/kicad/libraries.js";
import { inventorySignature, readAssignments, readCatalog } from "./adapters/store/inventory.js";
import { buySignature, readBuyChoices } from "./adapters/store/buy.js";
import { readSolved, solvedSignature } from "./adapters/store/solved.js";
import { readFootprintFile } from "./adapters/kicad/mod.js";
import {
  compareColumns,
  consolidate,
  partsByKey,
  type Finding,
  type PartRollup,
} from "./core/consolidate/findings.js";
import { findingId, findingSignature } from "./core/consolidate/identity.js";
import { auditFootprints, type FootprintAudit } from "./core/footprint/audit.js";
import { packageIssues } from "./core/inventory/package-check.js";
import { resolveParts } from "./core/inventory/resolve.js";
import type { Resolution } from "./core/inventory/types.js";
import { checkFootprint, type FootprintFinding } from "./core/footprint/check.js";
import { measure, type MeasuredPad, type Measurement } from "./core/footprint/measure.js";
import { parseFootprintName, type DeclaredFootprint } from "./core/footprint/name.js";
import { applyBuyChoices, applyMountability } from "./core/parse/spec.js";
import type { AnalyzedLine, Issue } from "./core/types.js";
import { loadProject } from "./cli/commands/check.js";

export type Report = {
  project: string;
  generatedAt: string;
  /** Fingerprint of the sources this was built from; the cache key. */
  sourceSignature: string;
  summary: { placements: number; lines: number; parts: number };
  counts: {
    errors: number;
    warnings: number;
    infos: number;
    findings: number;
    resolved: number;
    footprintFindings: number;
    excluded: number;
    settled: number;
    /** Parts with a catalog assignment: step 2's progress bar. */
    assigned: number;
  };
  /** Findings still open, each carrying the name a "solved" mark is filed under. */
  findings: OpenFinding[];
  /** Findings you have settled, kept so they can be reopened. */
  settled: OpenFinding[];
  issues: Issue[];
  parts: PartRollup[];
  /** What each part is bought as, so far. One entry per part, same order. */
  resolutions: Resolution[];
  /**
   * The BOM columns worth a column in the parts table: every field at least one
   * part actually carries. A field the export asked for and nobody filled in
   * would otherwise widen the table by a column of blanks.
   */
  partColumns: string[];
  footprints: FootprintAudit[];
  excluded: { key: string; value: string; footprint: string; reason: string; refs: string[] }[];
};

/**
 * A cheap fingerprint of the project's schematics, so kicad-cli only runs when
 * something actually changed.
 *
 * Modification time *and* total size, because a filesystem's mtime can be no
 * finer than a millisecond: saving a hierarchy writes every sheet at once, and
 * on a fast disk several of them can share a timestamp. Size catches the edit
 * that a timestamp alone would miss.
 */
export function sourceSignature(project: string): string {
  try {
    if (extname(project).toLowerCase() === ".csv") {
      const stat = statSync(project);
      return `${stat.mtimeMs}:${stat.size}`;
    }
    const dir = dirname(project);
    if (!existsSync(dir)) return "";

    // Only the sheets the design is made of. KiCad's own `_autosave-*.kicad_sch`
    // sits in the same directory and changes on a timer, which would re-export
    // the BOM for an edit nobody made.
    const sheets = projectSheetsOrDirectory(
      project,
      readdirSync(dir)
        .filter((name) => name.endsWith(".kicad_sch"))
        .map((name) => join(dir, name)),
    );

    let newest = 0;
    let bytes = 0;
    let files = 0;
    for (const path of sheets) {
      const stat = statSync(path);
      newest = Math.max(newest, stat.mtimeMs);
      bytes += stat.size;
      files += 1;
    }
    return files === 0 ? "" : `${newest}:${bytes}:${files}`;
  } catch {
    return "";
  }
}

/** A finding plus the identity the solved list files it under. */
export type OpenFinding = Finding & { id: string; signature: string; solvedAt?: string };

export type ReportOptions = {
  groupBy?: string;
  excludeDnp?: boolean;
  nearValuePercent?: number;
  includeExcluded?: boolean;
};

/**
 * Reads the board the way every command must read it.
 *
 * `kinv check` used to do its own `loadProject` and skip the geometry step
 * below, so it reported 81 parts where the UI reported 83 — the two Würth SMD
 * standoffs, which the class rule throws out as mounting holes and the copper
 * puts back. One reading, one answer.
 */
export async function analyzeProject(
  project: string,
  options: ReportOptions = {},
): Promise<{ lines: AnalyzedLine[]; footprints: FootprintAudit[] }> {
  const rawLines = await loadProject(project, {
    ...(options.groupBy !== undefined ? { groupBy: options.groupBy } : {}),
    ...(options.excludeDnp === true ? { excludeDnp: true } : {}),
    ...(options.includeExcluded === true ? { includeExcluded: true } : {}),
  });

  // Footprint libraries are read straight from disk; a library that has gone
  // missing must degrade to "cannot verify", never take the whole report down.
  let footprints: FootprintAudit[] = [];
  try {
    const table = libraryTable(project);
    footprints = auditFootprints(rawLines, (reference) => {
      const path = resolveFootprint(reference, table);
      return path === undefined ? undefined : readFootprintFile(path).pads;
    });
  } catch {
    footprints = [];
  }

  // Measure where you can, guess by name only where you cannot.
  //
  // Geometry is authoritative: a footprint with neither solder paste nor a
  // plated hole cannot be soldered to, and one that has either can. That
  // overrides the class-and-part-number guess in *both* directions — it drops
  // test pads no naming rule would catch, and it keeps a Würth SMD standoff
  // that the naming rule would have thrown away for want of an MPN. The guess
  // survives only for footprints that could not be found in any library.
  const mountability = new Map(
    footprints.filter((f) => !f.unresolved).map((f) => [f.reference, f.mountable]),
  );
  // And your own decisions last of all: the rules describe the usual board,
  // you are looking at this one. `--include-excluded` asks for everything the
  // board has, rules and decisions alike set aside.
  const choices = new Map(readBuyChoices(project).map((c) => [c.key, c.buy]));
  const lines =
    options.includeExcluded === true
      ? rawLines
      : applyBuyChoices(
          applyMountability(rawLines, (footprint) => mountability.get(footprint)),
          (key) => choices.get(key),
        );

  return { lines, footprints };
}

export async function buildReport(project: string, options: ReportOptions = {}): Promise<Report> {
  const signature = sourceSignature(project);
  const { lines, footprints } = await analyzeProject(project, options);

  const found = consolidate(lines, {
    ...(options.nearValuePercent !== undefined
      ? { nearValuePercent: options.nearValuePercent }
      : {}),
  });

  // A mark holds only while the finding still says what it said when it was
  // settled: "10k in 0402 and 0603" stays quiet, and speaks up again the day a
  // third package joins it.
  const marks = new Map(readSolved(project).map((m) => [m.id, m]));
  const identified: OpenFinding[] = found.map((f) => ({
    ...f,
    id: findingId(f),
    signature: findingSignature(f),
  }));
  const settled = identified.filter((f) => marks.get(f.id)?.signature === f.signature);
  const settledIds = new Set(settled.map((f) => f.id));
  const findings = identified.filter((f) => !settledIds.has(f.id));
  // The one check that needs the catalog: the schematic cannot say that you
  // went and bought 0603 resistors for an 0402 land pattern.
  const parts = partsByKey(lines);
  const resolutions = resolveParts(parts, readCatalog(), readAssignments());
  const issues = [...lines.flatMap((l) => l.issues), ...packageIssues(parts, resolutions)];

  return {
    project,
    generatedAt: new Date().toISOString(),
    sourceSignature: signature,
    summary: {
      // Placements and lines count what will be bought; the excluded ones are
      // reported separately rather than silently folded into the totals.
      placements: lines
        .filter((l) => l.excluded === undefined)
        .reduce((n, l) => n + l.line.refs.length, 0),
      lines: lines.filter((l) => l.excluded === undefined).length,
      parts: parts.length,
    },
    counts: {
      errors: issues.filter((i) => i.severity === "error").length,
      warnings: issues.filter((i) => i.severity === "warning").length,
      infos: issues.filter((i) => i.severity === "info").length,
      findings: findings.length,
      settled: settled.length,
      assigned: resolutions.filter((r) => r.assignment !== undefined).length,
      resolved: parts.filter((p) => p.resolved).length,
      excluded: lines
        .filter((l) => l.excluded !== undefined)
        .reduce((n, l) => n + l.line.refs.length, 0),
      footprintFindings: footprints.reduce((n, f) => n + f.findings.length, 0),
    },
    findings,
    settled: settled.map((f) => {
      const at = marks.get(f.id)?.at;
      return at === undefined ? f : { ...f, solvedAt: at };
    }),
    issues,
    parts,
    partColumns: [...new Set(parts.flatMap((p) => Object.keys(p.fields)))].sort(compareColumns),
    resolutions,
    footprints,
    excluded: lines
      .filter((l) => l.excluded !== undefined)
      .map((l) => ({
        key: l.key,
        value: l.line.value,
        footprint: l.line.footprint,
        reason: l.excluded as string,
        refs: l.line.refs,
      })),
  };
}

/** Rebuilds only when the schematics have changed since the cached run. */
export function createReportCache(project: string, options: ReportOptions = {}) {
  let cached: Report | undefined;
  /**
   * The composite the cached report was built from — kept here rather than
   * read back off `cached.sourceSignature`, which is the schematic
   * fingerprint alone and so never equalled the composite. The comparison was
   * therefore always false: every poll rebuilt the report, re-ran kicad-cli,
   * and handed the page a new `generatedAt` — which re-rendered the view and
   * took whatever was half-typed in a box with it.
   */
  let cachedSignature: string | undefined;
  let inFlight: Promise<Report> | undefined;

  return async function get(): Promise<Report> {
    // Assigning a part, settling a finding or marking one "do not buy"
    // touches no schematic; without these the page would keep serving a report
    // that predates the decision.
    const signature =
      `${sourceSignature(project)}|${solvedSignature(project)}|` +
      `${buySignature(project)}|${inventorySignature()}`;
    if (cached && cachedSignature === signature) return cached;
    if (inFlight) return inFlight;

    // Stamped with the signature as it was *before* the build: a save that
    // lands while the build is running is then still a change next time,
    // rather than one this report gets the credit for having read.
    inFlight = buildReport(project, options)
      .then((report) => {
        cached = report;
        cachedSignature = signature;
        return report;
      })
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  };
}

/** Everything the browser needs to draw one footprint and measure on it. */
export type FootprintDetail = {
  reference: string;
  name: string;
  path: string;
  pads: MeasuredPad[];
  courtyard: { x: number; y: number; width: number; height: number } | undefined;
  measured: Measurement;
  declared: DeclaredFootprint;
  findings: FootprintFinding[];
};

export function footprintDetail(project: string, reference: string): FootprintDetail | undefined {
  const path = resolveFootprint(reference, libraryTable(project));
  if (path === undefined) return undefined;

  const file = readFootprintFile(path);
  const measured = measure(file.pads);
  const declared = parseFootprintName(reference);

  return {
    reference,
    name: file.name,
    path,
    pads: file.pads,
    courtyard: file.courtyard,
    measured,
    declared,
    findings: checkFootprint(declared, measured),
  };
}
