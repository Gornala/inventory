import { watch, type FSWatcher } from "node:fs";
import { dirname, extname } from "node:path";

import { sourceSignature } from "../../report.js";

export type WatchOptions = {
  /** Quiet period before reacting, in ms. */
  settleMs?: number;
  /** Backstop sweep interval, in ms. */
  sweepMs?: number;
};

export type Watcher = { stop: () => void };

/**
 * Calls `onChange` after the project's schematics stop changing.
 *
 * Saving a hierarchical design writes several files in quick succession, and
 * none of the writes is atomic, so reacting to the first event would run
 * kicad-cli against a half-written file. Everything is therefore debounced
 * until the directory has been quiet for a moment.
 *
 * `fs.watch` is the fast path and an mtime sweep is the backstop: editors that
 * save via a temporary file and a rename can leave a watch pointing at an inode
 * that no longer exists, and a missed save is far worse than a late one.
 */
export function watchProject(
  project: string,
  onChange: () => void,
  options: WatchOptions = {},
): Watcher {
  const settleMs = options.settleMs ?? 400;
  const sweepMs = options.sweepMs ?? 2000;

  const isCsv = extname(project).toLowerCase() === ".csv";
  const target = isCsv ? project : dirname(project);

  let last = sourceSignature(project);
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;

  const settle = (): void => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      const signature = sourceSignature(project);
      // An unchanged signature means the event was noise — a lock file, an
      // editor's scratch write, or our own read.
      if (signature === last) return;
      last = signature;
      onChange();
    }, settleMs);
    // Never hold the process open on the debounce alone.
    timer.unref?.();
  };

  let watcher: FSWatcher | undefined;
  try {
    watcher = watch(target, { persistent: true }, (_event, filename) => {
      if (isCsv || filename === null || filename.endsWith(".kicad_sch")) settle();
    });
    watcher.on("error", () => {
      // The sweep carries on alone; a dead watcher must not end the session.
      watcher = undefined;
    });
  } catch {
    watcher = undefined;
  }

  // Deliberately *not* unref'd: this interval is what keeps the process alive.
  // Relying on the fs watcher alone would exit instantly on a system where the
  // watch could not be created.
  const sweep = setInterval(() => {
    // Only arms when nothing is pending. A watch event means "more writes may
    // follow, wait longer"; a poll means "something changed, and I will keep
    // saying so" — letting it re-arm would reset the debounce forever and the
    // refresh would never run.
    if (timer === undefined && sourceSignature(project) !== last) settle();
  }, sweepMs);

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      clearInterval(sweep);
      watcher?.close();
    },
  };
}
