import { canonicalKey, searchLabel } from "../canonical.js";
import type { ComponentClass } from "../parse/refdes.js";
import type { AnalyzedLine, Spec } from "../types.js";
import { formatMagnitude, type Unit } from "../units.js";

export type PackageGroup = {
  pkg: string;
  placements: number;
  refs: string[];
};

export type Finding =
  /** Two BOM lines that spell the same part differently. Free to merge. */
  | {
      kind: "duplicate-spelling";
      key: string;
      spellings: { value: string; placements: number; refs: string[] }[];
      placements: number;
      linesSaved: number;
    }
  /** One part, one package, but reached through different footprints. */
  | {
      kind: "mixed-footprint";
      key: string;
      footprints: { footprint: string; placements: number; refs: string[] }[];
    }
  /** One value bought in several sizes. The user's original question. */
  | {
      kind: "multi-package";
      cls: ComponentClass;
      value: string;
      unit: Unit;
      groups: PackageGroup[];
      /** Package carrying the most placements — the cheapest standard to adopt. */
      suggested: string;
      /** True when the leading packages are equally common, so `suggested` is arbitrary. */
      tied: boolean;
      linesSaved: number;
    }
  /** Values so close together that having both is probably an accident. */
  | {
      kind: "near-value";
      cls: ComponentClass;
      members: { key: string; value: string; placements: number; refs: string[] }[];
      spreadPercent: number;
    }
  /**
   * A *generic* value used exactly once: a candidate for substitution.
   * Specific parts are excluded — a board with one MCU is not a finding.
   */
  | {
      kind: "singleton";
      key: string;
      cls: ComponentClass;
      value: string;
      ref: string;
    };

export type ConsolidationOptions = {
  /** Relative difference under which two values are "suspiciously close". */
  nearValuePercent?: number;
};

type Grouped = {
  key: string;
  lines: AnalyzedLine[];
  placements: number;
  refs: string[];
};

function groupByKey(lines: readonly AnalyzedLine[]): Grouped[] {
  const map = new Map<string, AnalyzedLine[]>();
  for (const line of lines) {
    const bucket = map.get(line.key);
    if (bucket) bucket.push(line);
    else map.set(line.key, [line]);
  }
  return [...map.entries()].map(([key, ls]) => ({
    key,
    lines: ls,
    placements: ls.reduce((n, l) => n + l.line.refs.length, 0),
    refs: ls.flatMap((l) => l.line.refs),
  }));
}

/** Generic specs only, keyed by class and magnitude so packages can be compared. */
function valueKey(spec: Extract<Spec, { kind: "generic" }>): string {
  return `${spec.cls}|${formatMagnitude(spec.magnitude)}`;
}

function duplicateSpellings(groups: readonly Grouped[]): Finding[] {
  const out: Finding[] = [];
  for (const group of groups) {
    const byValue = new Map<string, AnalyzedLine[]>();
    for (const line of group.lines) {
      const value = line.line.value.trim();
      const bucket = byValue.get(value);
      if (bucket) bucket.push(line);
      else byValue.set(value, [line]);
    }
    if (byValue.size < 2) continue;

    out.push({
      kind: "duplicate-spelling",
      key: group.key,
      spellings: [...byValue.entries()]
        .map(([value, ls]) => ({
          value,
          placements: ls.reduce((n, l) => n + l.line.refs.length, 0),
          refs: ls.flatMap((l) => l.line.refs),
        }))
        .sort((a, b) => b.placements - a.placements),
      placements: group.placements,
      linesSaved: byValue.size - 1,
    });
  }
  return out;
}

function mixedFootprints(groups: readonly Grouped[]): Finding[] {
  const out: Finding[] = [];
  for (const group of groups) {
    const byFootprint = new Map<string, AnalyzedLine[]>();
    for (const line of group.lines) {
      const fp = line.line.footprint.trim();
      const bucket = byFootprint.get(fp);
      if (bucket) bucket.push(line);
      else byFootprint.set(fp, [line]);
    }
    if (byFootprint.size < 2) continue;

    out.push({
      kind: "mixed-footprint",
      key: group.key,
      footprints: [...byFootprint.entries()]
        .map(([footprint, ls]) => ({
          footprint,
          placements: ls.reduce((n, l) => n + l.line.refs.length, 0),
          refs: ls.flatMap((l) => l.line.refs),
        }))
        .sort((a, b) => b.placements - a.placements),
    });
  }
  return out;
}

