import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Assignment, CatalogPart } from "../../core/inventory/types.js";

/**
 * The catalog is one directory for every board, not one per project.
 *
 * A part chosen once should be reused everywhere — the second board asks
 * nothing about 10k 0603 — and what is on the shelf is a property of the shelf,
 * not of a design. Settled findings stay beside their project for the opposite
 * reason: they are a decision about *that* schematic.
 *
 * `KINV_HOME` moves it, which is what makes the whole thing testable.
 */
export function inventoryHome(): string {
  return process.env["KINV_HOME"] ?? join(homedir(), ".kinv");
}

export function catalogPath(): string {
  return join(inventoryHome(), "catalog.json");
}

export function assignmentsPath(): string {
  return join(inventoryHome(), "assignments.json");
}

/**
 * Sorted keys and a stable order, so a one-part change is a one-line diff and
 * `git diff` reads as the audit log.
 */
function writeCanonical(path: string, value: unknown): void {
  mkdirSync(inventoryHome(), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, orderedKeys, 2)}\n`, "utf8");
}

function orderedKeys(_key: string, value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const source = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const name of Object.keys(source).sort()) sorted[name] = source[name];
  return sorted;
}

function readFile<T>(path: string, key: string): T[] {
  try {
    if (!existsSync(path)) return [];
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const list = parsed[key];
    // A half-written or hand-edited file means "nothing recorded", never a
    // crash: this sits under every report the tool produces.
    return Array.isArray(list) ? (list as T[]) : [];
  } catch {
    return [];
  }
}

export function readCatalog(): CatalogPart[] {
  return readFile<CatalogPart>(catalogPath(), "parts").filter((p) => typeof p.id === "string");
}

export function readAssignments(): Assignment[] {
  return readFile<Assignment>(assignmentsPath(), "assignments").filter(
    (a) => typeof a.key === "string" && typeof a.partId === "string",
  );
}

export function writeCatalog(parts: readonly CatalogPart[]): void {
  const sorted = [...parts].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  writeCanonical(catalogPath(), { parts: sorted });
}

export function writeAssignments(assignments: readonly Assignment[]): void {
  const sorted = [...assignments].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  writeCanonical(assignmentsPath(), { assignments: sorted });
}

/**
 * Fingerprint of the inventory, for the report cache.
 *
 * Assigning a part changes no schematic, so without this the page would keep
 * serving a report that still calls the part unresolved.
 */
export function inventorySignature(): string {
  const stamp = (path: string): string => {
    try {
      const stat = statSync(path);
      return `${stat.mtimeMs}:${stat.size}`;
    } catch {
      return "";
    }
  };
  return `${stamp(catalogPath())}|${stamp(assignmentsPath())}`;
}

/** Creates the directory and both files, so there is somewhere to look. */
export function initInventory(): string {
  const home = inventoryHome();
  mkdirSync(home, { recursive: true });
  if (!existsSync(catalogPath())) writeCatalog([]);
  if (!existsSync(assignmentsPath())) writeAssignments([]);
  return home;
}
