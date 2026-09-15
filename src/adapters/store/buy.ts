import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * One part, and whether you buy it — your answer, not the tool's.
 *
 * The rules in `src/core/parse/spec.ts` decide what is a board feature rather
 * than a purchase, and they are right often enough to be the default and wrong
 * often enough to need overruling in both directions: a footprint you populate
 * by hand off-board is not a purchase, and a "mounting hole" that is really a
 * standoff is.
 */
export type BuyChoice = {
  /** The canonical key, the same one the parts table and the catalog use. */
  key: string;
  /** True keeps the part in the list to buy; false takes it out. */
  buy: boolean;
  at: string;
};

/**
 * The choices, kept beside the project.
 *
 * Same bargain as `solved.json`: a plain JSON file, sorted, so `git diff` says
 * what you decided and when. It belongs to the board rather than to the shared
 * catalog — "we hand-populate these on this board" is a fact about this board.
 */
export function buyPath(project: string): string {
  return join(dirname(project), ".kinv", "buy.json");
}

type BuyFile = { choices: BuyChoice[] };

export function readBuyChoices(project: string): BuyChoice[] {
  const path = buyPath(project);
  try {
    if (!existsSync(path)) return [];
    const parsed = JSON.parse(readFileSync(path, "utf8")) as BuyFile;
    // A hand-edited or half-written file must not take the report down; an
    // unreadable one simply means nothing has been overruled.
    return Array.isArray(parsed.choices)
      ? parsed.choices.filter((c) => typeof c.key === "string" && typeof c.buy === "boolean")
      : [];
  } catch {
    return [];
  }
}

export function writeBuyChoices(project: string, choices: readonly BuyChoice[]): void {
  const path = buyPath(project);
  mkdirSync(dirname(path), { recursive: true });
  const sorted = [...choices].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  writeFileSync(path, `${JSON.stringify({ choices: sorted }, null, 2)}\n`, "utf8");
}

/**
 * Records one decision, and returns the file as it now stands.
 *
 * Both answers are written down, including the one that agrees with the rules.
 * Deleting the entry instead would be tidier and would lie: "buy this" on a
 * part the geometry rule threw out has to leave something behind, and a button
 * whose effect depends on how the part came to be excluded is a button you
 * cannot predict.
 */
export function setBuyChoice(project: string, key: string, buy: boolean): readonly BuyChoice[] {
  const kept = readBuyChoices(project).filter((c) => c.key !== key);
  const next = [...kept, { key, buy, at: new Date().toISOString() }];
  writeBuyChoices(project, next);
  return next;
}

/** Forgets one decision, leaving the rules to answer for that part again. */
export function clearBuyChoice(project: string, key: string): readonly BuyChoice[] {
  const next = readBuyChoices(project).filter((c) => c.key !== key);
  writeBuyChoices(project, next);
  return next;
}

/**
 * Fingerprint of the choices file, for the report cache.
 *
 * Marking a part changes no schematic and no mtime of one, so without this the
 * page would keep serving a report that still shows what you just took out.
 */
export function buySignature(project: string): string {
  try {
    const stat = statSync(buyPath(project));
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return "";
  }
}