function multiPackage(lines: readonly AnalyzedLine[]): Finding[] {
  const byValue = new Map<string, AnalyzedLine[]>();
  for (const line of lines) {
    if (line.spec.kind !== "generic") continue;
    const k = valueKey(line.spec);
    const bucket = byValue.get(k);
    if (bucket) bucket.push(line);
    else byValue.set(k, [line]);
  }

  const out: Finding[] = [];
  for (const ls of byValue.values()) {
    const byPkg = new Map<string, AnalyzedLine[]>();
    for (const line of ls) {
      const pkg = line.spec.pkg ?? "?";
      const bucket = byPkg.get(pkg);
      if (bucket) bucket.push(line);
      else byPkg.set(pkg, [line]);
    }
    if (byPkg.size < 2) continue;

    const groups: PackageGroup[] = [...byPkg.entries()]
      .map(([pkg, group]) => ({
        pkg,
        placements: group.reduce((n, l) => n + l.line.refs.length, 0),
        refs: group.flatMap((l) => l.line.refs),
      }))
      .sort((a, b) => b.placements - a.placements || a.pkg.localeCompare(b.pkg));

    const first = ls[0] as AnalyzedLine;
    const spec = first.spec as Extract<Spec, { kind: "generic" }>;
    out.push({
      kind: "multi-package",
      cls: spec.cls,
      value: formatMagnitude(spec.magnitude),
      unit: spec.unit,
      groups,
      suggested: (groups[0] as PackageGroup).pkg,
      // A tie means the tool has no basis to prefer either size; say so rather
      // than presenting an arbitrary pick as a recommendation.
      tied: groups.length > 1 && groups[0]?.placements === groups[1]?.placements,
      linesSaved: groups.length - 1,
    });
  }
  return out;
}

type Magnitudes = Map<number, { refs: string[]; keys: Set<string> }>;

/**
 * Groups by class and then by *magnitude*, deliberately not by key: 10k in 0402
 * and 10k in 0603 are the multi-package finding, not a near-value one.
 */
function magnitudesByClass(lines: readonly AnalyzedLine[]): Map<ComponentClass, Magnitudes> {
  const byClass = new Map<ComponentClass, Magnitudes>();

  for (const line of lines) {
    // 0R has no meaningful neighbourhood: everything is infinitely far from it.
    if (line.spec.kind !== "generic" || line.spec.magnitude === 0) continue;

    let magnitudes = byClass.get(line.spec.cls);
    if (!magnitudes) {
      magnitudes = new Map();
      byClass.set(line.spec.cls, magnitudes);
    }

    let slot = magnitudes.get(line.spec.magnitude);
    if (!slot) {
      slot = { refs: [], keys: new Set<string>() };
      magnitudes.set(line.spec.magnitude, slot);
    }
    slot.refs.push(...line.line.refs);
    slot.keys.add(line.key);
  }

  return byClass;
}

function nearValues(lines: readonly AnalyzedLine[], percent: number): Finding[] {
  const out: Finding[] = [];

  for (const [cls, magnitudes] of magnitudesByClass(lines)) {
    const sorted = [...magnitudes.entries()].sort((a, b) => a[0] - b[0]);

    // Walk the sorted values, collecting runs where each step is within
    // tolerance of the last. 49.9k -> 50k -> 51k chains into one finding.
    let run: typeof sorted = [];
    const flush = (): void => {
      const lo = run[0]?.[0];
      const hi = run[run.length - 1]?.[0];
      if (run.length >= 2 && lo !== undefined && hi !== undefined) {
        out.push({
          kind: "near-value",
          cls,
          members: run.map(([magnitude, slot]) => ({
            key: [...slot.keys].sort().join(" "),
            value: formatMagnitude(magnitude),
            placements: slot.refs.length,
            refs: slot.refs,
          })),
          spreadPercent: ((hi - lo) / lo) * 100,
        });
      }
      run = [];
    };

    for (const entry of sorted) {
      const previous = run[run.length - 1];
      if (previous && ((entry[0] - previous[0]) / previous[0]) * 100 <= percent) {
        run.push(entry);
      } else {
        flush();
        run = [entry];
      }
    }
    flush();
  }

  return out;
}

function singletons(groups: readonly Grouped[]): Finding[] {
  const out: Finding[] = [];
  for (const group of groups) {
    if (group.placements !== 1) continue;
    const line = group.lines[0] as AnalyzedLine;
    // Only generics: you can swap a lone 82k for an 80.6k you already stock,
    // but a board with one RP2040 is not a consolidation opportunity.
    if (line.spec.kind !== "generic") continue;
    out.push({
      kind: "singleton",
      key: group.key,
      cls: line.spec.cls,
      value: line.line.value.trim(),
      ref: group.refs[0] as string,
    });
  }
  return out;
}

