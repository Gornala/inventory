import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { projectSheetsOrDirectory } from "./hierarchy.js";
import { args, child, children, parseSexpr, type SAtom, type SList } from "./sexpr.js";

/** One field on one symbol, and the bytes that have to change to write it. */
export type FieldEdit = {
  file: string;
  /** The reference the BOM knows this placement by. */
  ref: string;
  uuid: string;
  field: string;
  /** What the field says now; absent when the symbol has no such field yet. */
  from: string | undefined;
  to: string;
  /** Byte span to replace — zero-width for a field being added. */
  start: number;
  end: number;
  /** What goes there. */
  text: string;
  /**
   * Other references carried by the same symbol. A sheet instantiated twice is
   * one symbol with two placements, so editing it changes both — usually what
   * you want, and never something to discover afterwards.
   */
  alsoAffects: string[];
};

export type RewritePlan = {
  project: string;
  edits: FieldEdit[];
  /** References no symbol claimed, or whose field had already moved on. */
  skipped: { ref: string; reason: string }[];
  /** `~name.kicad_sch.lck` files: KiCad has the document open. */
  locked: string[];
  /** Files with uncommitted changes, when the project is in a git repository. */
  dirty: string[];
  /** What each file looked like when the plan was made. */
  files: { path: string; sha: string }[];
};

/** One group of placements and the fields to set on them. */
export type FieldChange = {
  refs: readonly string[];
  /**
   * The value a field must currently carry before it is replaced. A field with
   * no entry here is written whatever it says, and added if it is missing.
   */
  expect?: Record<string, string>;
  /**
   * What the symbol's `Value` may say for this to be the right symbol at all.
   *
   * A reference is not unique. The reference board has two symbols answering to
   * `R10001` in different sheets — one `10k`, one `83k8` — because a project
   * directory can hold sheets that are annotated separately or not in the
   * current hierarchy at all. Writing "this is a 10k" onto the 83k8 is the
   * worst thing this code could do, so a symbol whose value is not one the BOM
   * line was built from is left alone and reported.
   */
  valueIsOneOf?: readonly string[];
  fields: Record<string, string>;
};

