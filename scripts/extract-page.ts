/**
 * Writes the UI page out of the TypeScript template as the exact bytes a
 * browser receives, for the Python server to serve.
 *
 * Evaluated by Node rather than unescaped by hand: the template carries
 * `${sortScript}`, `${viewerScript}` and backslash escapes that a careful copy
 * would still get wrong somewhere in 2,260 lines. The build stamp stays a
 * placeholder, exactly as the TypeScript server receives it.
 */
import { writeFileSync } from "node:fs";
import { page } from "../src/ui/page.js";

const out = process.argv[2] ?? "kinv/ui/page.html";
writeFileSync(out, page, "utf8");
console.log(`${page.length} characters → ${out}`);
