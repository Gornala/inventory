import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { dirname, resolve as resolvePath } from "node:path";

import { page } from "./page.js";
import { dirtyFiles } from "../adapters/git.js";
import {
  applyFieldWrite,
  applyValueRewrite,
  planFieldWrite,
  planValueRewrite,
  type RewriteRequest,
} from "../adapters/kicad/schematic-edit.js";
import {
  readAssignments,
  readCatalog,
  writeAssignments,
  writeCatalog,
} from "../adapters/store/inventory.js";
import { listOrderFiles, writeOrderFiles } from "../adapters/export/orders.js";
import { chooseFolder, type FolderChoice } from "../adapters/os/folder.js";
import { setBuyChoice } from "../adapters/store/buy.js";
import { clearSolved, setSolved } from "../adapters/store/solved.js";
import { applyAdopt, planAdopt } from "../core/inventory/adopt.js";
import { fieldsToWrite } from "../core/inventory/fields.js";
import { planOrder } from "../core/inventory/order.js";
import { assignPart, setSupplier, unassign } from "../core/inventory/resolve.js";
import { createReportCache, footprintDetail, type ReportOptions } from "../report.js";

export type ServerOptions = ReportOptions & {
  port?: number;
  /**
   * How "where should these go?" gets asked. The machine's own folder dialog,
   * unless something stands in for it — which is what a test does, because a
   * CI runner has no desktop to put a modal on and a test that opened one on a
   * developer's screen would be a test nobody runs twice.
   */
  chooseFolder?: (start: string) => Promise<FolderChoice>;
};

/**
 * Identifies this build of the page. The browser holds one copy of the script
 * for as long as the tab is open and only ever re-renders it from JSON, so a
 * rebuilt UI would otherwise reach a tab that was already open never — the
 * page stamps itself with this and reloads when the report reports another.
 */
const build = createHash("sha1").update(page).digest("hex").slice(0, 12);
const html = page.replace("__KINV_BUILD__", build);

/**
 * The write endpoints settle findings and edit schematics, so a page on some
 * other origin must not be able to reach them. Any web page can make a *simple*
 * cross-origin POST without a preflight; it cannot set a custom header, and if
 * it sets `Origin` the browser sends it. Requiring the header and rejecting a
 * foreign `Origin` closes both doors, and neither costs the real page anything.
 */
function sameOrigin(req: IncomingMessage): boolean {
  if (req.headers["x-kinv"] !== "1") return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).hostname === "127.0.0.1" || new URL(origin).hostname === "localhost";
  } catch {
    return false;
  }
}

/**
 * Where the per-supplier files go *until you say otherwise*: beside the board,
 * not in whatever directory the server happened to be started from. The page
 * shows the path, so there is nothing to guess about which `order.digikey.csv`
 * you are looking at.
 */
function exportDir(project: string): string {
  return dirname(resolvePath(project));
}

/**
 * A directory you picked, checked before anything is written into it.
 *
 * The page can name any directory on this machine, which is a widening of what
 * the server writes and is the entire point of the ask — it is your machine and
 * your dialog. What it will not do is invent the directory: a typo in a typed
 * path should be a sentence you can read, not a new folder somewhere odd.
 */
function usableDir(dir: string): string {
  const path = resolvePath(dir);
  if (!existsSync(path)) throw new Error(`no such directory: ${path}`);
  if (!statSync(path).isDirectory()) throw new Error(`not a directory: ${path}`);
  return path;
}

/** A JSON body is whatever the caller sent; only strings are taken as strings. */
function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    // A local instrument still does not need an unbounded buffer.
    if (size > 1_000_000) throw new Error("request too large");
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
 * Binds to 127.0.0.1 only. This serves a live view of files on disk; it is a
 * local instrument, not something to expose on a network.
 */
