/**
 * `startUiServer`, answered by the Python version.
 *
 * vitest.python.config.ts aliases `src/ui/server.js` to this file, so the
 * browser tests in tests/ui — which drive the real page through JSDOM — run
 * unchanged against the Python server. They were the one part of the suite the
 * port had no Python equivalent for.
 *
 * A test that stands in for the folder dialog passes a function; a function
 * cannot cross a process boundary, so a tiny local server holds it and the
 * Python side POSTs each question to it.
 */
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

type FolderChoice = { status: string; [k: string]: unknown };
type Options = { port?: number; chooseFolder?: (start: string) => Promise<FolderChoice> };

const python = process.env["KINV_PYTHON"] ?? "python";

async function answering(
  choose: Options["chooseFolder"],
): Promise<{ url: string; server: Server } | undefined> {
  if (!choose) return undefined;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const { start } = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { start: string };
      void choose(start).then((choice) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(choice));
      });
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { url: `http://127.0.0.1:${port}/`, server };
}

export async function startUiServer(
  project: string,
  options: Options = {},
): Promise<{ server: { close(cb?: () => void): void }; url: string }> {
  const answers = await answering(options.chooseFolder);
  const args = [
    "-m",
    "kinv.ui.testserve",
    project,
    ...(answers ? ["--choose-url", answers.url] : []),
  ];
  const child = spawn(python, args, {
    cwd: resolve(import.meta.dirname, ".."),
    env: process.env,
    stdio: ["pipe", "pipe", "inherit"],
    windowsHide: true,
  });

  const url = await new Promise<string>((done, fail) => {
    const lines = createInterface({ input: child.stdout });
    lines.once("line", (line) => done(line.trim()));
    child.once("exit", (code) =>
      fail(new Error(`the Python server exited (${code}) before it listened`)),
    );
  });

  return {
    url,
    server: {
      close(cb?: () => void): void {
        child.once("exit", () => {
          if (answers) answers.server.close(() => cb?.());
          else cb?.();
        });
        child.stdin.end(); // the server stops when stdin closes
      },
    },
  };
}
