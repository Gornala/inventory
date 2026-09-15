import type { Finding } from "../core/consolidate/findings.js";
import { unitSymbol } from "../core/units.js";
import type { AnalyzedLine, Issue } from "../core/types.js";

export function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

/** Refs are the point of every finding — they are where you go in KiCad. */
export function refList(refs: readonly string[], limit = 8): string {
  const shown = refs.slice(0, limit).join(",");
  return refs.length > limit ? `${shown}, …(+${refs.length - limit})` : shown;
}

function valueWithUnit(value: string, unit: string): string {
  return unit === "Ω" ? `${value} ${unit}` : `${value}${unit}`;
}

export function renderSummary(lines: readonly AnalyzedLine[]): string {
  const buyable = lines.filter((l) => l.excluded === undefined);
  const placements = buyable.reduce((n, l) => n + l.line.refs.length, 0);
  const parts = new Set(buyable.map((l) => l.key)).size;
  const resolved = new Set(buyable.filter((l) => l.resolved).map((l) => l.key)).size;
  const skipped = lines.length - buyable.length;

  return (
    `${placements} placements · ${buyable.length} BOM lines · ${parts} distinct parts` +
    (resolved > 0 ? ` · ${resolved} already resolved` : "") +
    (skipped > 0 ? ` · ${skipped} lines not bought` : "")
  );
}

/** The board features left out of the parts list, grouped by why. */
export function renderExcluded(lines: readonly AnalyzedLine[]): string {
  const skipped = lines.filter((l) => l.excluded !== undefined);
  if (skipped.length === 0) return "";

  const byReason = new Map<string, AnalyzedLine[]>();
  for (const line of skipped) {
    const bucket = byReason.get(line.excluded as string);
    if (bucket) bucket.push(line);
    else byReason.set(line.excluded as string, [line]);
  }

  const out: string[] = ["NOT BOUGHT  —  board features, not purchases"];
  for (const [reason, group] of byReason) {
    const placements = group.reduce((n, l) => n + l.line.refs.length, 0);
    out.push(`  ${reason} (${placements})`);
    for (const line of group) {
      out.push(`    ${pad(line.line.value || "—", 20)} ${refList(line.line.refs, 8)}`);
    }
  }
  return out.join("\n");
}

export function renderFindings(findings: readonly Finding[]): string {
  const out: string[] = [];

  const duplicates = findings.filter((f) => f.kind === "duplicate-spelling");
  if (duplicates.length > 0) {
    const saved = duplicates.reduce(
      (n, f) => n + (f.kind === "duplicate-spelling" ? f.linesSaved : 0),
      0,
    );
    out.push(`SAME PART, SPELLED DIFFERENTLY  —  ${saved} BOM lines disappear for free`);
    for (const f of duplicates) {
      if (f.kind !== "duplicate-spelling") continue;
      const spellings = f.spellings.map((s) => `${s.value} ×${s.placements}`).join("  +  ");
      out.push(`  ${pad(f.key, 18)} ${spellings}`);
      out.push(`  ${" ".repeat(18)} ${refList(f.spellings.flatMap((s) => s.refs))}`);
    }
    out.push("");
  }

  const multi = findings.filter((f) => f.kind === "multi-package");
  if (multi.length > 0) {
    out.push("ONE VALUE, SEVERAL PACKAGES  —  a decision for you, in KiCad");
    for (const f of multi) {
      if (f.kind !== "multi-package") continue;
      const packages = f.groups.map((g) => `${g.pkg} ×${g.placements}`).join("   ");
      out.push(`  ${pad(valueWithUnit(f.value, unitSymbol[f.unit]), 12)} ${packages}`);
      for (const g of f.groups) {
        const marker = g.pkg === f.suggested ? "keep " : "move ";
        out.push(`  ${" ".repeat(12)} ${marker}${pad(g.pkg, 6)} ${refList(g.refs)}`);
      }
      const advice = f.tied
        ? `→ ${f.groups.length} equally common sizes; pick one: −${f.linesSaved} line item${
            f.linesSaved === 1 ? "" : "s"
          }`
        : `→ standardise on ${f.suggested}: −${f.linesSaved} line item${
            f.linesSaved === 1 ? "" : "s"
          }`;
      out.push(`  ${" ".repeat(12)} ${advice}`);
    }
    out.push("");
  }

  const near = findings.filter((f) => f.kind === "near-value");
  if (near.length > 0) {
    out.push("VALUES SUSPICIOUSLY CLOSE TOGETHER  —  probably unintentional");
    for (const f of near) {
      if (f.kind !== "near-value") continue;
      const members = f.members.map((m) => `${m.value} ×${m.placements}`).join("  ·  ");
      out.push(`  ${pad(`${f.spreadPercent.toFixed(1)}% apart`, 14)} ${members}`);
      out.push(`  ${" ".repeat(14)} ${refList(f.members.flatMap((m) => m.refs))}`);
    }
    out.push("");
  }

  const mixed = findings.filter((f) => f.kind === "mixed-footprint");
  if (mixed.length > 0) {
    out.push("ONE PART, DIFFERENT FOOTPRINTS");
    for (const f of mixed) {
      if (f.kind !== "mixed-footprint") continue;
      out.push(`  ${f.key}`);
      for (const fp of f.footprints) {
        out.push(`    ${pad(`×${fp.placements}`, 5)} ${fp.footprint}  ${refList(fp.refs, 4)}`);
      }
    }
    out.push("");
  }

  const single = findings.filter((f) => f.kind === "singleton");
  if (single.length > 0) {
    out.push(`GENERIC VALUES USED ONCE (${single.length})  —  candidates for substitution`);
    const cells = single
      .map((f) => (f.kind === "singleton" ? `${f.value} @${f.ref}` : ""))
      .filter((c) => c !== "");
    const width = Math.max(...cells.map((c) => c.length)) + 2;
    const perRow = Math.max(1, Math.floor(76 / width));
    for (let i = 0; i < cells.length; i += perRow) {
      out.push(
        `  ${cells
          .slice(i, i + perRow)
          .map((c) => pad(c, width))
          .join("")}`.trimEnd(),
      );
    }
    out.push("");
  }

  return out.join("\n").trimEnd();
}

export function renderIssues(lines: readonly AnalyzedLine[]): string {
  return renderIssueList(lines.flatMap((l) => l.issues));
}

/** Issues on their own, for callers that already flattened them. */
export function renderIssueList(all: readonly Issue[]): string {
  const out: string[] = [];

  // Errors first, informational notes last: a report that presents a resolved
  // part number as a problem trains you to ignore it.
  for (const severity of ["error", "warning", "info"] as const) {
    const group = all.filter((i) => i.severity === severity);
    if (group.length === 0) continue;
    out.push(`${severity.toUpperCase()}S (${group.length})`);
    for (const issue of group) {
      out.push(`  ${pad(issue.code, 22)} ${issue.message}`);
      out.push(`  ${" ".repeat(22)} ${refList(issue.refs, 6)}`);
    }
    out.push("");
  }
  return out.join("\n").trimEnd();
}

export function countBySeverity(lines: readonly AnalyzedLine[]): Record<string, number> {
  const counts: Record<string, number> = { error: 0, warning: 0, info: 0 };
  for (const line of lines) {
    for (const issue of line.issues) counts[issue.severity] = (counts[issue.severity] ?? 0) + 1;
  }
  return counts;
}