export async function startUiServer(
  project: string,
  options: ServerOptions = {},
): Promise<{ server: Server; url: string }> {
  const getReport = createReportCache(project, options);
  /**
   * Where the last export went, and where the next one starts from.
   *
   * Held for as long as the server runs and no longer: a directory you picked
   * once is a convenience, not a decision about the board, and it has no
   * business in `.kinv/` where it would travel to another machine by git and
   * name a path that does not exist there.
   */
  let exportTo = exportDir(project);
  const askWhere = options.chooseFolder ?? chooseFolder;
  /**
   * Whether a folder dialog is already open.
   *
   * One dialog is a question; four stacked on top of each other are a mess to
   * clear up, and pressing export again is exactly what you do when the first
   * one has not surfaced yet. The second press says so instead of spawning.
   */
  let picking = false;

  const server = createServer((req, res) => {
    const url = req.url ?? "/";

    if (url === "/" || url.startsWith("/?")) {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        // It is a live view of files on disk; a cached copy is a wrong one.
        "cache-control": "no-store",
      });
      res.end(html);
      return;
    }

    if (url.startsWith("/api/footprint")) {
      const reference = new URL(url, "http://localhost").searchParams.get("ref") ?? "";
      try {
        const detail = footprintDetail(project, reference);
        if (!detail) {
          res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
          res.end(`footprint not found in any library: ${reference}`);
          return;
        }
        res.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        });
        res.end(JSON.stringify(detail));
      } catch (err) {
        res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        res.end(err instanceof Error ? err.message : String(err));
      }
      return;
    }

    if (url.startsWith("/api/exports")) {
      try {
        const dir = exportTo;
        res.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        });
        res.end(JSON.stringify({ dir, files: listOrderFiles(dir) }));
      } catch (err) {
        res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        res.end(err instanceof Error ? err.message : String(err));
      }
      return;
    }

    if (url.startsWith("/api/report")) {
      getReport()
        .then((report) => {
          res.writeHead(200, {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
          });
          res.end(JSON.stringify({ ...report, build }));
        })
        .catch((err: unknown) => {
          res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
          res.end(err instanceof Error ? err.message : String(err));
        });
      return;
    }

    if (
      url.startsWith("/api/solved") ||
      url.startsWith("/api/rewrite") ||
      url.startsWith("/api/assign") ||
      url.startsWith("/api/supplier") ||
      url.startsWith("/api/order") ||
      url.startsWith("/api/fields") ||
      url.startsWith("/api/adopt") ||
      url.startsWith("/api/buy")
    ) {
      const json = (status: number, body: unknown): void => {
        res.writeHead(status, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        });
        res.end(JSON.stringify(body));
      };

      if (req.method !== "POST") return json(405, { error: "POST only" });
      if (!sameOrigin(req)) return json(403, { error: "not from this page" });

      readJson(req)
        .then((body) => {
          const b = body as Record<string, unknown>;

          if (url.startsWith("/api/solved/reset")) {
            clearSolved(project);
            return json(200, { ok: true });
          }
          if (url.startsWith("/api/solved")) {
            const id = str(b["id"]);
            const signature = str(b["signature"]);
            if (id === "") return json(400, { error: "no finding id" });
            setSolved(
              project,
              { id, signature, at: new Date().toISOString() },
              b["solved"] !== false,
            );
            return json(200, { ok: true });
          }

          if (url.startsWith("/api/buy")) {
            // Which side of the list a part sits on, and nothing else: no
            // schematic is touched and no catalog entry is invented.
            const key = str(b["key"]);
            if (key === "") return json(400, { error: "no part key" });
            setBuyChoice(project, key, b["buy"] === true);
            return json(200, { ok: true, key, buy: b["buy"] === true });
          }

          if (url.startsWith("/api/supplier")) {
            const key = str(b["key"]);
            if (key === "") return json(400, { error: "no part key" });
            try {
              const result = setSupplier(
                key,
                { supplier: str(b["supplier"]), orderNumber: str(b["orderNumber"]) },
                readCatalog(),
                readAssignments(),
              );
              writeCatalog(result.catalog);
              return json(200, { ok: true, part: result.part });
            } catch (err) {
              return json(400, { error: err instanceof Error ? err.message : String(err) });
            }
          }

          if (url.startsWith("/api/order/where")) {
            // The OS dialog, opened on the machine the server runs on — which
            // is the machine the browser runs on. It blocks until you answer,
            // so this request does too; the page keeps polling meanwhile.
            if (picking) return json(200, { status: "busy" });
            picking = true;
            return void askWhere(str(b["start"]) || exportTo)
              .then((choice) => {
                if (choice.status !== "chosen") return json(200, choice);
                try {
                  exportTo = usableDir(choice.dir);
                  return json(200, { status: "chosen", dir: exportTo });
                } catch (err) {
                  return json(400, { error: err instanceof Error ? err.message : String(err) });
                }
              })
              .catch((err: unknown) => {
                json(500, { error: err instanceof Error ? err.message : String(err) });
              })
              .finally(() => {
                picking = false;
              });
          }

          if (url.startsWith("/api/order")) {
            // The one write here that is not a decision: the quantity is
            // placements x boards, and the boards are the number you typed.
            const boards = Math.max(1, Math.floor(Number(b["boards"]) || 1));
            // A directory the page names — from the dialog, or typed into the
            // box that stands in for it where there is no dialog to open.
            const asked = str(b["dir"]);
            if (asked !== "") {
              try {
                exportTo = usableDir(asked);
              } catch (err) {
                return json(400, { error: err instanceof Error ? err.message : String(err) });
              }
            }
            return void getReport()
              .then((report) => {
                const plan = planOrder(report.parts, report.resolutions, boards);
                const dir = exportTo;
                // Quantity and part number only: the reference column is a
                // column the upload form did not ask for. `kinv order
                // --reference` puts it back for a form that wants it.
                const files = writeOrderFiles(plan, dir, { reference: false, header: true });
                json(200, {
                  ok: true,
                  boards,
                  dir,
                  files,
                  noSupplier: plan.noSupplier.length,
                  unresolved: plan.unresolved.length,
                });
              })
              .catch((err: unknown) => {
                json(500, { error: err instanceof Error ? err.message : String(err) });
              });
          }

          if (url.startsWith("/api/fields")) {
            // Out to the schematic: the MPN and vendor onto the symbols, so the
            // work survives without this tool and a copied symbol brings it.
            return void getReport()
              .then((report) => {
                const entries = fieldsToWrite(report.parts, report.resolutions);
                const plan = planFieldWrite(
                  project,
                  entries.map((e) => ({ refs: e.refs, valueIsOneOf: e.values, fields: e.fields })),
                );
                // The guard is about the diff, not your working tree: after
                // this runs, `git diff` should show only what the tool did.
                plan.dirty = dirtyFiles(plan.files.map((f) => f.path));
                if (url.startsWith("/api/fields/plan"))
                  return json(200, { ...plan, entries: entries.length });
                try {
                  json(200, { ...applyFieldWrite(plan), plan });
                } catch (err) {
                  json(409, { error: err instanceof Error ? err.message : String(err) });
                }
              })
              .catch((err: unknown) => {
                json(500, { error: err instanceof Error ? err.message : String(err) });
              });
          }

          if (url.startsWith("/api/adopt")) {
            // Back in from the schematic: what the symbols already say, into
            // the catalog. A plan first, always — reading a file is not
            // permission to write a catalog that outlives the board.
            return void getReport()
              .then((report) => {
                const plan = planAdopt(report.parts, readCatalog(), readAssignments());
                if (url.startsWith("/api/adopt/plan")) return json(200, plan);
                const result = applyAdopt(plan, readCatalog(), readAssignments());
                writeCatalog(result.catalog);
                writeAssignments(result.assignments);
                json(200, {
                  ok: true,
                  adopted: result.adopted.length,
                  filled: result.filled.length,
                  conflicts: plan.entries.filter((e) => e.status === "conflict").length,
                });
              })
              .catch((err: unknown) => {
                json(500, { error: err instanceof Error ? err.message : String(err) });
              });
          }

          if (url.startsWith("/api/assign")) {
            const key = str(b["key"]);
            if (key === "") return json(400, { error: "no part key" });

            if (url.startsWith("/api/assign/clear")) {
              writeAssignments(unassign(key, readAssignments()));
              return json(200, { ok: true });
            }

            try {
              const result = assignPart(
                key,
                {
                  mpn: str(b["mpn"]),
                  manufacturer: str(b["manufacturer"]),
                  supplier: str(b["supplier"]),
                  orderNumber: str(b["orderNumber"]),
                  datasheet: str(b["datasheet"]),
                  notes: str(b["notes"]),
                },
                readCatalog(),
                readAssignments(),
              );
              // The catalog first: an assignment pointing at a part that is not
              // there yet is the one order the two writes must not happen in.
              writeCatalog(result.catalog);
              writeAssignments(result.assignments);
              return json(200, { ok: true, part: result.part });
            } catch (err) {
              return json(400, { error: err instanceof Error ? err.message : String(err) });
            }
          }

          const groups = Array.isArray(b["groups"])
            ? (b["groups"] as { from?: unknown; refs?: unknown }[]).map((g) => ({
                from: str(g.from),
                refs: Array.isArray(g.refs)
                  ? (g.refs as unknown[]).map(str).filter((r) => r !== "")
                  : [],
              }))
            : [];
          const request: RewriteRequest = { groups, to: str(b["to"]) };
          if (groups.every((g) => g.refs.length === 0) || request.to === "") {
            return json(400, { error: "nothing to rewrite" });
          }

          const plan = planValueRewrite(project, request);
          if (url.startsWith("/api/rewrite/plan")) return json(200, plan);

          try {
            return json(200, { ...applyValueRewrite(plan), plan });
          } catch (err) {
            return json(409, { error: err instanceof Error ? err.message : String(err) });
          }
        })
        .catch((err: unknown) => {
          json(400, { error: err instanceof Error ? err.message : String(err) });
        });
      return;
    }

    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
  });

  const port = options.port ?? 7373;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });

  const address = server.address();
  const boundPort = typeof address === "object" && address !== null ? address.port : port;
  return { server, url: `http://127.0.0.1:${boundPort}/` };
}
