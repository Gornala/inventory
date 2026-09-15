/**
 * S-expression reader for KiCad files, tracking the byte span of every node.
 *
 * The spans are not needed to *read* a footprint — they are here because the
 * step-2b field write-back edits schematics by splicing bytes in place, and
 * that requires knowing exactly where each atom sits in the source.
 */
export type SAtom = {
  kind: "atom";
  value: string;
  quoted: boolean;
  start: number;
  end: number;
};

export type SList = {
  kind: "list";
  items: SNode[];
  start: number;
  end: number;
};

export type SNode = SAtom | SList;

const whitespace = new Set([" ", "\t", "\r", "\n"]);

export function parseSexpr(text: string): SList {
  let i = 0;

  function skip(): void {
    while (i < text.length) {
      const ch = text[i] as string;
      if (whitespace.has(ch)) {
        i += 1;
        continue;
      }
      // KiCad does not write comments, but hand-edited files may carry them.
      if (ch === "#") {
        while (i < text.length && text[i] !== "\n") i += 1;
        continue;
      }
      return;
    }
  }

  function readString(): SAtom {
    const start = i;
    i += 1; // opening quote
    let value = "";
    while (i < text.length) {
      const ch = text[i] as string;
      if (ch === "\\") {
        const next = text[i + 1];
        // KiCad escapes only \" and \\ ; anything else is literal
        value += next === '"' || next === "\\" ? next : ch + (next ?? "");
        i += 2;
        continue;
      }
      if (ch === '"') {
        i += 1;
        return { kind: "atom", value, quoted: true, start, end: i };
      }
      value += ch;
      i += 1;
    }
    throw new SyntaxError(`unterminated string at ${start}`);
  }

  function readAtom(): SAtom {
    const start = i;
    while (i < text.length) {
      const ch = text[i] as string;
      if (whitespace.has(ch) || ch === "(" || ch === ")") break;
      i += 1;
    }
    return { kind: "atom", value: text.slice(start, i), quoted: false, start, end: i };
  }

  function readList(): SList {
    const start = i;
    i += 1; // "("
    const items: SNode[] = [];
    for (;;) {
      skip();
      if (i >= text.length) throw new SyntaxError(`unterminated list at ${start}`);
      const ch = text[i] as string;
      if (ch === ")") {
        i += 1;
        return { kind: "list", items, start, end: i };
      }
      items.push(readNode());
    }
  }

  function readNode(): SNode {
    const ch = text[i] as string;
    if (ch === "(") return readList();
    if (ch === '"') return readString();
    return readAtom();
  }

  skip();
  if (text[i] !== "(") throw new SyntaxError("expected a list at the top level");
  const root = readList();
  skip();
  return root;
}

/** The symbol a list starts with, e.g. `pad` in `(pad "1" smd ...)`. */
export function head(node: SNode): string | undefined {
  if (node.kind !== "list") return undefined;
  const first = node.items[0];
  return first?.kind === "atom" ? first.value : undefined;
}

/** Direct child lists with the given head. */
export function children(node: SNode, name: string): SList[] {
  if (node.kind !== "list") return [];
  return node.items.filter((n): n is SList => n.kind === "list" && head(n) === name);
}

export function child(node: SNode, name: string): SList | undefined {
  return children(node, name)[0];
}

/** Atom values of a list, excluding its head: `(size 1.2 0.8)` → [1.2, 0.8]. */
export function args(node: SNode | undefined): string[] {
  if (!node || node.kind !== "list") return [];
  return node.items.slice(1).flatMap((n) => (n.kind === "atom" ? [n.value] : []));
}

export function numbers(node: SNode | undefined): number[] {
  return args(node)
    .map(Number)
    .filter((n) => Number.isFinite(n));
}
