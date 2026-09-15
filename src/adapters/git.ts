import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";

/**
 * Which of these files git already has uncommitted changes to.
 *
 * The point is not to police your working tree: it is that after this write
 * runs, `git diff` should show *only* what the tool did. A file that was
 * already modified turns "here is what changed" into a guessing game, and the
 * `.bak` beside it is a worse answer than a commit.
 *
 * A directory that is not a repository, or a machine with no git, returns
 * nothing: the guard exists where it can help and is silent where it cannot.
 */
export function dirtyFiles(files: readonly string[]): string[] {
  if (files.length === 0) return [];
  const cwd = dirname(files[0] as string);
  try {
    const out = execFileSync("git", ["status", "--porcelain", "--", ...files], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    // `XY path`, and ` -> ` for a rename; the path is what matters here.
    const changed = out
      .split("\n")
      .map((line) => line.slice(3).trim())
      .filter((line) => line !== "")
      .map((line) => (line.includes(" -> ") ? (line.split(" -> ")[1] as string) : line))
      .map((line) => resolve(cwd, line.replace(/^"|"$/g, "")));

    return files.filter((f) => changed.includes(resolve(f)));
  } catch {
    return [];
  }
}
