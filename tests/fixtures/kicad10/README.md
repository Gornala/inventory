# KiCad 10 fixtures

Snapshots taken from the reference board — `transformer_test`, a real resonant-power-supply design:
13 sheets, 646 placed symbols, 100 grouped BOM lines, 68 distinct footprints. It is the project this
tool is developed against precisely because it is messy enough to break things.

| File | Provenance |
| --- | --- |
| `transformer_test.bom.csv` | `kicad-cli 10.0 sch export bom --fields 'Reference,Value,Footprint,Datasheet,Description,${QUANTITY},${DNP}' --group-by 'Value,Footprint'` |
| `custom-fields.bom.csv` | the same export with the board's nine custom fields named in `--fields` too (`Capacity,capacity,freq,Inductivity,MANUFACTURER,MAXIMUM_PACKAGE_HEIGHT,PARTREV,STANDARD,Volrtage`), cut to the ten rows that carry one plus the two plain capacitor lines. Taken later than the file above, off a board that had moved on — so it is the fixture for *field* behaviour and never for board totals. |
| `footprints/*.kicad_mod` | four KiCad 10 library footprints, copied verbatim: a chip resistor, a QFN-56 with an exposed pad and paste sub-pads, a SOIC-8 and a through-hole pin socket |
| `encoder.kicad_sch` | one sheet, copied verbatim — KiCad 10 s-expression syntax (`version 20260306`, `generator_version "10.0"`) |

Known defects in the source design, kept deliberately — these are the expected findings, not noise:

- `100n` (54×) and `100nF` (4×) are the same part on two BOM lines; likewise `10u` / `10uF`.
- `5K6` (1×) and `5k6` (5×) differ only in letter case.
- `10k` appears in 0402 (19×) and 0603 (3×); `1k` in 0402 (12×) and 0603 (2×).
- 20 resistors (R2004-R2007, R3004-R3007, R4007-R4014, R5004-R5007) carry `Capacitor_SMD` footprints.
- Milliohm shunts are spelled both `0.1` (1206) and `10m` / `2m` / `5m` (2512).
- Bare values `0`, `1`, `4`, `10` with no unit.
- Custom fields are inconsistent: `Volrtage` (typo, 12×), `capacity` vs `Capacity` — visible in
  `custom-fields.bom.csv`, and not in the export above, which never asked for them.

The `DNP` column reads `"Nicht bestücken"` — **kicad-cli localises generated column values**, so DNP
must never be detected by string comparison. Note this file is UTF-8 with non-ASCII content; it also
exercises encoding handling.
