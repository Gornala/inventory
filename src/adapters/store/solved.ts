import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { SolvedMark } from "../../core/consolidate/identity.js";

/**
 * Findings you have settled, kept beside the project.
 *
 * A plain JSON file written canonically — sorted, one mark per line's worth of
 * object — so `git diff` says what you decided and when, which is the same
 * bargain the rest of the tool's state makes. No database, and nothing hidden
 * in a browser that a second machine or `kinv check` cannot see.
 */
export function solvedPath(project: string): string {
  return join(dirname(project), ".kinv", "solved.json");
}

type SolvedFile = { solved: SolvedMark[] };

export function readSolved(project: string): SolvedMark[] {
  const path = solvedPath(project);
  try {
    if (!existsSync(path)) return [];
    const parsed = JSON.parse(readFileSync(path, "utf8")) as SolvedFile;
    // A hand-edited or half-written file must not take the report down; an
    // unreadable one simply means nothing has been settled.
    return Array.isArray(parsed.solved)
      ? parsed.solved.filter((m) => typeof m.id === "string")
      : [];
  } catch {
    return [];
  }
}

export function writeSolved(project: string, marks: readonly SolvedMark[]): void {
  const path = solvedPath(project);
  mkdirSync(dirname(path), { recursive: true });
  const sorted = [...marks].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  writeFileSync(path, `${JSON.stringify({ solved: sorted }, null, 2)}\n`, "utf8");
}

/** Adds, replaces or removes one mark, and returns the file as it now stands. */
export function setSolved(
  project: string,
  mark: SolvedMark,
  solved: boolean,
): readonly SolvedMark[] {
  const kept = readSolved(project).filter((m) => m.id !== mark.id);
  const next = solved ? [...kept, mark] : kept;
  writeSolved(project, next);
  return next;
}

export function clearSolved(project: string): void {
  writeSolved(project, []);
}

/**
 * Fingerprint of the marks file, for the report cache.
 *
 * The cache rebuilds when the schematics change; settling a finding changes
 * neither a schematic nor its mtime, so without this the page would keep
 * serving a report that still shows what you just dismissed.
 */
export function solvedSignature(project: string): string {
  try {
    const stat = statSync(solvedPath(project));
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return "";
  }
}
