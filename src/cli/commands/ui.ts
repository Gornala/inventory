import { execFile } from "node:child_process";
import { Command } from "commander";

import { startUiServer } from "../../ui/server.js";

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  execFile(cmd, args, () => {
    /* opening a browser is a convenience; failing to is not an error */
  });
}

export function uiCommand(): Command {
  return new Command("ui")
    .description("serve a live view of the project's BOM, findings and issues")
    .argument("<project>", "path to a .kicad_pro or .kicad_sch, or an exported .csv")
    .option("--port <port>", "port to listen on", "7373")
    .option("--group-by <fields>", "kicad-cli grouping fields", "Value,Footprint")
    .option("--exclude-dnp", "drop do-not-populate parts")
    .option("--near <percent>", "flag values closer together than this", "2")
    .option("--include-excluded", "keep test points and mounting holes as parts")
    .option("--no-open", "do not open a browser")
    .action(
      async (
        project: string,
        opts: {
          port: string;
          groupBy: string;
          excludeDnp?: boolean;
          near: string;
          includeExcluded?: boolean;
          open: boolean;
        },
      ) => {
        const near = Number(opts.near);
        const { url } = await startUiServer(project, {
          port: Number(opts.port),
          groupBy: opts.groupBy,
          ...(opts.excludeDnp === true ? { excludeDnp: true } : {}),
          ...(Number.isFinite(near) ? { nearValuePercent: near } : {}),
          ...(opts.includeExcluded === true ? { includeExcluded: true } : {}),
        });

        console.log(`kinv ui → ${url}`);
        console.log("re-reads the schematics whenever you save in KiCad · ctrl-c to stop");
        if (opts.open) openBrowser(url);
      },
    );
}
