import type { Finding } from "./findings.js";

/**
 * A stable name for a finding, and a fingerprint of what it currently says.
 *
 * Marking a finding "solved" has to survive a re-read of the board, and the
 * board is re-read every time you save. The *id* is what the finding is about
 * — this value, this key, these parts — and does not move when a count
 * changes. The *signature* is what the finding says right now.
 *
 * A mark is honoured only while both match. So settling "10k in 0402 and 0603"
 * keeps quiet through unrelated edits, and speaks up again the day a third
 * package appears: you settled the question that was asked, not the subject.
 */
export function findingId(f: Finding): string {
  switch (f.kind) {
    case "duplicate-spelling":
    case "mixed-footprint":
    case "singleton":
      return `${f.kind}:${f.key}`;
    case "multi-package":
      return `${f.kind}:${f.cls}:${f.value}${f.unit}`;
    case "near-value":
      return `${f.kind}:${f.members
        .map((m) => m.key)
        .sort()
        .join(",")}`;
  }
}

export function findingSignature(f: Finding): string {
  switch (f.kind) {
    case "duplicate-spelling":
      return f.spellings
        .map((s) => `${s.value}×${s.placements}`)
        .sort()
        .join(" ");
    case "mixed-footprint":
      return f.footprints
        .map((x) => `${x.footprint}×${x.placements}`)
        .sort()
        .join(" ");
    case "multi-package":
      return f.groups
        .map((g) => `${g.pkg}×${g.placements}`)
        .sort()
        .join(" ");
    case "near-value":
      return f.members
        .map((m) => `${m.value}×${m.placements}`)
        .sort()
        .join(" ");
    case "singleton":
      return f.ref;
  }
}

/** What the UI shows on a settled card, and what the file records. */
export type SolvedMark = {
  id: string;
  /** The finding's wording when it was settled; a change brings it back. */
  signature: string;
  at: string;
  note?: string;
};
