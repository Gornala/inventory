import type { ComponentClass } from "./parse/refdes.js";
import type { Unit } from "./units.js";

/** One grouped line as it comes out of a KiCad BOM export. */
export type BomLine = {
  refs: string[];
  value: string;
  footprint: string;
  datasheet: string | undefined;
  description: string | undefined;
  /** Quantity as KiCad reported it; `refs.length` is the cross-check. */
  quantity: number;
  dnp: boolean;
  /** Any further exported columns, verbatim. */
  fields: Record<string, string>;
  /** Where this line came from — project or sheet. */
  source: string;
};

/** A part need, in comparable form. */
export type Spec =
  | {
      kind: "generic";
      cls: ComponentClass;
      magnitude: number;
      unit: Unit;
      pkg: string | undefined;
      variant: string | undefined;
    }
  | {
      kind: "specific";
      cls: ComponentClass;
      designator: string;
      pkg: string | undefined;
    };

export type IssueCode =
  | "missing-footprint"
  | "placeholder-value"
  | "unparsable-value"
  | "ambiguous-bare-value"
  | "class-mismatch"
  | "quantity-mismatch"
  | "pre-resolved"
  /** The part you buy is not the size of the pads on the board. */
  | "package-mismatch";

/**
 * `error` is a defect, `warning` needs a human decision, `info` is worth
 * knowing and is not a complaint. A report that calls everything a problem
 * gets switched off.
 */
export type Severity = "error" | "warning" | "info";

export type Issue = {
  code: IssueCode;
  severity: Severity;
  message: string;
  refs: string[];
};

export type AnalyzedLine = {
  line: BomLine;
  spec: Spec;
  key: string;
  /**
   * Why this line is not a purchasable part, if it is not. Test points and
   * mounting holes are features of the board, not things you buy — unless the
   * designer named an actual part, which makes them purchases again.
   */
  excluded: string | undefined;
  /**
   * A passive that is already a specific part. Not an accident: high-power,
   * unusually small or high-precision passives get chosen early because the
   * design is built around them. Step 2 has nothing to do for these.
   */
  resolved: boolean;
  issues: Issue[];
};
