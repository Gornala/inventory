import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Locate the package root by walking up from this module until a package.json
 * turns up. Works both from `src/` under tsx and from `dist/` after a build,
 * so the CLI reports the same version either way.
 */
function findPackageJson(startDir: string): { dir: string; raw: string } {
  let dir = startDir;
  for (;;) {
    try {
      return { dir, raw: readFileSync(join(dir, "package.json"), "utf8") };
    } catch {
      const parent = dirname(dir);
      if (parent === dir) throw new Error("package.json not found above " + startDir);
      dir = parent;
    }
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const found = findPackageJson(here);
const pkg: unknown = JSON.parse(found.raw);

function stringField(o: unknown, key: string, fallback: string): string {
  if (typeof o === "object" && o !== null && key in o) {
    const v = (o as Record<string, unknown>)[key];
    if (typeof v === "string") return v;
  }
  return fallback;
}

export const packageRoot = found.dir;
export const name = stringField(pkg, "name", "kinv");
export const version = stringField(pkg, "version", "0.0.0");
export const description = stringField(pkg, "description", "");
