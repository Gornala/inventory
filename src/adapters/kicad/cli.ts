import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import { promisify } from "node:util";

import type { BomLine } from "../../core/types.js";
import { parseBomCsv } from "./bom.js";
import { projectFieldNames } from "./fields.js";

const run = promisify(execFile);

/** Always requested, in this order. The generated columns come last. */
const namedFields = ["Reference", "Value", "Footprint", "Datasheet", "Description"];
const generatedFields = ["${QUANTITY}", "${DNP}"];

/**
 * The `--fields` list for a project: the fixed columns plus every custom field
 * the designer put on a symbol. Passing `--fields` without `--labels` makes
 * kicad-cli label each column with the field's own name, which is what the CSV
 * reader expects.
 */
function bomFields(schematic: string): string {
  return [...namedFields, ...projectFieldNames(schematic), ...generatedFields].join(",");
}

/**
 * Locates kicad-cli: the KINV_KICAD_CLI override, then PATH, then the default
 * Windows install root (newest version first).
 */
export function findKicadCli(): string | undefined {
  const override = process.env["KINV_KICAD_CLI"];
  if (override) return existsSync(override) ? override : undefined;

  const root = "C:/Program Files/KiCad";
  if (existsSync(root)) {
    const versions = readdirSync(root)
      .filter((v) => existsSync(join(root, v, "bin/kicad-cli.exe")))
      .sort((a, b) => b.localeCompare(a, "en", { numeric: true }));
    const newest = versions[0];
    if (newest) return join(root, newest, "bin/kicad-cli.exe");
  }

  // Fall back to PATH resolution by the OS.
  return process.platform === "win32" ? "kicad-cli.exe" : "kicad-cli";
}

/** Root schematic for a project path (`.kicad_pro` or `.kicad_sch`). */
export function rootSchematic(projectPath: string): string {
  const ext = extname(projectPath);
  if (ext === ".kicad_sch") return projectPath;
  if (ext === ".kicad_pro") {
    const sch = projectPath.slice(0, -ext.length) + ".kicad_sch";
    if (!existsSync(sch)) {
      throw new Error(`no schematic beside the project: expected ${sch}`);
    }
    return sch;
  }
  throw new Error(`not a KiCad project or schematic: ${projectPath}`);
}

export type ExportOptions = {
  /** Group references whose listed fields all match. */
  groupBy?: string;
  /** Leave do-not-populate parts out entirely. */
  excludeDnp?: boolean;
};

/**
 * Exports a BOM for the whole schematic hierarchy in one kicad-cli call.
 *
 * Reading goes through kicad-cli rather than parsing `.kicad_sch` because it
 * resolves the hierarchy, instance paths and inherited fields exactly the way
 * KiCad itself does — the parts most likely to drift between versions.
 */
export async function exportBom(
  projectPath: string,
  options: ExportOptions = {},
): Promise<BomLine[]> {
  const cli = findKicadCli();
  if (!cli) throw new Error("kicad-cli not found; set KINV_KICAD_CLI to its path");

  const schematic = rootSchematic(projectPath);
  const workDir = mkdtempSync(join(tmpdir(), "kinv-"));
  const out = join(workDir, "bom.csv");

  try {
    const args = ["sch", "export", "bom", "--fields", bomFields(schematic), "-o", out];
    if (options.groupBy !== undefined) args.push("--group-by", options.groupBy);
    if (options.excludeDnp === true) args.push("--exclude-dnp");
    args.push(schematic);

    await run(cli, args, { windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
    return parseBomCsv(readFileSync(out, "utf8"), dirname(schematic));
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}