export function consolidate(
  lines: readonly AnalyzedLine[],
  options: ConsolidationOptions = {},
): Finding[] {
  const percent = options.nearValuePercent ?? 2;
  // Excluded lines never reach the report: a board with 8 test points should
  // not produce eight "used once" findings about pads you cannot buy.
  const buyable = lines.filter((l) => l.excluded === undefined);
  const groups = groupByKey(buyable);

  return [
    ...duplicateSpellings(groups),
    ...mixedFootprints(groups),
    ...multiPackage(buyable),
    ...nearValues(buyable, percent),
    ...singletons(groups),
  ];
}

export type PartRollup = {
  key: string;
  /**
   * The same part as a distributor writes it — `CAP CER 0.1UF 0402` — for
   * pasting into a search box. A label, never an identity: `key` is what
   * anything is filed under.
   */
  label: string;
  cls: ComponentClass;
  value: string;
  pkg: string;
  placements: number;
  refs: string[];
  /** The BOM lines that fed this part, so differing spellings stay visible. */
  sources: { value: string; footprint: string; refs: string[]; dnp: boolean }[];
  issueCount: number;
  /** Already a specific part: nothing for step 2 to resolve. */
  resolved: boolean;
  /**
   * Everything else the BOM said about this part: `Description`, `Datasheet`
   * and every custom field the designer maintains, merged over the lines that
   * fed the key. Two spellings that disagree keep both values rather than one
   * of them winning silently.
   */
  fields: Record<string, string>;
};

/** `Description` and `Datasheet` are BOM columns like any other, and read best last. */
const trailingColumns = ["Description", "Datasheet"];

/**
 * What separates two spellings' disagreeing values in a merged field.
 *
 * Exported because a reader has to be able to tell a value from a question:
 * `RC0402FR-0710KL · RC0603FR-0710KL` is two parts arguing, not an MPN.
 */
export const fieldJoin = " · ";

/**
 * The BOM's own columns for one part.
 *
 * Distinct values are joined rather than reduced to the first: when `100n` and
 * `100nF` merge into one part and only one of them carries `Volrtage 50V`, the
 * disagreement is exactly what the row should show.
 */
function bomFields(lines: readonly AnalyzedLine[]): Record<string, string> {
  const collected = new Map<string, string[]>();
  const add = (name: string, value: string | undefined): void => {
    const trimmed = (value ?? "").trim();
    if (trimmed === "") return;
    const seen = collected.get(name);
    if (seen === undefined) collected.set(name, [trimmed]);
    else if (!seen.includes(trimmed)) seen.push(trimmed);
  };

  for (const l of lines) {
    for (const [name, value] of Object.entries(l.line.fields)) add(name, value);
    add("Description", l.line.description);
    add("Datasheet", l.line.datasheet);
  }

  const fields: Record<string, string> = {};
  for (const name of [...collected.keys()].sort(compareColumns)) {
    fields[name] = (collected.get(name) as string[]).join(fieldJoin);
  }
  return fields;
}

/** Custom fields first, alphabetically and case-insensitively; the long prose last. */
export function compareColumns(a: string, b: string): number {
  const rank = (name: string): number => trailingColumns.indexOf(name) + 1;
  return (
    rank(a) - rank(b) ||
    a.localeCompare(b, "en", { sensitivity: "base" }) ||
    (a < b ? -1 : a > b ? 1 : 0)
  );
}

/** One row per distinct part — what the inventory will eventually be built from. */
export function partsByKey(lines: readonly AnalyzedLine[]): PartRollup[] {
  return groupByKey(lines.filter((l) => l.excluded === undefined))
    .map((group) => {
      const first = group.lines[0] as AnalyzedLine;
      return {
        key: group.key,
        label: searchLabel(first.spec),
        cls: first.spec.cls,
        value:
          first.spec.kind === "generic"
            ? formatMagnitude(first.spec.magnitude)
            : first.spec.designator,
        pkg: first.spec.pkg ?? "?",
        placements: group.placements,
        refs: group.refs,
        sources: group.lines.map((l) => ({
          value: l.line.value.trim(),
          footprint: l.line.footprint,
          refs: l.line.refs,
          dnp: l.line.dnp,
        })),
        issueCount: group.lines.reduce((n, l) => n + l.issues.length, 0),
        fields: bomFields(group.lines),
        resolved: first.spec.kind === "specific" && group.lines.some((l) => l.resolved),
      };
    })
    .sort((a, b) => b.placements - a.placements || a.key.localeCompare(b.key));
}

/** Distinct parts once every free merge has been taken. */
export function distinctParts(lines: readonly AnalyzedLine[]): number {
  return new Set(lines.map((l) => l.key)).size;
}

export { canonicalKey };
