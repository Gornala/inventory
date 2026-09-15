import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseCsvRecords } from "../../src/adapters/kicad/csv.js";
import { listOrderFiles } from "../../src/adapters/export/orders.js";
import {
  readAssignments,
  readCatalog,
  writeAssignments,
  writeCatalog,
} from "../../src/adapters/store/inventory.js";
import { buildProgram } from "../../src/cli/program.js";

async function run(...argv: string[]): Promise<{ out: string; code: number | undefined }> {
  const lines: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.join(" "));
  });
  process.exitCode = undefined;
  try {
    await buildProgram().parseAsync(["node", "kinv", ...argv]);
    return { out: lines.join("\n"), code: process.exitCode as number | undefined };
  } finally {
    log.mockRestore();
    process.exitCode = undefined;
  }
}

describe("the part you bought against the pads on the board", () => {
  let dir: string;
  let project: string;
  let sheet: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kinv-pkg-"));
    project = join(dir, "board.bom.csv");
    sheet = join(dir, "parts.csv");
    writeFileSync(
      project,
      [
        '"Reference","Value","Footprint","QUANTITY","DNP"',
        '"R1,R2","10k","Resistor_SMD:R_0402_1005Metric","2",""',
      ].join("\n"),
      "utf8",
    );
    writeCatalog([]);
    writeAssignments([]);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const buy = async (pkg: string): Promise<void> => {
    writeFileSync(
      sheet,
      [
        "key,value,package,used,mpn,manufacturer,supplier,order_number,part_package,refs",
        `R|10k|0402,10k,0402,2,RC0603FR-0710KL,Yageo,digikey,311-ND,${pkg},R1 R2`,
      ].join("\n"),
      "utf8",
    );
    await run("order", project, "--import", sheet, "--out", dir);
  };

  it("fails the check when the part is the wrong size for the pads", async () => {
    // the schematic cannot say this: only the catalog knows what you bought
    await buy("0603");
    const { out, code } = await run("check", project);

    expect(out).toContain("package-mismatch");
    expect(out).toContain("will not fit the pads");
    expect(out).toContain("1 errors");
    expect(code).toBe(1);
  });

  it("passes when they agree, in either notation", async () => {
    await buy("1005");
    const { out, code } = await run("check", project);
    expect(out).not.toContain("package-mismatch");
    expect(out).toContain("0 errors");
    expect(code).toBeUndefined();
  });

  it("stays quiet until you record a package", async () => {
    await buy("");
    const { out, code } = await run("check", project);
    expect(out).not.toContain("package-mismatch");
    expect(code).toBeUndefined();
  });
});

