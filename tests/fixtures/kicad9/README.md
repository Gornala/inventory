# KiCad 9 fixture

`Arduino_Pro_Mini.kicad_sch` is copied verbatim from the project templates that ship with KiCad
(`share/kicad/template/Arduino_Pro_Mini/`). It is a genuine KiCad-authored schematic in the **KiCad 9
file format** — `version 20250114`, `generator_version "9.0"` — with 11 placed symbols carrying real
references (`J7`, `J8`, …), which is what the field writer needs to exercise.

It is here because the two formats disagree about exactly the thing a field writer has to get right:

| | where a hidden field says so |
| --- | --- |
| KiCad 9 (`20250114`) | `(property … (effects (font …) (hide yes)))` |
| KiCad 10 (`20260306`) | `(property … (hide yes) (show_name no) …)` |

Every field-writing test runs against both, so an inserted field takes its shape from the file in
front of it rather than from a table of dialects this repo would have to keep up to date.

KiCad 8 (`version 20231120`) is **not** covered: no genuine KiCad 8 file was available on this
machine, and a hand-written one would only prove that the test author and the implementation share
an assumption. The insertion path copies whatever the file does, so it should be indifferent — but
"should be" is not evidence, and this note is here instead of a passing test that means nothing.
