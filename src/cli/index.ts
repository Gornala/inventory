#!/usr/bin/env node
import { buildProgram } from "./program.js";

buildProgram()
  .parseAsync(process.argv)
  .catch((err: unknown) => {
    process.exitCode = 1;
    console.error(err instanceof Error ? err.message : String(err));
  });