describe("kinv order", () => {
  let dir: string;
  let project: string;
  let sheet: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kinv-order-"));
    project = join(dir, "board.bom.csv");
    sheet = join(dir, "parts.csv");
    writeFileSync(
      project,
      [
        '"Reference","Value","Footprint","QUANTITY","DNP"',
        '"R1,R2,R3","10k","Resistor_SMD:R_0402_1005Metric","3",""',
        '"C1","100n","Capacitor_SMD:C_0603_1608Metric","1",""',
        '"U1","RP2040","Package_DFN_QFN:QFN-56-1EP_7x7mm_P0.4mm_EP3.2x3.2mm","1",""',
      ].join("\n"),
      "utf8",
    );
    writeCatalog([]);
    writeAssignments([]);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  describe("the sheet you fill in", () => {
    it("lists every part with the two columns left empty", async () => {
      const { out } = await run("order", project, "--template", sheet);
      expect(out).toContain("3 parts");
      expect(out).toContain("supplier");

      const rows = parseCsvRecords(readFileSync(sheet, "utf8"));
      expect(rows).toHaveLength(3);
      expect(Object.keys(rows[0] as object)).toEqual([
        "key",
        "value",
        "package",
        "used",
        "mpn",
        "manufacturer",
        "supplier",
        "order_number",
        "part_package",
        "refs",
      ]);
      // the tool's half is filled, yours is not
      const resistor = rows.find((r) => r["key"] === "R|10k|0402");
      expect(resistor?.["used"]).toBe("3");
      expect(resistor?.["refs"]).toBe("R1 R2 R3");
      expect(resistor?.["supplier"]).toBe("");
      expect(resistor?.["order_number"]).toBe("");
    });

    it("brings back what the catalog already knows", async () => {
      await run("order", project, "--template", sheet);
      const filled = readFileSync(sheet, "utf8").replace(
        "R|10k|0402,10k,0402,3,,,,,",
        "R|10k|0402,10k,0402,3,RC0402FR-0710KL,Yageo,digikey,311-10.0KLRCT-ND,",
      );
      writeFileSync(sheet, filled, "utf8");
      await run("order", project, "--import", sheet);

      // a second template is prefilled, so the next board asks nothing
      await run("order", project, "--template", sheet);
      const rows = parseCsvRecords(readFileSync(sheet, "utf8"));
      const resistor = rows.find((r) => r["key"] === "R|10k|0402");
      expect(resistor?.["mpn"]).toBe("RC0402FR-0710KL");
      expect(resistor?.["supplier"]).toBe("digikey");
      expect(resistor?.["order_number"]).toBe("311-10.0KLRCT-ND");
    });
  });

  describe("reading it back", () => {
    const fill = (...rows: string[]): void => {
      writeFileSync(
        sheet,
        ["key,value,package,used,mpn,manufacturer,supplier,order_number,refs", ...rows].join("\n"),
        "utf8",
      );
    };

    it("puts what you typed into the catalog", async () => {
      fill(
        "R|10k|0402,10k,0402,3,RC0402FR-0710KL,Yageo,digikey,311-10.0KLRCT-ND,R1 R2 R3",
        "C|100n|0603,100n,0603,1,CL10B104KB8NNNC,Samsung,digikey,1276-1000-1-ND,C1",
      );
      await run("order", project, "--import", sheet);

      expect(readCatalog().map((p) => p.supplier)).toEqual(["digikey", "digikey"]);
      expect(
        readCatalog()
          .map((p) => p.orderNumber)
          .sort(),
      ).toEqual(["1276-1000-1-ND", "311-10.0KLRCT-ND"]);
      expect(readAssignments()).toHaveLength(2);
    });

    it("refuses a key the board does not have", async () => {
      // an old export, or a column sorted out of line, must not write part
      // numbers into the catalog under names nothing will look up
      fill("R|10k|0603,10k,0603,3,WRONG-1,,digikey,999-ND,R9");
      const { out } = await run("order", project, "--import", sheet);

      expect(out).toContain("NOT IMPORTED (1)");
      expect(out).toContain("no part on this board has this key");
      expect(readCatalog()).toEqual([]);
    });

    it("refuses a supplier with no part number to go with it", async () => {
      fill("R|10k|0402,10k,0402,3,,,digikey,311-10.0KLRCT-ND,R1 R2 R3");
      const { out } = await run("order", project, "--import", sheet);
      expect(out).toContain("a supplier was given but no MPN");
      expect(readCatalog()).toEqual([]);
    });

    it("skips a row you left entirely alone", async () => {
      fill("R|10k|0402,10k,0402,3,,,,,R1 R2 R3");
      const { out } = await run("order", project, "--import", sheet);
      expect(out).toContain("0 parts read");
      expect(out).not.toContain("NOT IMPORTED");
    });
  });

  describe("the files a supplier eats", () => {
    beforeEach(async () => {
      writeFileSync(
        sheet,
        [
          "key,value,package,used,mpn,manufacturer,supplier,order_number,refs",
          "R|10k|0402,10k,0402,3,RC0402FR-0710KL,Yageo,digikey,311-10.0KLRCT-ND,R1 R2 R3",
          "C|100n|0603,100n,0603,1,CL10B104KB8NNNC,Samsung,digikey,1276-1000-1-ND,C1",
          "U|RP2040|QFN-56-1EP_7x7mm_P0.4mm_EP3.2x3.2mm,RP2040,QFN-56-1EP_7x7mm_P0.4mm_EP3.2x3.2mm,1,RP2040,Raspberry Pi,lcsc,C2040,U1",
        ].join("\n"),
        "utf8",
      );
      await run("order", project, "--import", sheet);
    });

    it("writes one file per supplier: a quantity and their part number", async () => {
      await run("order", project, "--out", dir);

      const digikey = parseCsvRecords(readFileSync(join(dir, "order.digikey.csv"), "utf8"));
      expect(digikey).toHaveLength(2);
      // exactly two columns — a form that was not expecting a third is a
      // form that rejects the upload
      expect(digikey[0]).toEqual({ Quantity: "1", "Part Number": "1276-1000-1-ND" });

      const lcsc = parseCsvRecords(readFileSync(join(dir, "order.lcsc.csv"), "utf8"));
      expect(lcsc).toHaveLength(1);
      expect(lcsc[0]?.["Part Number"]).toBe("C2040");
    });

    it("multiplies by the number of boards and nothing else", async () => {
      // no stock subtraction, no spares, no rounding to a pack: 3 per board × 5
      await run("order", project, "--out", dir, "--boards", "5");
      const rows = parseCsvRecords(readFileSync(join(dir, "order.digikey.csv"), "utf8"));
      expect(rows.find((r) => r["Part Number"] === "311-10.0KLRCT-ND")?.["Quantity"]).toBe("15");
    });

    it("adds the reference column back for a form that wants it", async () => {
      await run("order", project, "--out", dir, "--reference");
      const withRef = parseCsvRecords(readFileSync(join(dir, "order.digikey.csv"), "utf8"));
      expect(withRef[0]).toEqual({
        Quantity: "1",
        "Part Number": "1276-1000-1-ND",
        "Customer Reference": "C|100n|0603",
      });
    });

    it("can leave the header out too, for a form that wants bare lines", async () => {
      await run("order", project, "--out", dir, "--no-header");
      const text = readFileSync(join(dir, "order.digikey.csv"), "utf8");
      expect(text).toBe("1,1276-1000-1-ND\r\n3,311-10.0KLRCT-ND\r\n");
    });

    it("says which parts have nobody to buy them from", async () => {
      writeCatalog(readCatalog().map((p) => (p.supplier === "lcsc" ? { ...p, supplier: "" } : p)));
      const { out } = await run("order", project, "--out", dir);
      expect(out).toContain("NO SUPPLIER YET (1)");
      expect(out).toContain("RP2040");
    });

    it("counts a headerless file it did not write the header of", async () => {
      // the panel in the UI counts the files on disk rather than remembering
      // what wrote them, and --no-header is a real option
      await run("order", project, "--out", dir, "--no-header");
      const listed = listOrderFiles(dir);
      expect(listed.map((f) => f.name)).toEqual(["order.digikey.csv", "order.lcsc.csv"]);
      expect(listed[0]).toMatchObject({ supplier: "digikey", lines: 2, pieces: 4 });
    });

    it("says which parts have no part number yet", async () => {
      writeAssignments(readAssignments().filter((a) => a.key !== "C|100n|0603"));
      const { out } = await run("order", project, "--out", dir);
      expect(out).toContain("NO PART NUMBER YET (1)");
      expect(out).toContain("C|100n|0603");
    });
  });
});