/** KiCad quotes with `\"` and `\\` and nothing else. */
function quote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function sha(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

/**
 * The sheets this project is made of.
 *
 * Walked from the root, never globbed: the reference board's directory also
 * holds autosaves and sheets cut from the design, and writing a part number
 * into one of those would be a silent edit to a file nobody is looking at.
 * A bare `.csv` export has no hierarchy, so its directory is the best guess
 * available and the value check below is what keeps that honest.
 */
function schematicsBeside(project: string): string[] {
  const dir = dirname(project);
  if (!existsSync(dir)) return [];
  return projectSheetsOrDirectory(
    project,
    readdirSync(dir)
      .filter((f) => f.endsWith(".kicad_sch"))
      .map((f) => join(dir, f))
      .sort(),
  );
}

/**
 * KiCad writes `~<filename>.lck` beside a document it has open. Writing under
 * it is worse than useless: the next Ctrl+S in KiCad overwrites the file from
 * memory and the edit disappears without a word.
 *
 * The lock lands on the *root* schematic, not on each sheet — KiCad opens a
 * hierarchy as one document and holds every sheet in memory. Checking only the
 * files about to be edited passed happily on a project that was open in KiCad,
 * because the edits were all in sub-sheets. So any schematic lock in the
 * project directory blocks the whole write.
 */
export function schematicLocks(project: string): string[] {
  const dir = dirname(project);
  try {
    return readdirSync(dir)
      .filter((f) => f.startsWith("~") && f.endsWith(".kicad_sch.lck"))
      .map((f) => join(dir, f))
      .sort();
  } catch {
    return [];
  }
}

/** The `(property "Name" "value" …)` node, if the symbol has one. */
function property(symbol: SList, name: string): SList | undefined {
  return children(symbol, "property").find((p) => args(p)[0] === name);
}

function propertyValueAtom(symbol: SList, name: string): SAtom | undefined {
  const node = property(symbol, name);
  const atom = node?.items[2];
  return atom !== undefined && atom.kind === "atom" ? atom : undefined;
}

/**
 * Every reference a symbol answers to: the property, plus one per instance
 * path. A sheet used twice gives one symbol two references.
 */
function referencesOf(symbol: SList): string[] {
  const found = new Set<string>();
  const fromProperty = propertyValueAtom(symbol, "Reference")?.value;
  if (fromProperty !== undefined && fromProperty !== "") found.add(fromProperty);

  const instances = child(symbol, "instances");
  if (instances === undefined) return [...found];
  for (const project of children(instances, "project")) {
    for (const path of children(project, "path")) {
      const reference = args(child(path, "reference"))[0];
      if (reference !== undefined && reference !== "") found.add(reference);
    }
  }
  return [...found];
}

/** Is this property hidden? KiCad 9 says so inside `effects`, KiCad 10 directly. */
function isHidden(node: SList): boolean {
  if (args(child(node, "hide"))[0] === "yes") return true;
  const effects = child(node, "effects");
  if (effects === undefined) return false;
  // KiCad 7 wrote a bare `hide` atom in effects; 8+ writes `(hide yes)`.
  if (effects.items.some((n) => n.kind === "atom" && n.value === "hide")) return true;
  return args(child(effects, "hide"))[0] === "yes";
}

/**
 * A new field is written by *cloning* one the file already has.
 *
 * The alternative was a table of per-version dialects, and the two real files
 * to hand disagree in exactly the way such a table would have to encode: KiCad
 * 9 puts `(hide yes)` inside `(effects …)`, KiCad 10 puts it directly under the
 * property. Copying the bytes of an existing hidden field reproduces whatever
 * the file in front of us does — its dialect, its indentation, its font block —
 * with no version knowledge at all, and it cannot drift when KiCad changes
 * again. A field added this way is hidden because its donor was, which is what
 * you want for a part number: it belongs in the BOM, not on the drawing.
 */
function cloneProperty(text: string, donor: SList, name: string, value: string): string {
  const nameAtom = donor.items[1] as SAtom;
  const valueAtom = donor.items[2] as SAtom;
  const body = text.slice(donor.start, donor.end);
  const offset = (atom: SAtom): [number, number] => [
    atom.start - donor.start,
    atom.end - donor.start,
  ];

  const [ns, ne] = offset(nameAtom);
  const [vs, ve] = offset(valueAtom);
  // Value first: replacing the name would move the value's offsets.
  const withValue = body.slice(0, vs) + quote(value) + body.slice(ve);
  const cloned = withValue.slice(0, ns) + quote(name) + withValue.slice(ne);

  // KiCad 7 numbered fields with `(id N)`; a clone would repeat the donor's.
  // Newer files carry none and this does nothing.
  return cloned.replace(/\n\s*\(id \d+\)/g, "");
}

/** The whitespace a node sits behind, so an inserted sibling lines up with it. */
function indentOf(text: string, node: SList): string {
  const lineStart = text.lastIndexOf("\n", node.start) + 1;
  return text.slice(lineStart, node.start);
}

/**
 * The line ending this file uses.
 *
 * KiCad writes CRLF on Windows and `.gitattributes` marks these files `-text`
 * so git leaves them exactly as they are. An inserted LF line would make the
 * file mixed and put a spurious whole-file change in the next diff. The cloned
 * body carries its own line endings already; only the newline in front of it
 * is ours to choose.
 */
function newlineOf(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

/**
 * Works out which bytes would change, and writes nothing.
 *
 * Matching is by reference, and — where the caller says what it expects — by
 * the field's current value too: a report that has gone stale then skips the
 * symbol instead of overwriting something a person has since changed by hand.
 */
export function planFieldWrite(project: string, changes: readonly FieldChange[]): RewritePlan {
  const wanted = new Map<string, FieldChange>();
  for (const change of changes) {
    for (const ref of change.refs) wanted.set(ref, change);
  }

  const edits: FieldEdit[] = [];
  const claimed = new Set<string>();
  const skipped: { ref: string; reason: string }[] = [];
  const files: { path: string; sha: string }[] = [];

  for (const file of schematicsBeside(project)) {
    let root: SList;
    let text: string;
    try {
      text = readFileSync(file, "utf8");
      root = parseSexpr(text);
    } catch {
      // A sheet that will not parse is one this edit cannot reason about; the
      // others are still safe to change.
      continue;
    }

    let touched = false;
    // Only placements. `lib_symbols` holds the library definitions and carries
    // properties of its own, which are not on the board and must never move.
    for (const symbol of children(root, "symbol")) {
      const refs = referencesOf(symbol);
      const matched = refs.filter((r) => wanted.has(r));
      if (matched.length === 0) continue;

      matched.forEach((r) => claimed.add(r));
      const ref = matched.sort()[0] as string;
      const change = wanted.get(ref) as FieldChange;
      const uuid = args(child(symbol, "uuid"))[0] ?? "";
      const alsoAffects = refs.filter((r) => !wanted.has(r)).sort();
      const properties = children(symbol, "property");
      const donor = properties.find(isHidden);

      if (change.valueIsOneOf !== undefined) {
        const value = propertyValueAtom(symbol, "Value")?.value ?? "";
        if (!change.valueIsOneOf.includes(value)) {
          skipped.push({
            ref,
            reason: `reads "${value}" here, not ${change.valueIsOneOf
              .map((v) => `"${v}"`)
              .join(" or ")} — a different part with the same reference`,
          });
          continue;
        }
      }

      for (const [field, value] of Object.entries(change.fields)) {
        const node = property(symbol, field);
        const expected = change.expect?.[field];

        if (node === undefined) {
          if (expected !== undefined) {
            skipped.push({ ref, reason: `has no ${field} field to change` });
            continue;
          }
          if (donor === undefined) {
            skipped.push({ ref, reason: "no hidden field to copy this file's formatting from" });
            continue;
          }
          const last = properties[properties.length - 1] as SList;
          edits.push({
            file,
            ref,
            uuid,
            field,
            from: undefined,
            to: value,
            start: last.end,
            end: last.end,
            text: `${newlineOf(text)}${indentOf(text, last)}${cloneProperty(text, donor, field, value)}`,
            alsoAffects,
          });
          touched = true;
          continue;
        }

        const atom = node.items[2];
        if (atom === undefined || atom.kind !== "atom") {
          skipped.push({ ref, reason: `the ${field} field has no value to replace` });
          continue;
        }
        if (expected !== undefined && atom.value !== expected) {
          skipped.push({ ref, reason: `${field} reads "${atom.value}", not "${expected}"` });
          continue;
        }
        // Already says what it should: not a change, and not a problem either.
        if (atom.value === value) continue;

        edits.push({
          file,
          ref,
          uuid,
          field,
          from: atom.value,
          to: value,
          start: atom.start,
          end: atom.end,
          text: quote(value),
          alsoAffects,
        });
        touched = true;
      }
    }

    if (touched) files.push({ path: file, sha: sha(text) });
  }

  for (const ref of wanted.keys()) {
    if (!claimed.has(ref)) skipped.push({ ref, reason: "no symbol with this reference" });
  }

  edits.sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      a.ref.localeCompare(b.ref, "en", { numeric: true }) ||
      a.field.localeCompare(b.field),
  );

  return { project, edits, skipped, locked: schematicLocks(project), dirty: [], files };
}

/** "Use this spelling everywhere": one field, `Value`, over several groups. */
export type RewriteRequest = {
  groups: readonly { from: string; refs: readonly string[] }[];
  to: string;
};

export function planValueRewrite(project: string, request: RewriteRequest): RewritePlan {
  return planFieldWrite(
    project,
    request.groups.map((g) => ({
      refs: g.refs,
      expect: { Value: g.from },
      fields: { Value: request.to },
    })),
  );
}

export type RewriteResult = {
  filesChanged: string[];
  backups: string[];
  symbolsChanged: number;
};

/**
 * Splices the planned spans and writes every other byte unchanged.
 *
 * Not parse-and-reserialise: reproducing KiCad's pretty-printer exactly is a
 * losing game, and a reflowed file turns a four-line change into a diff nobody
 * can review. Edits are applied last-first so an earlier splice cannot move a
 * later one's offsets.
 */
export function applyFieldWrite(plan: RewritePlan): RewriteResult {
  if (plan.locked.length > 0) {
    throw new Error(
      `KiCad has this project open (${plan.locked
        .map((l) => basename(l))
        .join(
          ", ",
        )}). Close the schematic editor first — saving from KiCad would overwrite the edit.`,
    );
  }
  if (plan.dirty.length > 0) {
    throw new Error(
      `uncommitted changes in ${plan.dirty
        .map((f) => basename(f))
        .join(", ")} — commit or stash first, so this edit is the only thing in the diff`,
    );
  }
  if (plan.edits.length === 0) throw new Error("nothing to change");

  const byFile = new Map<string, FieldEdit[]>();
  for (const edit of plan.edits) {
    const list = byFile.get(edit.file);
    if (list === undefined) byFile.set(edit.file, [edit]);
    else list.push(edit);
  }

  const backups: string[] = [];
  for (const [file, edits] of byFile) {
    let text = readFileSync(file, "utf8");

    // The plan was made from a read of this file. A save in between moves every
    // offset after the change, so splicing at a planned span would land in the
    // middle of some other atom: the file has to be exactly what it was.
    const seen = plan.files.find((f) => f.path === file);
    if (seen !== undefined && sha(text) !== seen.sha) {
      throw new Error(`${basename(file)} changed since the plan was made — nothing was written`);
    }

    const backup = `${file}.bak`;
    copyFileSync(file, backup);
    backups.push(backup);

    for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
      text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
    }
    writeFileSync(file, text, "utf8");
  }

  return {
    filesChanged: [...byFile.keys()],
    backups,
    symbolsChanged: new Set(plan.edits.map((e) => `${e.file}|${e.uuid}`)).size,
  };
}

/** The UI's "use this spelling" plans and applies one field through the same path. */
export const applyValueRewrite = applyFieldWrite;
