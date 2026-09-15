import { describe, expect, it } from "vitest";

import { customFieldNames, projectFieldNames } from "../../src/adapters/kicad/fields.js";
import { fixture } from "../fixtures/index.js";

describe("finding the fields a board actually uses", () => {
  it("reads the designer's own field names off a symbol", () => {
    const text = `
      (symbol (lib_id "Device:C")
        (property "Reference" "C1")
        (property "Value" "100n")
        (property "Volrtage" "50V")
        (property "capacity" "22uF"))`;
    expect(customFieldNames(text).sort()).toEqual(["Volrtage", "capacity"]);
  });

  it("leaves out the fields KiCad owns", () => {
    // ki_* is library metadata, Sim.* belongs to the simulator, Sheetname and
    // Sheetfile are properties of a sheet, and the five named columns plus the
    // generated ones are requested separately
    const text = [
      "ki_keywords",
      "ki_fp_filters",
      "ki_locked",
      "Sim.Device",
      "Sim.Pins",
      "Sheetname",
      "Sheetfile",
      "Reference",
      "Value",
      "Footprint",
      "Datasheet",
      "Description",
      "DNP",
      "QUANTITY",
    ]
      .map((name) => `(property "${name}" "x")`)
      .join("\n");
    expect(customFieldNames(text)).toEqual([]);
  });

  it("refuses a name that would break the --fields list", () => {
    // the list is comma-separated and ${...} means a generated column, so a
    // field named either way has to be dropped rather than corrupt the export
    const text =
      '(property "Rating, max" "x") (property "${QUANTITY}" "x") (property "Rating" "x")';
    expect(customFieldNames(text)).toEqual(["Rating"]);
  });

  it("reads past an escaped quote rather than splitting the name on it", () => {
    // the name itself cannot survive --fields, so it is dropped — but the
    // reader has to consume it whole, or the next field is read from the middle
    // of this one
    expect(customFieldNames('(property "1\\" pitch" "x") (property "Rating" "x")')).toEqual([
      "Rating",
    ]);
  });

  it("finds nothing to add on a sheet with no custom fields", () => {
    // the fixture sheet carries only the five standard properties
    expect(projectFieldNames(fixture("kicad10", "encoder.kicad_sch"))).toEqual([]);
  });

  it("never throws when the schematics cannot be read", () => {
    expect(projectFieldNames("no/such/place/board.kicad_sch")).toEqual([]);
  });
});
