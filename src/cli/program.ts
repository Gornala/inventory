import { Command } from "commander";

import { description, name, version } from "../meta.js";
import { bomCommand } from "./commands/bom.js";
import { checkCommand } from "./commands/check.js";
import { fieldsCommand } from "./commands/fields.js";
import { fpCommand } from "./commands/fp.js";
import { orderCommand } from "./commands/order.js";
import { initCommand, resolveCommand } from "./commands/resolve.js";
import { uiCommand } from "./commands/ui.js";
import { watchCommand } from "./commands/watch.js";

/**
 * Builds the CLI without running it, so tests can inspect and invoke commands
 * without spawning a process. Commands are added here as milestones land.
 */
export function buildProgram(): Command {
  const program = new Command();

  program
    .name(name)
    .description(description)
    .version(version, "-v, --version", "print the version and exit")
    .helpOption("-h, --help", "show this help")
    .showHelpAfterError();

  program.addCommand(bomCommand());
  program.addCommand(checkCommand());
  program.addCommand(fpCommand());
  program.addCommand(watchCommand());
  program.addCommand(uiCommand());
  program.addCommand(initCommand());
  program.addCommand(resolveCommand());
  program.addCommand(fieldsCommand());
  program.addCommand(orderCommand());

  return program;
}
