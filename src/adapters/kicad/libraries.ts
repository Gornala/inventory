import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, join } from "node:path";

import { args, child, children, parseSexpr } from "./sexpr.js";

export type LibraryEntry = { name: string; uri: string; type: string };

/** KiCad install roots, newest first. */
function kicadRoots(): string[] {
  const roots: string[] = [];
  const base = "C:/Program Files/KiCad";
  if (existsSync(base)) {
    for (const version of readdirSync(base).sort((a, b) =>
      b.localeCompare(a, "en", { numeric: true }),
    )) {
      roots.push(join(base, version));
    }
  }
  for (const unix of ["/usr/share/kicad", "/usr/local/share/kicad"]) {
    if (existsSync(unix)) roots.push(dirname(dirname(unix)));
  }
  return roots;
}

/**
 * Resolves `${KICAD9_FOOTPRINT_DIR}` and friends.
 *
 * These rarely exist in the process environment — KiCad keeps them in
 * `kicad_common.json` and falls back to built-in defaults — and a KiCad 10
 * install can still carry a table written by KiCad 9, so the version in the
 * variable name is deliberately ignored when falling back.
 */
export function resolveVars(uri: string): string {
  return uri.replace(/\$\{([^}]+)\}/g, (whole, name: string) => {
    const fromEnv = process.env[name];
    if (fromEnv) return fromEnv;

    const fromConfig = configVars()[name];
    if (fromConfig) return fromConfig;

    const suffix = /FOOTPRINT_DIR$/.test(name)
      ? "share/kicad/footprints"
      : /SYMBOL_DIR$/.test(name)
        ? "share/kicad/symbols"
        : /3DMODEL_DIR$/.test(name)
          ? "share/kicad/3dmodels"
          : undefined;
    if (suffix) {
      for (const root of kicadRoots()) {
        const candidate = join(root, suffix);
        if (existsSync(candidate)) return candidate;
      }
    }
    return whole;
  });
}

let configCache: Record<string, string> | undefined;

function configVars(): Record<string, string> {
  if (configCache) return configCache;
  configCache = {};
  for (const dir of kicadConfigDirs()) {
    const file = join(dir, "kicad_common.json");
    if (!existsSync(file)) continue;
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      const vars =
        typeof parsed === "object" && parsed !== null
          ? (parsed as { environment?: { vars?: Record<string, string> } }).environment?.vars
          : undefined;
      if (vars) configCache = { ...vars, ...configCache };
    } catch {
      // a malformed config is not this tool's problem to report
    }
  }
  return configCache;
}

/** KiCad's per-user config directories, newest version first. */
export function kicadConfigDirs(): string[] {
  const roots =
    process.platform === "win32"
      ? [join(process.env["APPDATA"] ?? join(homedir(), "AppData/Roaming"), "kicad")]
      : process.platform === "darwin"
        ? [join(homedir(), "Library/Preferences/kicad")]
        : [join(process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config"), "kicad")];

  const dirs: string[] = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const version of readdirSync(root).sort((a, b) =>
      b.localeCompare(a, "en", { numeric: true }),
    )) {
      const dir = join(root, version);
      if (existsSync(join(dir, "fp-lib-table"))) dirs.push(dir);
    }
  }
  return dirs;
}

export function parseLibTable(text: string): LibraryEntry[] {
  const root = parseSexpr(text);
  return children(root, "lib").map((lib) => ({
    name: args(child(lib, "name"))[0] ?? "",
    uri: resolveVars(args(child(lib, "uri"))[0] ?? ""),
    type: args(child(lib, "type"))[0] ?? "KiCad",
  }));
}

/**
 * Footprint libraries visible to a project: the project's own table first, so
 * a project-local library shadows a global one of the same nickname, exactly
 * as KiCad resolves them.
 */
export function libraryTable(projectPath: string): Map<string, LibraryEntry> {
  const table = new Map<string, LibraryEntry>();

  for (const dir of kicadConfigDirs()) {
    for (const entry of parseLibTable(readFileSync(join(dir, "fp-lib-table"), "utf8"))) {
      if (!table.has(entry.name)) table.set(entry.name, entry);
    }
  }

  const projectDir = extname(projectPath) === "" ? projectPath : dirname(projectPath);
  const projectTable = join(projectDir, "fp-lib-table");
  if (existsSync(projectTable)) {
    for (const entry of parseLibTable(readFileSync(projectTable, "utf8"))) {
      table.set(entry.name, entry); // project wins
    }
  }

  return table;
}

/** Absolute path of `Library:Footprint`, or undefined when it cannot be found. */
export function resolveFootprint(
  reference: string,
  table: Map<string, LibraryEntry>,
): string | undefined {
  const colon = reference.indexOf(":");
  if (colon < 0) return undefined;

  const library = table.get(reference.slice(0, colon));
  if (!library) return undefined;

  const path = join(library.uri, `${reference.slice(colon + 1)}.kicad_mod`);
  return existsSync(path) ? path : undefined;
}
