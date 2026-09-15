# kinv — KiCad BOM → consolidated inventory → a basket per supplier

A small TypeScript tool that walks a KiCad BOM through three stages:

1. **Consolidate** — turn a messy list of generic parts into a short, deliberate list
   ("do I really need 10k in 0402, 0603 _and_ 0805?"), updating live while you edit in KiCad.
2. **Resolve** — replace each generic line with a concrete, buyable part: an MPN, and the
   supplier and ordering number you chose for it.
3. **Order** — count what the boards need and hand you one upload file per supplier. The
   quantities are arithmetic you can check; every decision in this step is yours.

Status: **in service.** M4, M4b, M5b and M6 have landed and the tool is now being used on real
boards rather than built. `kinv bom`, `kinv check`, `kinv fp`, `kinv watch`, `kinv ui`, `kinv init`,
`kinv resolve`, `kinv fields write`, `kinv fields read` and `kinv order` all work end to end on a
real board: canonical keys, the consolidation report, footprint measurement and verification, a live
terminal watch, a live web view, and a git-diffable catalog of the real part each generic is bought
as. All three steps are in the UI: one **Parts** table where the MPN, the vendor and their ordering
number are typed on the same row as the part they belong to, one button that writes the upload files
beside the project, and two that carry the decisions out to the symbols and back again.

**Step 1 is complete and usable, and step 2 works offline** — you type the MPNs, the supplier and
their ordering number, and the tool turns that into one upload file per supplier without ever
deciding a quantity for you. The UI writes as well as reads: a finding can be settled, a duplicated
spelling unified in the schematic itself, and the whole catalog rebuilt from a board that carries its
own `MPN` and `Supplier` fields. 410 tests. Developed against a real board, see §10.

Development is **paused between rounds**. What the next boards turn up goes in
[IMPROVEMENTS.md](IMPROVEMENTS.md), and the round after that works from that list. The scope is now
closed at both ends: the tool stops at "what does this board need, and where do I buy it", and
tracking what is on the shelf is somebody else's job (§8.3).

## The Python version (branch `python-port`, in progress)

A standard-library-only port, so kinv runs without Node or npm — on any Python 3.11+, including
the one KiCad ships:

```
python -m kinv ui <project>
& "C:\Program Files\KiCad\10.0\bin\python.exe" -m kinv ui <project>   # PowerShell: & runs a quoted path
```

Run it from this directory. The page is the same page, byte for byte, extracted from
`src/ui/page.ts`; only the server behind it is Python.

**Ported and verified:** everything behind `kinv ui` — parsing, consolidation, footprint measurement
and checks, the catalog and `.kinv` state, the report, the server and every endpoint, the schematic
field write and read-back, spelling rewrites, the order export and the folder dialog.

**Not ported yet:** the other commands — `check`, `bom`, `fp`, `watch`, `order` (with `--template` and
`--import`), `resolve`, `fields`, `init` — and their terminal rendering. Until then, use the TypeScript
version for those.

**How it is verified:** not by reading the code side by side. `scripts/golden/*.ts` record the
TypeScript version's answers as exact JSON text, and `pytests/` compare the Python output as text:
~21,000 JavaScript number and collation cases, the reference board whole, 1,500 synthetic lines, 45
footprints from the installed libraries, and the catalog files to the byte. The 99 browser tests in
`tests/ui` run unchanged against the Python server (`npx vitest run -c vitest.python.config.ts`). On
the live reference project through `kicad-cli`, the two reports are identical to the character.

```
python -m unittest discover -s pytests -t .        # nothing to install
npx vitest run -c vitest.python.config.ts          # the browser suite, against Python
```

Keys, the catalog and `.kinv` files are byte-identical between the versions, so both can share one
`~/.kinv` while the port finishes.

---

## 1. Why a tool at all

Everything here is doable by hand in a spreadsheet. The parts that hurt, and that a tool fixes:

| Pain                                                                   | What the tool does                                             |
| ---------------------------------------------------------------------- | -------------------------------------------------------------- |
| `10k`, `10K`, `10 kOhm`, `10k 1%` are the same part, spelled four ways | canonical parsing into a structured spec                       |
| The same value in three packages, noticed only at ordering time        | grouping by value across packages, with a consolidation report |
| Re-exporting the BOM after every schematic edit                        | file watcher → report refreshes on save                        |
| "Do I already own these?"                                              | on-hand inventory subtracted from the order                    |
| 40 parts × price breaks × MOQ                                          | a solver that picks order quantities                           |
| Typing 32 part numbers into a distributor's website                    | one upload file per supplier                                   |

## 2. Scope

**In scope (v1)**

- Read KiCad BOMs (CSV export and the netlist XML intermediate format).
- Parse `Value` + `Footprint` into a canonical spec for passives; pass specific parts through as-is.
- Consolidation analysis plus a live-updating report.
- Footprint verification: measure the assigned `.kicad_mod` and cross-check it against the footprint
  name, the symbol's pins and the chosen part's package attributes.
- A git-tracked catalog: generic spec → chosen concrete part.
- On-hand inventory with manual adjustments.
- A part list you fill in with supplier and ordering number, and one upload file per supplier.

**Explicitly out of scope (v1)**

- Writing back anything except **symbol field values** (see §5, step 2b). Footprints, `lib_id`s,
  geometry, annotation and `.kicad_pcb` are never touched: a footprint change is trivial to write but
  the PCB already has that footprint placed, so the next "Update PCB from Schematic" swaps pads and
  can break routing. That decision belongs to a human in the PCB editor.
- Choosing a supplier for you, or looking one up. You record who sells a part and their ordering
  number; the tool groups the order by it. Any distributor works because none of them is special.
- Multi-user / server / auth. Single user, local files.
- Placing an actual order. The tool stops at "here is a cart / an upload file". Money is the human's job.

## 3. Concepts and data model

Everything hangs off one idea: the **canonical key**. It is the string that lets a schematic line, a
catalog entry and an order line find each other.

```
R|10k|0603|1%          ← generic, resolvable
C|100n|0603|X7R|50V    ← generic, resolvable
U|RP2040|QFN-56        ← specific, already a real part
```

```ts
// A line as it comes out of KiCad
type BomLine = {
  refs: string[]; // ["R1", "R4", "R7"]
  value: string; // "10k"  (raw, as typed)
  footprint: string; // "Resistor_SMD:R_0603_1608Metric"
  dnp: boolean;
  fields: Record<string, string>; // MPN, Tolerance, ... if the user maintains them
  source: string; // which project / sheet this came from
};

// The parsed, comparable form
type Spec =
  | { kind: "resistor"; ohms: number; package: Package; tolerance?: number; power?: number }
  | { kind: "capacitor"; farads: number; package: Package; dielectric?: string; voltage?: number }
  | { kind: "inductor"; henries: number; package: Package }
  | { kind: "specific"; designator: string; package?: Package }; // RP2040 & friends

// A real, buyable thing
type CatalogPart = {
  id: string; // stable local id
  mpn: string;
  manufacturer: string;
  supplier?: string; // who you buy it from
  orderNumber?: string; // and their ordering number
  spec: Spec; // which generic need it satisfies
  datasheet?: string;
  notes?: string;
};

// Step 2's output: the decision "this generic is bought as this part"
type Assignment = { key: CanonicalKey; partId: string; decidedAt: string; by: "user" | "rule" };

// What is on the shelf
type StockItem = { partId: string; qty: number; location?: string; updatedAt: string };
```

### Storage

Plain JSON files, written canonically (sorted keys, stable ordering) so that **`git diff` is the
audit log**:

```
~/.kinv/            # one catalog for every board; KINV_HOME moves it
  catalog.json      # concrete parts you know about
  assignments.json  # generic key -> part id   (step 2's decisions)

<board>/.kinv/
  solved.json       # findings settled on *this* schematic
```

The split is the answer to §8.4: a part chosen once should be reused on the next board, and what is
on the shelf belongs to the shelf — while "yes, 10k in two packages is deliberate **here**" belongs
to the board it is about.

No database, and now there will not be one: the catalog is a few hundred rows of decisions, and JSON
keeps it inspectable and diffable, which is worth more here than query speed. The thing that would
have justified a database — on-hand quantities, moving as parts are used — is out of scope (§8.3).

## 4. Architecture

```
src/
  core/           ← pure. no fs, no network, no clock. all the interesting logic.
    parse/        value + footprint → Spec        (10k, 4k7, 0R1, 100n, 4u7, 1µF)
    canonical/    Spec ↔ CanonicalKey, formatting
    consolidate/  grouping, "you use 10k in 3 packages" analysis
    footprint/    pad-list → measurements (pitch, count, spans, courtyard),
                  footprint-name parser, three-way cross-check rules
    order/        placements x boards, the fill-in sheet, grouping by supplier
  adapters/       ← everything impure, one folder per boundary
    kicad/        CSV + netlist-XML readers, project file watcher,
                  span-tracking s-expression lexer, field-value splicer (2b),
                  .kicad_mod reader + fp-lib-table resolution (2c)
    store/        JSON repositories (catalog / assignments / settled findings)
    export/       CSV writer, annotated footprint SVG
  cli/            ← command wiring, argument parsing, terminal rendering
  ui/             ← local web view: report assembly, mtime cache, http server
```

The rule that makes this testable: **`core/` is pure and imports nothing from `adapters/`.** Parsing
`4k7` and deciding an order quantity are the parts most likely to be wrong, and both are plain
functions from data to data. Network, disk and time live at the edges behind interfaces
(`DistributorClient`, `CatalogRepo`, `Clock`) that tests substitute freely.

### Stack

- TypeScript 5, ESM, Node ≥ 20 (developed on 23).
- CLI: `commander`, `@clack/prompts` for the interactive picking in step 2, `chalk` for output.
- Validation: `zod` — every file read and every API response is parsed through a schema, so a
  hand-edited `catalog.json` fails loudly at the boundary instead of silently 500 lines later.
- Tests: `vitest`, `fast-check` (property tests), `msw` (HTTP mocking).
- Lint/format: `eslint` + `prettier`. CI: GitHub Actions.

## 5. The three steps, concretely

### Step 1 — consolidate

```bash
kinv watch ./MyBoard.kicad_pro
```

Watches the project, re-reads the BOM on every save, and keeps a report on screen:

```
118 placements · 41 distinct lines · 27 distinct parts after consolidation

CONSOLIDATION OPPORTUNITIES
  10k         3 packages   0402 (R12)  0603 (R1,R4,R7,R9)  0805 (R22,R23)
              → standardise on 0603: −2 line items, −2 order lines
  100n 50V    2 dielectrics  X7R (C1..C8)  X5R (C14)
              → X7R covers both
  1k / 1.02k  values within 2%   R3=1k  R18=1.02k
              → likely unintentional

SINGLETONS (used once — candidates for removal or substitution)
  4.99k 0402 R31   ·   22p 0603 C20
```

Every finding is a suggestion _with the refs attached_, so you can jump straight to those refs in the
schematic editor. Rerun is automatic; nothing is written.

`kinv check` is the same analysis as a one-shot with an exit code, for CI or a pre-commit hook.

### Step 2 — resolve generics to real parts

```bash
kinv resolve ./MyBoard.kicad_pro                       # what is still unresolved
kinv order   ./MyBoard.kicad_pro --template parts.csv  # the sheet you fill in
kinv order   ./MyBoard.kicad_pro --import   parts.csv  # back into the catalog
```

Every part gets an MPN, a supplier and that supplier's ordering number — typed by you, in a
spreadsheet or one at a time. The choice lands in `assignments.json`, the part in `catalog.json`, and
because both are shared across boards, a part chosen once is never asked about again.

### Step 2b — keep the decisions in the schematic

```bash
kinv fields write ./MyBoard.kicad_pro          # dry run: shows a per-symbol diff
kinv fields write ./MyBoard.kicad_pro --apply
kinv fields read  ./MyBoard.kicad_pro          # dry run: what it would take back
kinv fields read  ./MyBoard.kicad_pro --apply
```

Once a generic key has a concrete part, the schematic should say so. `write` pushes `MPN`,
`Manufacturer`, `Supplier` and `Supplier#` into the symbols' fields, so that KiCad's _own_ BOM export
carries real part numbers and the schematic is self-documenting to someone who never runs this tool.
In the UI both directions are buttons on the **Parts** tab, each showing a plan before it writes
anything.

**`read` is the other half, and it is what makes the write worth doing.** Without it the catalog is
the only place the work exists: lose `~/.kinv`, or hand the project to someone else, and the board is
back to knowing nothing. With it the schematic is a real store — the fields go out, KiCad's BOM
export brings them back, and the catalog rebuilds itself from the board. It is also what makes
copying a symbol in KiCad worth something: the copy carries the fields, so the part it becomes
arrives already answered.

Three rules it does not bend:

- **It fills gaps and never overwrites.** A vendor you typed is a decision; a file does not get to
  replace it. Where the two disagree the catalog keeps its value and the disagreement is _reported_,
  not swallowed.
- **A part number the two disagree about is never resolved automatically.** One of them has moved on
  and only you know which, so the part is listed and left exactly as it was.
- **A merged disagreement is not a value.** When `100n` and `100nF` roll up into one part and their
  MPN fields differ, the field carries both spellings joined; importing either would be the tool
  making the choice step 2 exists to ask you for.

Assignments it creates are marked `by: "rule"`, not `by: "user"` — the tool read them out of a file,
and the audit log should not claim they were typed.

**Why this is safe to do and footprint edits are not.** A `.kicad_sch` is S-expression text and a
`(property "Value" "10k" …)` node is a leaf: nothing else in the file — not connectivity, not the
netlist, not ERC — references its text. Editing one is local and side-effect free.

**How.** Not parse-and-reserialize (that would reflow the whole file into an unreadable diff and
require reproducing KiCad's exact pretty-printer). Instead: a lexer that records the byte span of
every atom, then a **splice** — locate the `(symbol …)` block by **UUID** (never by reference
designator, which re-annotation renumbers), replace the property's value string, write every other
byte unchanged. Roughly 400 lines, most of it the lexer.

**What actually bites, and the answer to each:**

| Hazard                                                                                                                                                                                          | Mitigation                                                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Dialect drift — older KiCad writes `(id 4)` and a bare `hide`; KiCad 8+ dropped `id` and uses `(hide yes)` in `effects`; the reference board is `version 20260306` / `generator_version "10.0"` | emit per the file's `(version …)` header; only _inserting_ a field needs this, editing an existing one does not; one fixture per KiCad version |
| Schematic open in KiCad → next Ctrl+S silently reverts the write                                                                                                                                | refuse when KiCad's lock file is present next to the document, refuse on a dirty git tree, always leave a `.bak`                               |
| A newly inserted field needs an `(at x y)`                                                                                                                                                      | copy the Value property's position with an offset and always insert hidden — hidden fields' coordinates are cosmetically irrelevant            |
| Hierarchical sheets                                                                                                                                                                             | a property lives on the symbol in the sheet file, so an edit hits every instantiation of that sheet — usually intended, but stated in the diff |

**Field policy** is config, not hardcoded. `Value` may be left alone, or have the tolerance appended
(`10k` → `10k 1%`), or be regenerated from the catalog. The default is to leave `Value` alone and put
tolerance in a `Tolerance` field. Writable field names are an explicit allowlist; anything not on it
is never touched.

**The test that makes this trustworthy:** for every fixture, _parse → write with zero edits → bytes
identical to the input_, and _edit a field → revert it → original bytes back_. Held across KiCad 8, 9
and 10 fixtures, the splicer cannot eat a schematic. Per-edit-type golden diffs cover the rest.

(For context on the alternatives: KiCad's Python API is `pcbnew` only — there is no official
schematic scripting API — and KiCad 9+'s IPC API is board-focused so far. Direct file editing is the
practical path, not a shortcut around a supported one.)

### Step 2c — verify the footprint against the part

```bash
kinv fp measure "Package_DFN_QFN:QFN-56-1EP_7x7mm_P0.4mm_EP3.2x3.2mm"   # calipers on one footprint
kinv fp check ./MyBoard.kicad_pro                                        # cross-check the whole board
```

Wrong footprints are the expensive mistake in this workflow — they survive every check the BOM tools
do and surface at assembly. The insight that makes catching them cheap: a footprint assignment
carries **three independent claims** about one physical part, and every real error is a disagreement
between two of them.

| Source                                              | Claim                                          | Cost to read                                              |
| --------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------- |
| the **name**, `QFN-56-1EP_7x7mm_P0.4mm_EP3.2x3.2mm` | what it says it is: pitch, body, pad count, EP | regex table over KiCad naming conventions                 |
| the **geometry**, the `.kicad_mod`                  | what it actually is                            | S-expressions — the _same span-tracking lexer as step 2b_ |
| the **part**, the package you recorded              | what the part needs                            | free once step 2 has run                                  |

`0402` in the catalog against `R_0603_1608Metric` on the symbol is a name↔part mismatch. A
hand-edited library footprint is a name↔geometry mismatch. Neither needs a datasheet.

**Measured from the pads** (pure functions over a pad list): pad count, with thermal/exposed pads and
NPTH mounting holes counted separately · pitch, by clustering pads into edges and taking the median
nearest-neighbour spacing · pad size, centre-to-centre row span and outer pad-edge span · exposed pad
dimensions · courtyard bounding box from `F.CrtYd` · SMD vs THT and drill diameters · pin-1 marker.

**Free bonus check, no library needed:** KiCad's netlist XML lists every pin of every `libpart`, so
comparing symbol pin numbers against footprint pad numbers as sets catches an 8-pin symbol on a
5-pad footprint, or a symbol numbered `A1…D4` against pads numbered `1…16`.

**Which findings are allowed to fail the build.** Pitch, pad count, mounting type and exposed-pad
presence are exact — those are errors. Absolute dimensions are **advisory only**, because a land
pattern is deliberately larger than the package body (a 7×7 mm QFN spans ≈7.9 mm across the pads,
by an amount that depends on the IPC density level the library targeted). Reporting that as a
failure produces a checker nobody trusts within a week, so spans and body-vs-courtyard containment
are printed as numbers side by side for a human to judge.

**On datasheets, honestly.** For passives a static `0201…2512` dimension table makes the size check
airtight, and it needs nobody's API. Parsing land-pattern drawings out of PDFs is
_not_ reliable and nothing here depends on it — at most, text-extraction regexes for pitch and body
tokens offered as hints to confirm. The real win is making the human check fast: `fp measure` emits
an **annotated SVG of the pads with dimension lines**, so holding it against the datasheet's land
pattern is a ten-second look. The tool measures and does the arithmetic; the human reads the drawing.

A footprint referenced but present in no library is a finding in its own right — the library plumbing
(global and project `fp-lib-table`, `${KICAD8_FOOTPRINT_DIR}` expansion, Windows paths) is the fiddly
part of this feature, not the geometry.

### Step 3 — one basket per supplier

```bash
kinv order ./MyBoard.kicad_pro --boards 5
```

```
5 boards · 2 suppliers · quantities are placements × boards, nothing else

DIGIKEY  —  31 lines · 1244 pieces
     290 1276-1000-1-ND        CL10B104KB8NNNC        C|100n|0603
     110 311-10.0KLRCT-ND      RC0402FR-0710KL        R|10k|0402
     …
LCSC  —  1 line · 5 pieces
       5 C2040                 RP2040                 U|RP2040|QFN-56

NO SUPPLIER YET (4)
NO PART NUMBER YET (47)

→ order.digikey.csv
→ order.lcsc.csv
```

Each file is `Quantity, Part Number` — what a distributor's upload form or BOM manager wants, and
nothing it did not ask for. `--reference` adds a third column carrying the canonical key, which is
worth having when a bag of parts on the bench has to be matched back to a line; it is opt-in because
a form that was not expecting a third column is a form that rejects the upload, and the point of
these files is that they go straight in. `--no-header` drops the header row for a form that wants
bare lines. What happens to the parts when they arrive is not this tool's business (§8.3).

#### The same job in the browser: the buying columns of the **Parts** tab

`kinv order --template` writes a sheet, you fill in two columns, `--import` reads it back. The table
is that loop without the round trip: the board's own columns, worked out by the tool, and then
**vendor** and **vendor part number**, typed by you. Enter or `save` files the row; a blank clears the field,
because "I have not decided after all" has to be sayable. A **boards** box and one **export CSVs**
button write the per-supplier files, and a panel underneath lists what is on disk — file, lines,
pieces, when it was written — counted out of the files themselves rather than remembered from the
run that wrote them, so a file an older run left behind is visible too.

**Export asks where.** Pressing **export CSVs** opens the machine's own folder dialog — Explorer's on
Windows, Finder's on macOS, zenity or kdialog on Linux — starting at the directory the last export
went to, which is beside the board until you say otherwise. Cancelling writes nothing.

It is a separate process and takes about two seconds to appear (measured: 2.4 s on Windows, nearly
all of it `Add-Type` loading WinForms), so the button says **waiting for the folder dialog…** for as
long as that lasts. It has to: a button that only greys itself for two silent seconds reads as a
button that does nothing, which is exactly how it read the first time. The dialog is owned by an
invisible topmost window, because the process asking is not the one you are looking at and Windows
will not give it the foreground — without that owner it opens _behind_ the browser. Where it opens
is the shell's own business; `SHBrowseForFolder` places itself and ignores the owner's position. It is the
system dialog rather than a directory tree reimplemented in the page for the obvious reason: you
already know how to use it, and it can make a new folder on the spot. The server opens it, because
the server and the browser are the same machine; the path never goes near a shell (it travels in the
environment on Windows and as an argument everywhere else), and a directory that does not exist is a
sentence you can read rather than a folder invented somewhere odd. A machine with no dialog at all —
headless, no display — says so and offers the path as a box to type into, so the export still
completes over SSH.

The chosen directory is remembered for as long as the server runs, and no longer. It is a
convenience rather than a decision about the board, so it stays out of `.kinv/`, where git would
carry it to another machine and name a path that does not exist there. `kinv order --out` is the
same choice from the command line.

#### The key you read and the key you file under

`C|100n|0402` is the right join key and the wrong thing to type into a search box. The key column
shows the same part in the words a distributor uses — `CAP CER 0.1UF 0402`, `RES 5.62K OHM 0603`,
`FIXED IND 150UH` — with a **⧉** at the right-hand end of the cell that copies exactly that string,
so finding the part is a paste rather than a translation. A specific part is left alone: `RP2040` is
already what you would type.

The canonical key has not moved. It is still what the catalog, `.kinv/buy.json` and every join are
filed under; it is on the cell's tooltip, in the row's `data-key`, and the filter box still finds a
row by either wording. `searchLabel` is a label and never an identity — two spellings that merge into
one part share a key, and therefore share a label.

The units follow the catalogues rather than the schematic:

| unit        | how it is written                 | why                                                                             |
| ----------- | --------------------------------- | ------------------------------------------------------------------------------- |
| resistance  | `10K OHM`, `1M OHM`, `0.005 OHM`  | prefixes upwards only — 5 mΩ cannot be `5M OHM`, which is a million times wrong |
| capacitance | `22PF`, `4700PF`, `0.01UF`, `1UF` | picofarads below 10 nF, microfarads from there up: nobody lists a `100NF` part  |
| inductance  | `10NH`, `150UH`, `1MH`            | `MH` is millihenries, as they write it                                          |

Two rules the tab inherits rather than reinvents:

- **A vendor needs an MPN first.** The catalog is keyed by part number, so a row with none says
  _needs an MPN_ and leaves the boxes out — the box that fixes it is the **bought as** cell two
  columns to the left, in the same row. Inventing a catalog entry to hold "digikey" would be the tool
  making the decision step 2 exists to ask for.
- **Both directions of the schematic round trip are buttons.** The Parts tab has a row for the
  controls that write files, and the two schematic ones each open a plan first — which symbols,
  which fields, old value → new value, or which parts the catalog would take — with the apply button
  inside that panel. The same guards as the spelling rewrite: a `.bak`, a refusal while KiCad holds
  the file open, and a refusal on a working tree that already has changes, so `git diff` afterwards
  shows only what the tool did. The panel is kept outside the render, so the two-second poll cannot
  close a plan you are in the middle of reading.
- **The vendor box completes from the board's own vendors.** A native `<datalist>` of the distinct
  suppliers already filed on this board, so the second row you fill in is a pick rather than a
  retype. It suggests and does not restrict — the first time you buy from someone, the list cannot
  contain them yet — and it does not fold spellings together: `digikey` and `DigiKey` are two
  entries because they are two entries in the catalog, and hiding one would hide exactly the drift
  this tool exists to make visible.
- **Nothing here decides a quantity.** `used` is what the board places; the export multiplies it by
  the number of boards you typed and by nothing else, and reports what it left out — parts with no
  vendor, parts with no MPN — rather than filling either in.

The one place it does not copy `assignPart` is overwriting: assignment fills gaps and never
overwrites, which is right for detail typed beside an MPN and wrong for a column you have to be able
to correct. `setSupplier` writes over what is there, and clears on a blank. It edits the _catalog
part_, so the next board buying that MPN gets the same vendor — that is the catalog doing its job.

### M5b: the part you bought against the pads on the board

The third leg of the footprint check, and the only one that needs the catalog. The other two compare
a footprint's name with its geometry — both of which are in the project. Neither can tell you that
you went and bought 0603 resistors for an 0402 land pattern, because the schematic does not know what
you bought.

```
kinv check <project>

ERRORS
  package-mismatch   RC0603FR-0710KL is 0603, but R|10k|0402 has a 0402 land
                     pattern — the part will not fit the pads
                     R1,R2
```

It fires off a `part_package` column in the fill-in sheet, and it exits 1, because this one costs you
a reflow run and a reorder.

**It is blank by default and stays quiet.** The obvious convenience would be to prefill that column
with the board's own package — and it would make the check pass every time, for everyone, forever. A
blank means "you did not say", which is the same rule as the rest of the tool: a check that guesses
is worse than one that waits.

**`0603`, `1608`, `1608Metric` and `R0603` are one package.** The board's side comes out of a
footprint name and yours is typed, so both are folded before they are compared. The metric pairs are
a written-out table rather than arithmetic on the millimetre sizes: 0805 is 2.0 × 1.25 mm and its
metric name is `2012`, not the `2013` that rounding gives, and 1206 and 1210 share a 3.2 mm width but
are `3216` and `3225`. There is one collision — metric `0603` is imperial `0201` — and bare digits
are read as imperial, because that is what a person means and what KiCad's names put first.

Anything that is not a chip code (`SOIC-8`, `QFN-56`) is compared as written. There is no table for
those, and pretending otherwise would be the same guess in a different hat.

### Why there is no distributor API

The plan was a DigiKey Product Information client — stock, price breaks, lifecycle — feeding a solver
that picked order quantities at the best break. It was dropped, and the tool is better for it.

**The failure mode is money.** "Buy 100 because 100 is cheaper than 42" is the tool making a
purchasing decision from data it fetched itself, and the same code path that saves three euros on
resistors can order ten thousand of a five-euro part because the arithmetic said so. Nothing else in
this tool works that way: a tie is reported as a tie, `keep` and `move` are labels rather than
buttons, and a footprint the tool cannot measure is not called an error. An order solver was the one
place the design broke its own rule.

**It also bought lock-in.** M5b was going to check footprints against DigiKey's package attributes —
a correctness check that only works while you buy from one distributor. And the API comes with an
agreement: no bulk download, no database of your own built from their data, no passing it to third
parties, per-minute and per-day limits, credentials that are yours alone. All reasonable, all
irrelevant now.

**The convenience survives without any of it.** A distributor's upload form takes a CSV of quantity
and part number. Producing that file needs no API, no OAuth, no rate limiter and no cache that has to
justify itself as a cache. What the API was really buying — is it in stock, what does it cost — is
the part of the job a human should be looking at anyway.

So the rule this leaves behind, alongside the others: **the tool never invents an order quantity.**
It counts what the boards need, multiplies by how many you are building, and stops. There is no code
path that can produce a number you did not choose.

The cost, stated plainly: nothing validates a hand-typed MPN. A typo reaches the upload file, and
only your eyes catch it before the order goes in.

## 6. How this gets tested

Five layers, cheapest first. The point of the pure core is that layer 1 covers most of the risk.

**1. Unit tests on `core/` (the bulk).**
Value parsing is where bugs hide, so it gets the most: `10k`, `10K`, `10 k`, `4k7`, `0R1`, `1R`,
`100n`, `4u7`, `1µF`, `0.1uF`, `2n2`, `1M` — note that `M` means mega for resistors and milli in some
capacitor conventions; that ambiguity is a test case, not an accident. Footprint normalisation:
`Resistor_SMD:R_0603_1608Metric` → `0603`, imperial/metric aliasing, hand-typed `0603` and `R0603`.
Then grouping and the order arithmetic — each a table of `(input, expected)` cases.

Footprint measurement lands here too, and cheaply: it is a pure function from a pad list to numbers,
so real pads lifted from `R_0603_1608Metric`, `SOIC-8_3.9x4.9mm_P1.27mm`, a 0.4 mm QFN with an
exposed pad, and a THT connector become a table of expected pitch / count / span. Deliberately
included: a footprint whose name lies about its geometry, and a symbol/footprint pin-number mismatch.

**2. Property tests (`fast-check`).**

- `parse` is idempotent: `format(parse(x))` is stable under re-parsing.
- Any generated `Spec` round-trips through its canonical key.
- Order invariants that must hold for _every_ input: `ordered ≥ max(0, needed − onHand)`, `ordered`
  is always a valid MOQ multiple, and the chosen price break never costs more than buying the exact
  quantity would.

**3. Golden-file tests on the adapters.**
Real KiCad exports checked into `tests/fixtures/`: a small board, one with hierarchical sheets, one
with DNP parts, one with umlauts and unicode in fields, one deliberately malformed. Each is parsed
and snapshotted. When a KiCad release changes its CSV columns, exactly one snapshot moves and it is obvious
what broke.

The same fixtures — one `.kicad_sch` per KiCad major version — carry the write-back safety property:
_parse → write with zero edits → bytes identical_, and _edit a field → revert → original bytes_.
That pair is the reason step 2b is allowed to touch the user's schematic at all, so it runs on every
fixture, in the normal test run, and a failure blocks the build.

**4. Round-trip tests for the order sheet.**
The part list is written, filled in as a person would fill it in, read back, and the per-supplier
files checked line by line — including the rows that must _not_ import: a key the board does not
have, and a supplier given without a part number.

**5. End-to-end CLI tests.**
Run the built binary in a temp directory against a fixture project: `watch` → edit the fixture BOM →
assert the report changed; `resolve` with scripted stdin and a stubbed client; `order` → assert the
generated CSV byte for byte. Enough to catch the wiring mistakes unit tests cannot see.

**Gates.** `npm test` runs layers 1–3 and 5 in a few seconds. CI runs the same on Linux and Windows
(path handling genuinely differs). Coverage is reported, with a floor on `src/core/` only —
demanding coverage of CLI rendering code produces tests that assert nothing.

## 7. Milestones

| #      | Deliverable                                                                                                                                                          | Done when                                                                                                                                                                               |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M0 ✅  | Repo skeleton: TS, vitest, CI, `kinv --version`                                                                                                                      | CI green on Linux + Windows                                                                                                                                                             |
| M1 ✅  | KiCad readers, spec parser, canonical keys                                                                                                                           | reads the reference board end to end; 103 tests at the time (270 now)                                                                                                                   |
| M2 ✅  | `kinv bom`, `kinv check`, consolidation report                                                                                                                       | 34 findings on the reference board, every one checked by hand                                                                                                                           |
| M3 ✅  | `kinv watch` with live refresh                                                                                                                                       | edit in KiCad → report updates in under a second                                                                                                                                        |
| M4 ✅  | Catalog + assignments storage, `kinv resolve` offline (manual MPN entry)                                                                                             | a full board resolved with no network                                                                                                                                                   |
| M2b ✅ | `kinv fp measure` + name↔geometry↔pins cross-check, annotated SVG                                                                                                    | 47/47 footprints on the reference board measured, 1 true finding, 0 false; broken-footprint tests pass                                                                                  |
| M4b ✅ | `kinv fields write` / `kinv fields read`: span-tracking s-expr lexer, UUID-anchored field splicer, dry-run diff, lock/git guards, and the read back into the catalog | no-op round trip byte-identical on KiCad 9 and 10 fixtures; the reference board gets its MPN fields (KiCad 8 untested — no genuine file to hand, see `tests/fixtures/kicad9/README.md`) |
| ~~M5~~ | ~~DigiKey client: search, stock, price breaks, cache~~                                                                                                               | **dropped.** The tool must not invent an order quantity, and the API bought lock-in and an agreement for a job you do better yourself — see §"Why there is no distributor API"          |
| M5b ✅ | Part-vs-pads leg of the footprint check, off the catalog                                                                                                             | catalog says 0603 + board has 0402 → error, and `kinv check` exits 1                                                                                                                    |
| M6 ◑   | `kinv order`: the fill-in part list, the buying columns of the **Parts** tab, and one upload file per supplier                                                       | built and tested on the reference board; in service on real boards now — the "done when" is a real order placed from a generated file                                                   |
| ~~M7~~ | ~~`kinv receive`, stock adjustments~~                                                                                                                                | **dropped.** It was the global inventory — what is on the shelf, pooled across boards — and that is out of scope: see §8.3                                                              |
| —      | _later_                                                                                                                                                              | Mouser/LCSC order-file dialects, a hosted UI — and whatever [IMPROVEMENTS.md](IMPROVEMENTS.md) has collected by then                                                                    |

M1–M3 deliver step 1 of the user story and M4 delivers step 2's manual leg; all of it is useful on
its own, and none of it needs an account anywhere. Keeping the network out of the critical path was
always the plan; dropping M5 made it permanent.

M2b and M4b were slotted in out of order because each was needed before the milestone it belongs to:
measuring footprints proved the s-expression reader that the field splicer then depended on, and the
splicer arrived early because the UI had a use for it.

## 8. Open questions

1. ~~**BOM input format.**~~ **Settled by the reference board (§10):** `kicad-cli 10.0` is installed
   and `sch export bom` works on the whole hierarchy in one call, with `--fields` and `--group-by`
   under our control. M1 shells out to it rather than parsing `.kicad_sch` for _reading_. Direct
   s-expression parsing is still needed for writing (2b) and for footprints (2c). Open sub-question:
   whether `watch` re-shells on every save (simple, ~1 s) or reads the schematic directly (faster,
   more code) — measure first.
2. ~~**Tolerance and voltage as first-class.**~~ **Settled: reported, never performed.** Merging
   10k 1% with 10k 5% is usually right and sometimes ruinous, and the tool has no way to know which
   board it is looking at. The person choosing the part is the one who knows that this divider is
   the feedback network and that one is a pull-up — so the tool keeps them distinct, _reports_ the
   merge opportunity, and leaves it there. Taking care of the special parts is the designer's job,
   and a tool that quietly merged them would be making a decision it cannot be accountable for.
   This is the same rule step 2 already follows for MPNs, and §2's rule about footprints.
3. ~~**Multiple projects sharing one inventory.**~~ **Settled: out of scope.** A global inventory —
   what is on the shelf, pooled across boards, with demand rolled up across projects — is a
   different tool, and this one stops at "what does this board need, and where do I buy it".
   The _catalog_ is still shared across every board (question 4): what a part is, and who sells it,
   is worth deciding once. A count of how many are in the drawer is not something this tool tracks.
4. ~~**Where the inventory files live.**~~ **Settled by M4: central**, at `~/.kinv`, moved with
   `KINV_HOME`. A part chosen once has to be reused on the next board — that is what makes a catalog
   worth keeping — and what is on the shelf is a property of the shelf, not of a design. The
   exception is per-board state: settled findings live in `.kinv/solved.json` beside the project,
   because they are a decision about _that_ schematic.

## 9. Getting started

```bash
npm install
npm run typecheck && npm run lint && npm test && npm run build
npm link                 # provides `kinv`

kinv --version           # 0.1.0   ← this is what M0 delivers

kinv init                # creates ~/.kinv (KINV_HOME moves it)
kinv watch ./MyBoard.kicad_pro
kinv resolve ./MyBoard.kicad_pro
```

## 10. The reference board

Developed against a real design rather than toy fixtures: **`transformer_test`**, a resonant power
supply — 13 sheets, 646 placed symbols (354 of them purchasable; the rest are power symbols, GND and
parts excluded from the BOM), 100 grouped BOM lines, 95 distinct parts after consolidation, 68
distinct footprints, KiCad 10 (`version 20260306`, `generator_version "10.0"`). Errors surface fast
on it, which is the point.

Snapshots live in `tests/fixtures/kicad10/` so the normal test run is hermetic and works on CI;
tests wanting the live project call `liveProject()` and skip when it is absent. Point it elsewhere
with `KINV_TEST_PROJECT`.

**What one `kicad-cli` export already exposes** — every one of these is a finding the tool must
produce, and they are the acceptance criteria for M2:

| Finding                                 | Evidence on the reference board                                                                    |
| --------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Same part, two spellings, two BOM lines | `100n` ×54 and `100nF` ×4, both `C_0603_1608Metric`; `10u` ×15 and `10uF` ×3                       |
| Same part, letter case only             | `5K6` ×1 and `5k6` ×5, both `R_0603_1608Metric`                                                    |
| One value across several packages       | `10k` in 0402 ×19 and 0603 ×3; `1k` in 0402 ×12 and 0603 ×2                                        |
| Mixed notation for one quantity         | `4.7n` / `3n3` / `33n` / `33nF`; `49.9` vs `4k9`; `0.1` Ω (1206) vs `10m` / `2m` / `5m` (2512)     |
| Values with no unit at all              | bare `0`, `1`, `4`, `10` — is `4` four ohms or a placeholder?                                      |
| **Wrong footprint class**               | 20 resistors (R2004-R2007, R3004-R3007, R4007-R4014, R5004-R5007) carry `Capacitor_SMD` footprints |
| Inconsistent custom fields              | `Volrtage` (typo) ×12, `capacity` vs `Capacity`                                                    |

Two design consequences fell straight out of that first export, and both are cheap to honour now and
expensive to retrofit:

- **`kicad-cli` localises generated columns.** The DNP column reads `"Nicht bestücken"` on this
  machine. DNP must come from `--exclude-dnp` or from the schematic's boolean — **never** from a
  string comparison against the exported text. The same caution applies to every generated column.
- **A reference-designator prefix implies a footprint class.** `R*` on a `Capacitor_SMD:` footprint
  is wrong without measuring a single pad, so this check joins step 2c and needs no library at all —
  it is the cheapest real check in the project and it already has 20 hits.

A third, from the repo rather than the board: `.gitattributes` marks KiCad files `-text`. Git's
autocrlf would rewrite the fixtures and silently invalidate the byte-identical round-trip test that
makes step 2b safe to run on someone's schematic.

## 11. What M1 and M2 actually do

```
kinv bom <project.kicad_pro>     # or a .kicad_sch, or an already-exported .csv
       [--group-by Value,Footprint] [--exclude-dnp] [--issues] [--json]
```

Shells out to `kicad-cli sch export bom`, expands the reference ranges it emits (`C6001-C6004`),
parses each line into a `Spec`, and prints the canonical key, the value, the count and the issues.

On the reference board, unchanged: **100 BOM lines → 95 distinct parts**, because five pairs of lines
turned out to be the same purchase —

```
C|100n|0603     100n(54) + 100nF(4)
C|10u|0805      10u(15)  + 10uF(3)
C|2.2u|0603     2u2(8)   + 2U2(3)
R|5.6k|0603     5k6(5)   + 5K6(1)
R|0|0603        0(4)     + 0(6)      ← same 0R part, two different footprints
```

…and **4 errors**, all genuine: the 20 resistors on capacitor footprints. Nothing else is reported as
a problem, which was a deliberate outcome rather than a lucky one:

- **`Package_TO_SOT_SMD:SOT-23-6` on a `U` is not flagged.** Class checking works on _families_ —
  `ic`, `transistor` and `diode` look alike on a board and a regulator in a SOT package is
  unremarkable. Only a cross-family disagreement (a resistor wearing a capacitor footprint) is an
  error. Without that rule the check would have produced 21 findings, one of them real.
- **Bare resistor values are not flagged.** The board has bare `0`, `1`, `4`, `10`; for a resistor a
  bare number means ohms and is perfectly clear. The same bareness on a _capacitor_ is a genuine
  ambiguity (100 pF or 100 µF?) and is a warning. Class decides.
- **A part number in a value field is `info`, not an error.** `IHLP6767GZER100M01` fails to parse as
  an inductance because it is not one — it is an answer someone already worked out. Five of these
  exist on the board; reporting them as broken values would have been five pieces of noise sitting
  above the four real errors.

Severity exists precisely for that last distinction: `error` is a defect, `warning` needs a decision,
`info` is worth knowing and is not a complaint.

### Decisions taken while building it

- **The reference designator outranks the footprint** when they disagree about class. `R5004` on a
  capacitor footprint is a resistor with the wrong footprint, so it keys as `R|0|0603` and buys a
  resistor. The mismatch is reported separately rather than by silently reclassifying the part.
- **Land-pattern variants do not enter the key.** `C_1210_3225Metric` and
  `C_1210_3225Metric_Pad1.33x2.70mm_HandSolder` are one purchase.
- **`m` is milli, `M` is mega — the only case-sensitive rule.** Everything else folds case, which is
  what merges `5K6` with `5k6`. The board's `10m`/`2m`/`5m` shunts depend on the exception, and
  `0.1` Ω stays distinct from `10m` because 100 mΩ and 10 mΩ are different resistors.
- **The CSV reader is hand-written.** The reference column is full of embedded commas
  (`"C1001,C2004,C6001-C6004"`), so splitting on commas destroys the data.

### M2: the consolidation report

```
kinv check <project>   [--near 2] [--group-by ...] [--exclude-dnp] [--quiet] [--strict] [--all]
```

Exit code 1 when there are errors (`--strict` also fails on warnings), so it drops straight into a
pre-commit hook or CI. On the reference board: **34 findings, 4 errors**.

Five kinds of finding, ordered by how little thought each one costs you:

| Finding                                                                     | On the reference board                                                       |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| **Same part, spelled differently** — free to merge, no design change        | 4: `100n`/`100nF`, `10u`/`10uF`, `2u2`/`2U2`, `5k6`/`5K6`                    |
| **One value, several packages** — the original question, a decision for you | 6: `10k` (0402×19, 0603×3), `1k`, `10 Ω`, `0 Ω` (three sizes!), `33n`, `10n` |
| **Values suspiciously close together** — probably unintentional             | 1: `49.9k` / `50k` / `51k`, 2.2% apart, at R11001 / R7018 / R7016            |
| **One part, different footprints**                                          | 1: `0 Ω` 0603 reached through both `R_0603` and `C_0603`                     |
| **Generic values used once** — substitution candidates                      | 22                                                                           |

Every finding carries its reference designators, because the next step is always to go to those refs
in the schematic editor.

Two rules keep the report honest, and both cost real findings:

- **A tie is reported as a tie.** `10 Ω` sits in 0402 ×4 and 0805 ×4. The tool has no basis to
  prefer either, so it says "2 equally common sizes; pick one" instead of dressing an arbitrary
  choice up as a recommendation.
- **Singletons are generic values only.** The first version listed all 51 parts used once, which
  included `RP2040`, `ICE40HX4K-TQ144` and every connector — a board with one MCU is not a
  consolidation opportunity. Restricting it to generics cut the list to the 22 you can actually do
  something about.

The near-value check chains runs rather than comparing pairs, which is why `49.9k` → `50k` → `51k`
is one finding of three members instead of two overlapping findings. It also skips 0 Ω entirely:
everything is infinitely far from zero, so every jumper would otherwise pair with every small value.

### The UI

```
kinv ui <project>   [--port 7373] [--no-open] [--near 2] [--exclude-dnp]
```

Serves a single self-contained page on `127.0.0.1` and opens it. Five tabs — **Consolidation**,
**Issues**, **Parts**, **Footprints** and **Not bought** — over the same core functions the CLI uses;
the UI is a renderer, not a second implementation.

It polls every two seconds, but only re-runs `kicad-cli` when the newest `.kicad_sch` mtime actually
changes, so **saving in KiCad updates the page a second or two later** and idling costs nothing. That
is most of M3's live refresh, arrived at early because the UI needed it anyway.

Details worth keeping:

- **Local only.** It binds `127.0.0.1`, never `0.0.0.0`. It serves a live view of files on disk; it
  is an instrument, not a service.
- **No CDN, no build step, no framework.** One HTML string, vanilla JS, system fonts. It works with
  no network, and there is no second toolchain to maintain.
- **Clicking any reference list copies it**, so it can go straight into KiCad's search box — and a
  whole `keep` / `move` row is one of those lists, because taking those refs to the schematic editor
  is the entire next step.
- **The key column reads as a distributor writes it**, with a ⧉ that copies it (§ _The key you read
  and the key you file under_).
- **A part can be sent to "Not bought" and back.** The ⊘ at the left of a parts row and the
  **buy this ↑** on a "Not bought" card are the same decision from either side (§ _Not everything on
  a board is a part_). Neither asks first: nothing is lost, and the other tab has the way back.
- **`keep` and `move` are labels, not buttons.** They were drawn as bordered pills, which is the
  shape of a control, and invited a click that can never arrive: the tool does not change footprints
  (§2), because the PCB already has that footprint placed and swapping it can break routing. They
  now read as labels and the row hands you the references instead.
- **One table, not three.** Parts, Resolve and Parts to buy were three tabs over the same 89 rows,
  which meant finding the same row three times to finish one part. They are one table now, and its
  columns run in three bands: what the board says and you cannot argue with (**key · value · class ·
  package · used · issues**), then the decisions that are yours (**bought as · vendor · vendor part
  number**), then the detail you read rather than act on (**bom fields · description · references**).
- **The parts table filters** across value, package, reference, any BOM field, and the MPN and vendor
  you typed — one box over the whole row.
- **The report cache never hit, and it showed up as lost typing.** The cache compared its key —
  schematics + settled findings + inventory — against the report's own `sourceSignature`, which is
  the schematic fingerprint alone. The two could never be equal, so every two-second poll re-read the
  board, re-ran `kicad-cli`, and handed the page a new `generatedAt`; the page re-rendered, and the
  half-typed manufacturer in an open row went with it. The cache now keeps its own key beside the
  report, stamped from before the build so an edit landing mid-build is still an edit next time.
- **What you typed outlives a render.** Even with the cache fixed, saving in KiCad re-renders the
  table under you, and a box you are in the middle of is a decision in progress. Every input carries
  a `data-box` name, what is typed into one is kept by row and box until the row is filed, and the
  focus and caret are put back where they were. `--boards` and the two vendor columns behave the same
  way; an unsaved edit is outlined, so nothing that has not been filed looks filed.
- **A rebuilt UI reaches an open tab.** The page re-renders from JSON and never reloads itself, so
  restarting the server used to leave a tab running the old script against the new data — silently,
  for as long as the tab stayed open. The page now carries a hash of itself, the report carries the
  same, and a mismatch reloads. The HTML is `no-store`: it is a live view of files on disk.
- **A row with no MPN still has every column.** The two vendor cells were one cell spanning both, so
  a row missing an MPN was one cell narrower than the rest — and the sort reads a column by
  position. Two cells always, the first carrying the hint.
- **Table tabs get the whole window; card tabs get a text width.** Cards read best narrow, a
  twelve-column table does not, so the tab decides rather than every tab paying for the widest one.
  A 1600px cap on the table tabs still left a third of a wide monitor empty, so there is no cap at
  all there now; the description column takes up the slack, because one flexible truncating column
  beats sharing the leftover room out as padding. The footprint viewer keeps a cap of its own — a
  420px-tall drawing stretched over a 4K window is mostly empty background.
- **The parts table caps its key and package columns** and keeps the key stuck to the left edge. One
  part keyed `Y|ECS-2520MV-120-BL-TR|Oscillator_SMD_ECS_2520MV-xxx-xx-4Pin_2.5x2.0mm` is enough to
  set those two columns 70 characters wide for every row and push everything after them off the
  edge.
- Light and dark follow the OS.

Tested with jsdom by loading the real page, stubbing `fetch`, and asserting the DOM: the stats, the
findings, the tab switch, the filter, the issue severities. A crash inside `render()` would otherwise
reach you as a blank page — which is exactly what the first version of that test caught.

### M4: what each generic is bought as

```
kinv init                                   # creates ~/.kinv
kinv resolve <project>                      # what is still unresolved
kinv resolve <project> --set 'R|10k|0402=RC0402FR-0710KL@Yageo'
kinv resolve <project> --clear 'R|10k|0402'
kinv resolve <project> --all --json
```

…and a **bought as** column in the **Parts** tab that is the same thing with a box to type in: an
MPN and a manufacturer field on the row that already shows the part, its package and its refs. Enter
saves the row. Nothing here touches a network —
that is the point of doing the manual leg first, and it is what "a full board resolved with no
network" asks for.

**The schematic is a second copy, on purpose.** `kinv fields write` puts `MPN`, `Manufacturer`,
`Supplier` and `Supplier#` on the symbols and `kinv fields read` takes them back, so the catalog is
a cache of a decision the board itself records rather than the only place it exists. The two can
drift, and the reader says so rather than picking a winner — see §"Step 2b".

**One catalog, every board.** `~/.kinv/catalog.json` holds the parts you know and
`~/.kinv/assignments.json` holds `canonical key → part id`. Both are written sorted with sorted keys,
so adding one part is a one-line diff. The reuse is the reason they are central: the second board
asks nothing about 10k 0402, because that decision is already made.

**The MPN is the identity.** A part id is the MPN folded to lowercase with punctuation collapsed, so
`RC0603FR-0710KL`, `rc0603fr 0710kl` and `RC0603FR/0710KL` are one catalog row rather than three.
Typing an MPN that is already known reuses the row and fills in whatever was blank — a manufacturer,
a datasheet — without overwriting what was there. Reassigning a key leaves the old part in the
catalog: it is still a part you know about, just not the one this generic buys.

**A suggestion is not an assignment.** The five parts whose _value_ is already a manufacturer part
number — `IHLP6767GZER100M01` and friends — arrive with their MPN prefilled and still need the click.
Putting something into a catalog that outlives the board is a decision, and a read does not get to
make decisions.

**`--set` refuses a key that is not on the board.** A typo would otherwise sit in the catalog for
every future board, attached to nothing. `kinv resolve` exits 1 while anything is unresolved, so it
drops into a pre-order check the way `kinv check` drops into a pre-commit hook.

#### One reading of the board

Building this turned up a real disagreement: `kinv check` did its own read and skipped the geometry
step that decides what is a purchase at all, so it reported **81** parts where the page reported
**83**. The two missing ones were the Würth SMD standoffs — thrown out by the mounting-hole rule and
put back by the copper, as §"Not everything on a board is a part" describes. `check`, `resolve` and
the UI now share one `analyzeProject`, and a test asserts the three agree.

The test suite also points `KINV_HOME` at a throwaway directory for every file. The catalog is
global by design, which means an un-isolated test run would read the developer's own — the reference
board's numbers would depend on whose machine it ran on — and a writing test would edit a real
catalog.

### M4b: writing the decisions back into KiCad, and reading them again

```
kinv fields write <project>            # dry run: the whole diff, nothing written
kinv fields write <project> --apply
kinv fields write <project> --apply --allow-dirty
kinv fields read <project>             # dry run: what the symbols would add to the catalog
kinv fields read <project> --apply
```

Once a generic has a concrete part, the schematic should say so — `MPN`, `Manufacturer` and
`Supplier#` go into the symbols, so KiCad's _own_ BOM export carries real part numbers and the
schematic is self-documenting to someone who never runs this tool. On the reference board that is
**156 fields on 78 symbols across 10 files**.

Only what the tool decided gets written. `Value` and `Footprint` are the designer's; `Description`
and `Datasheet` come from the symbol library, and overwriting them would replace something a person
chose with something a distributor said.

**A new field is cloned, not composed.** The plan was a table of per-version dialects, and the two
real files to hand disagree in exactly the way that table would have to encode:

|                               | where a hidden field says so                 |
| ----------------------------- | -------------------------------------------- |
| KiCad 9 (`version 20250114`)  | `(property … (effects (font …) (hide yes)))` |
| KiCad 10 (`version 20260306`) | `(property … (hide yes) (show_name no) …)`   |

So instead of emitting a property, the writer **copies the bytes of a hidden field the symbol
already has** and swaps the name and the value. That reproduces whatever the file in front of it
does — its dialect, its indentation, its font block — with no version knowledge at all, and cannot
drift when KiCad changes again. The added field is hidden because its donor was, which is right for
a part number: it belongs in the BOM, not drawn on the sheet. A symbol with no hidden field to copy
is skipped and said so, rather than guessed at.

Both fixtures are genuine KiCad output — the KiCad 9 one is a project template shipped with the
installer — and every field test runs against both. **KiCad 8 is not covered**: no genuine KiCad 8
file was available, and a hand-written one would only prove that the test and the implementation
share an assumption.

#### A project is its hierarchy, not its directory

The first dry run reported three resistors it would not touch — `R10001` as `83k8`, `R10002` as
`16.3k`, `R1008` as `82k` — and every one of them is a 10k on the board. The bug was here, not
there: the writer globbed `*.kicad_sch` beside the project, and the reference board's directory also
holds `_autosave-encoder.kicad_sch`, a `12V_to_5V.kicad_sch` cut from the design, and four more
schematics that were never in it. It was reading files that are not the board.

The BOM comes from `kicad-cli`, which walks the hierarchy; anything that writes to the design has to
walk the same one. `projectSheets` now follows `(sheet … (property "Sheetfile" …))` from the root —
11 files on the reference board, including one nested a level down — and the strays are invisible.
`sourceSignature` and the custom-field discovery walk it too: KiCad's autosave changes on a timer,
and watching it re-exported the BOM for an edit nobody had made.

#### A reference designator is still not unique

One skip survives the fix, and it is real:

```
LEFT ALONE (1)
  R1008  reads "82k" here, not "10k" — a different part with the same reference
```

`usb_ckicad_sch.kicad_sch` holds a symbol whose own `Reference` property says `R5011` and whose
value is `82k`, but whose **instance list also claims `R1008`** — a path left behind by a sheet
instantiation that is no longer there. The 10k `R1008` in the root gets its part number; this one
does not.

So a reference alone is never enough. Every write also checks the symbol's `Value` against the
spellings the BOM line was actually built from — `100n` and `100nF` both pass for one part — and
skips anything else with its reason. Stamping "this is a 10k" onto an 82k resistor is the worst
thing this code could do: a wrong part number is harder to catch than a missing one, because
everything downstream believes it.

#### The rest of the guards

- **A `.bak` per file**, and the file's **SHA is checked** immediately before writing: a save from
  KiCad between planning and applying aborts the whole thing rather than splicing at stale offsets.
- **The project's lock stops it** — any `~*.kicad_sch.lck` in the directory, because KiCad locks the
  root and holds the whole hierarchy in memory.
- **A dirty git tree stops it** (`--allow-dirty` to override). The point is not to police your
  working tree: it is that after this runs, `git diff` should show _only_ what the tool did. Outside
  a repository, or with no git installed, the guard is silent rather than in the way.
- **The line ending is the file's own.** KiCad writes CRLF on Windows and `.gitattributes` marks
  these files `-text`, so an inserted LF line would leave the file mixed and put a spurious
  whole-file change in the next diff.
- **Running it twice changes nothing**: a field that already says the right thing is not an edit.

### Settling a finding, and unifying a spelling

The consolidation tab reports; these two controls are the only places the UI writes anything.

```
POST /api/solved         mark a finding settled, or reopen it
POST /api/solved/reset   reopen everything
POST /api/rewrite/plan   what a spelling change would do — reads only
POST /api/rewrite/apply  do it
```

**Mark solved.** Most findings disappear on their own: fix the schematic, save, and the next
re-read no longer reports it. This is for the other kind — the finding is right, you have looked at
it, and the answer is "on purpose". A mark goes into `.kinv/solved.json` beside the project, sorted
and pretty-printed so `git diff` says what you decided and when, and `kinv check` honours it too, so
a pre-commit hook stops asking. `kinv check --all` shows them again without reopening anything.

A mark records the finding's **current wording**, not just its name. Settling "10k in 0402 ×19 and
0603 ×3" stays quiet through unrelated edits and comes back the day a third package appears —
you settled the question that was asked, not the subject. Singletons settle one at a time, because
"yes, that 133k is deliberate" is a decision about one part.

**Use this spelling.** The one place the tool changes a schematic, and the reason step 2b's
span-tracking lexer was built before anything needed it. Each spelling on a _same part, spelled
differently_ card offers to become the only one; the button plans the change and shows it before
anything is written:

```
4 symbols in 1 file will change · a .bak is written first
  usb_ckicad_sch.kicad_sch
    C5001   "100nF" → "100n"
    C5004   "100nF" → "100n"
    …
                                             [ apply ]  cancel
```

What makes it safe to point at a real board:

- **A splice, not a re-serialisation.** Only the bytes of the quoted value change; every other byte
  is written back untouched. Reproducing KiCad's pretty-printer is a losing game, and a reflowed
  file turns a four-line change into a diff nobody can review. The test asserts the file after
  equals the file before with exactly that span replaced, and that a there-and-back rename returns
  the original byte for byte.
- **Matched by reference _and_ by current value.** The references say which placements the finding
  was about; the value check means a report that has gone stale skips the symbol instead of
  overwriting a spelling somebody has since changed by hand. Skipped symbols are listed with why.
- **`lib_symbols` is never touched.** The library definition of a resistor carries
  `(property "Value" "R")` and is not a placement.
- **The project's lock stops it.** KiCad writes `~<name>.kicad_sch.lck` and holds the whole
  hierarchy in memory, so a write under it is reverted by the next Ctrl+S without a word. The first
  version checked only the sheets being edited and passed happily on an open project, because every
  edit was in a sub-sheet — the common case. **Any** schematic lock in the project directory now
  blocks the write.
- **A `.bak` per file**, and the planned bytes are re-checked immediately before writing: a save
  from KiCad between planning and applying aborts the whole thing rather than splicing at stale
  offsets into the middle of another atom.
- **One symbol can be several placements.** A sheet instantiated twice carries two references on one
  symbol; the plan says `also R7104 — one symbol, several placements` rather than letting you find
  out afterwards.
- **The panel closes when you close it.** The page re-renders whenever the two-second poll finds a
  change, which wiped a panel a second after it opened — so the open panel lives outside the render,
  like the parts tab's opened reference lists, and goes away only on the same button again, cancel,
  or apply. The result of an apply stays up for the same reason.

Still outstanding before M4b is done: fields other than `Value`, _inserting_ a field that does not
exist yet (which needs a position and the per-version dialect), the dirty-git-tree guard, and a
`kinv fields write` command. The splicer itself is here and has a real board's worth of evidence
behind it.

**Why writing needs more care than reading.** The page was a read-only instrument; these endpoints
edit files on disk. Any web page anywhere can make a simple cross-origin POST to `127.0.0.1` without
a preflight — it cannot set a custom header, so the server requires `x-kinv: 1` and rejects a
foreign `Origin`. Both are cheap and neither costs the real page anything.

### The parts tab carries the whole BOM

A part row is `key · value · class · package · used · issues · bom fields · description · references`,
and the last three needed a decision each.

**kicad-cli had to be asked for the fields first.** `sch export bom` has no "every field" switch —
`--fields` defaults to five columns and anything else must be named — so `Volrtage`, `Capacity`,
`MANUFACTURER` and the rest never reached the tool at all. The schematics are now scanned for
`(property "Name" …)` before the export, the names KiCad owns are dropped (`ki_*`, `Sim.*`,
`Sheetname`/`Sheetfile`, the generated columns), and what is left is passed to `--fields`. The
reference board yields nine. A name that would break the comma-separated list is skipped rather than
allowed to corrupt the export.

**One cell, not a column per field.** A column each was the obvious layout and measurably the wrong
one: six of the board's nine fields are on a _single_ part, so the table became eighteen columns of
dashes. Each row now shows only the fields that part actually carries, as chips — a plain resistor
shows nothing, the EDAC connector shows its four. `Description` keeps a column of its own because
nearly every part has one, and a `Datasheet` chip is a link.

**A merged part keeps every spelling's data.** `100n` and `100nF` are one purchase, and only the four
`100nF` parts were ever given `Volrtage 50V` — so the merged row shows it. Where two spellings
disagree, both values are kept (`50V · 16V`) rather than one winning silently: that disagreement is
the reason the lines were worth merging in the first place.

**References collapse to a count.** Spelled out, one part with 58 references made the table ~3000px
wide and pushed every column after `package` off the right-hand edge. Each row now reads `▸ 58 refs`
and opens in place — in place, rather than as an inserted row, so the sort order is untouched. What
you open stays open across the two-second refresh, and one button opens or closes them all.

### Severity, corrected by the board's owner

Two calls from the first run were wrong, and both were corrected by domain knowledge the tool did
not have. They are worth recording because they are the same mistake twice: **the tool inferred
intent from a difference it had not measured.**

**A resistor on a `C_0805` footprint is a warning, not an error.** The libraries disagree; the copper
barely does. Measured from the KiCad 10 footprints:

| 0805 land pattern     | pad centre | pad size    | outer span |
| --------------------- | ---------- | ----------- | ---------- |
| `R_0805_2012Metric`   | ±0.9125    | 1.025 × 1.4 | 2.850      |
| `C_0805_2012Metric`   | ±0.95      | 1.0 × 1.45  | 2.900      |
| `L_0805_2012Metric`   | ±1.0625    | 0.875 × 1.2 | 3.000      |
| `LED_0805_2012Metric` | ±0.9375    | 0.975 × 1.4 | 2.850      |

Outer spans agree within 0.075 mm across the whole set, and at 0603 `R_0603` and `C_0603` are
_identical_ at 2.45 mm. The part solders. What is actually wrong is the 3D model and the library
intent — a warning. So a class mismatch is now an **error only when it is not two chip land patterns
of the same size**: a resistor on a SOIC-8 stays an error, a resistor on `C_0603` does not.

The reference board therefore now reports **0 errors and 4 warnings**, and `kinv check` exits 0 while
`--strict` still exits 1.

**A passive with a part number for a value is not an anomaly, it is a decision.** High-power,
unusually small or high-precision passives get chosen early because the design is built around them
— the reference board's `IHLP6767GZER100M01` and `KTF350B226M55NHT00` are load inductors and bulk
capacitors picked before any generic was. So `value-is-mpn` became **`pre-resolved`**, and it now
sets a `resolved` flag that travels with the part: the UI shows a _resolved_ badge and an "already
resolved" count, and step 2 will have nothing to do for those five parts. It is a state, not a
complaint.

The general rule this leaves behind: **if the tool cannot measure the difference, it does not get to
call it an error.**

### M2b: measuring footprints

```
kinv fp measure <Library:Name | file.kicad_mod>  [--project <path>] [--svg out.svg]
kinv fp check   <project> [--all]
```

`measure` prints what the pads actually are and what the name claims, and `--svg` writes the land
pattern with its dimensions labelled, for holding against the datasheet. `check` does it for every
footprint a project uses — distinct footprints, not placements, since measuring `C_0603_1608Metric`
58 times says the same thing 58 times.

On the reference board: **45 distinct footprints, 45 resolved through the library table** (including
seven vendor libraries pointed at by the project's own `fp-lib-table`), **1 finding**, which is true:

```
W25Q16JVUXIQ_TR:USON-8_UX_2x3x0p6_WIN-L  (×1)
  ! extra-thermal-pad   name says 8 pins and there are 9 numbered pads —
                        the extra one is normally a thermal pad numbered as a pin
```

Getting there meant deleting findings, twice. The first run produced **11**, and seven were the
tool's fault:

- **`SOT-353` is not 353 pins.** `NAME-<digits>` means a pin count for QFN, SOIC, TQFP and friends,
  and means a JEDEC package code for SOT — and nothing at all for `ESP-07` or `SPDT-1101M2`. The
  pattern is now a **whitelist of families**, because guessing produced four confident wrong answers
  on one board.
- **"Unexpected exposed pad" is gone entirely.** It fired on a MOSFET's drain paddle, a USB-C
  receptacle's shield tabs and two connectors' mounting ears. Large pads are ordinary; without the
  symbol's pins there is no way to tell intent, so the finding was removed rather than downgraded.
- **A ninth pad on a USON-8 is a thermal pad, not a defect.** When the count is exactly one over and
  the name declares no exposed pad, that is the conventional "EP given a pin number" layout: `info`.

What the measurements handle, learned from real files rather than guessed:

| Trap                                                                                                           | Handling                                                                                     |
| -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| A QFN-56 has **61 `(pad …)` entries** — 56 signal, 1 exposed, 4 paste-only stencil sub-pads with empty numbers | pins are numbered _and_ on a copper layer                                                    |
| A power MOSFET spreads one drain across several pads **sharing a pad number**                                  | pad instances and distinct numbers are counted separately; the pin-count check uses distinct |
| A USB-C receptacle numbers pads `A1…B12` and `SH`                                                              | non-numeric numbering never reaches a count comparison                                       |
| An exposed pad in the middle would invent a pitch gap                                                          | pitch is measured from signal pins only, as a median over rows and columns                   |
| "Pitch" is meaningless for a 2-pad chip                                                                        | reported as _pad centres_ instead, and never compared against a name                         |

Severity follows the rule from §12: pitch, pin count and a promised-but-missing exposed pad are
**errors**; anything resting on absolute size is advisory. The `body-vs-pads` check only fires when
pads are _narrower_ than the nominal chip body — pads being wider is what a land pattern is for.

The s-expression reader underneath tracks the byte span of every node. Nothing in M2b needs that;
**step 2b's field write-back does**, and it is much easier to trust a parser that has already read
45 real footprints correctly.

### The footprint viewer and its ruler

Clicking any row in the UI's **Footprints** tab draws the land pattern and puts the measurements,
what the name claims, and the findings beside it. `/api/footprint?ref=…` serves the pads on demand
rather than shipping every footprint's geometry in the two-second poll.

The drawing is a measuring instrument, not a picture:

- **Hover reads a position in millimetres**, snapping to pad centres, corners and edge midpoints,
  and to courtyard corners — the points a datasheet's land-pattern drawing actually dimensions.
  Away from anything it reads a free position, and says so.
- **Click to drop an anchor, then move**: distance, dx and dy update live against the snapped point.
  Click again, or press Escape, to clear.
- The snap radius is defined in _screen_ pixels and divided by the current transform scale, so it
  feels the same however the drawing is sized.

Screen-to-millimetre conversion goes through `getScreenCTM().inverse()` rather than any arithmetic
of our own, so the readout stays correct no matter how the SVG is laid out.

It is tested by driving it: jsdom opens the viewer, supplies a screen transform (jsdom has no
layout), moves the pointer a hair off a pad centre and asserts it snapped to `centre, pad 1`, clicks,
moves to the other pad and asserts the readout says **4 mm** with `dx 4` — then clicks again and
asserts the ruler is gone. That test caught the one real bug in this round: `scrollIntoView` does not
exist in jsdom, and because the call sat inside the fetch promise chain, its failure was swallowed by
the `.catch` and replaced the whole drawing with an error message. Convenience calls are now wrapped
so they cannot take the drawing down with them.

#### The rotated-pad bug

The viewer drew TI's `VQFN36_RRV_TEX` with its left and right pins fused into two solid bars. The
cause was in the reader, not the drawing: `(at x y 90)` carries a **rotation angle** that was being
dropped. Each side pad is 0.254 × 0.8128 mm and they sit 0.5 mm apart — turned, they fit with room
to spare; drawn unturned, each is 0.8128 mm tall and overlaps both its neighbours.

It never showed up on the KiCad libraries because **they never rotate a pad** — a QFN there gets a
0.875 × 0.2 mm pad on one edge and 0.2 × 0.875 mm on the next, written out per edge. Only vendor
footprints rotate, and the reference board has one.

The angle now travels with the pad, and three things use it: the outer span (a rotated pad occupies
its dimensions the other way round), the drawing, and — easy to overlook — the **ruler's snap
points**, which are offsets in the pad's own frame and have to be spun with it, or the ruler snaps to
corners the pad does not have. Pad size is still reported as written, because that is the number a
datasheet quotes.

The fixture is checked in and the regression test asserts the failure mode directly: side-pad
spacing is 0.5 mm, the unrotated height 0.8128 mm exceeds it, and the rotated extent does not.

### Not everything on a board is a part

```
kinv check <project>            # test points and mounting holes left out by default
kinv check <project> --include-excluded
```

A test point is a feature of the board, not something you buy, and eight of them should not appear
as eight parts. The **Not bought** tab lists what was left out and why, so the exclusion is visible
rather than silent. On the reference board that is 11 placements over 6 lines, and the totals drop
from 354/100/95 to **343 placements · 94 lines · 89 parts**.

Three rules decide it. The second is the interesting one, and the third is yours:

1. **By class and part number** — a test point or mounting hole with no MPN in its value or fields.
   A _named_ one goes straight back in: a screw-in standoff or a bought test jack is a purchase.
2. **By geometry** — a footprint with **no solder paste and no hole** cannot be soldered to at all,
   so whatever the designator claims, it is not a part. This catches test pads a naming rule would
   miss, and on the reference board it independently flags exactly the same two `TestPoint`
   footprints — a useful cross-check rather than a second source of noise.
3. **By your say-so** — the ⊘ at the left of a row on the **Parts** tab takes that part out, and
   **buy this ↑** on a card in **Not bought** puts one back in. Nothing else on the board can tell
   the tool that these connectors come out of the drawer, that a footprint is populated by hand, or
   that this "mounting hole" is the standoff you ordered. Your answer is the last word: it overrules
   both rules above, in either direction.

The decisions are written to `.kinv/buy.json` beside the project — one line per part, sorted, so
`git diff` says what you decided and when. They belong to the board rather than to the shared
catalog, because "we hand-populate these" is a fact about this board. Both answers are recorded,
including the one that agrees with the rules: a button whose effect depends on which rule took the
part out is a button you cannot predict. `--include-excluded` sets rules and decisions alike aside
and shows the board entire.

#### Mounting, decided by physics rather than by KiCad's token

The second rule needed a better definition of how a part attaches. KiCad labels a test pad's pad
`smd`, which is misleading — nothing can be soldered to it. What actually decides it:

| has solder paste | has a hole | verdict                                           |
| ---------------- | ---------- | ------------------------------------------------- |
| yes              | no         | `smd`                                             |
| no               | yes        | `through-hole`                                    |
| **yes**          | **yes**    | `smd+through-hole` — stuck in, then reflowed      |
| no               | no         | `nothing-to-solder` — a board feature, not a part |

The reference board has all four. Three footprints are genuinely `smd+through-hole` — the USB-C
receptacle, the EDAC connector and the rotary encoder — every pad with both a hole and paste.

**`575-4`, the 4 mm bushing**, measures as a single round pad, Ø8.2 mm with a Ø4.4 mm drill, and
reports `mounting: through-hole · solder paste: none`. It is meant to be stuck in and soldered in the
SMD process, but **as drawn it has no paste aperture**, so a reflow oven would not solder it. The
tool reports the fact and leaves the decision alone — adding `F.Paste` to that pad in KiCad is what
would make it `smd+through-hole`.

#### Pads are drawn in their actual shape

Everything was drawn as a rectangle, so `575-4`'s single round pad appeared square. The viewer and
the exported SVG now honour `circle`, `oval`, `roundrect` (with its corner ratio) and `rect`, and
draw the **drill through the pad**, so a bushing reads as a bushing. `fp measure` lists the shapes
present alongside the paste coverage.

### Reference designators people actually type

IEEE 315 covers the single letters; real schematics are full of `LCD1`, `REG3`, `OPA2`, `VREG1`,
`MCU1`, `NTC2` and `H4`, because a designer would rather read the board than decode it. The prefix
table now carries about eighty entries across passives, semiconductors, connectors, mechanics and
modules, and six classes joined it: `thermistor`, `display`, `battery`, `antenna`, `sounder`,
`module`.

Two rules keep it from guessing:

- **The whole prefix must match.** `LED1` is a diode and `L1` is an inductor; `REG1` is an IC and
  `R1` is a resistor. An unrecognised prefix such as `CLK1` stays `unknown` rather than being read as
  the letter it happens to start with — and `unknown` only means the footprint casts the deciding
  vote.
- **New classes never trigger a footprint mismatch.** A display, module, battery, antenna or sounder
  is built from whatever footprint suits — a header, a pad field, a custom outline — so there is no
  expected footprint class to compare against. Thermistors group with resistors and ferrites with
  inductors for that comparison, while still keying separately: an NTC is not interchangeable with a
  plain resistor of the same value.

On the reference board every line now classifies; nothing is left `unknown`.

### Sortable tables

Every data table sorts by clicking a column header, and it is **cumulative and stable**: each click
re-sorts the rows _as they currently stand_. So clicking **Value** and then **Key** groups the rows
by key and keeps them ordered by value inside each group — which is why the sort runs over the live
row order rather than re-sorting the underlying data each time.

- Clicking a column already in the sort flips its direction and promotes it to primary.
- The chain is capped at three columns and shown in the headers: `▲1` is the primary key, `▲2` the
  tiebreaker beneath it.
- Numbers sort as numbers (9 before 10), everything else with a natural compare (R2 before R10), and
  blanks sink to the bottom.
- The order survives a re-render, so switching tabs or a live refresh does not throw it away.

### The parts table

One row per distinct part — what the order will eventually be built from. A canonical key contains
`|` characters, so this is shown as it appears rather than as a markdown table:

```
key            value  class      package  used  issues  references
C|100n|0603    100n   capacitor  0603      58×          C1001, C2004, C2005, C3004, …
C|100p|0603    100p   capacitor  0603       4×          C2001, C3001, C4021, C4022
R|10k|0402     10k    resistor   0402      19×          R1008, R6002, R7008, R7009, …
```

`used` counts placements across the whole project, and sorting by it twice puts the most-used parts
on top — which is where consolidating pays off. A part already resolved to a specific MPN carries a
`resolved` badge next to its value. Clicking a reference list copies it, ready for KiCad's search box;
hovering shows it in full.

**Getting the last column right took two attempts, and the second one is the lesson.** The
references originally wrapped, so a part with 58 of them grew a tall block and every row was a
different height. Making the cell `white-space: nowrap` with a generous `min-width` fixed the
heights and broke something worse: a column with no line breaks grows to fit its _content_, and 58
references on one line is about 3000px, so the table became far wider than the window and `used`,
`issues` and `references` were all pushed off the right-hand edge. `min-width` set a floor where a
ceiling was needed.

The fix is a clipped span — fixed width, `overflow: hidden`, ellipsis — so rows stay one line tall,
the table fits the window, and the full list is a hover or a click away. The test now asserts that
span exists, because the DOM looked perfectly correct in the broken version: only the rendered
layout was wrong, and no assertion about structure would have caught it.

### M3: watching

```
kinv watch <project>  [--summary] [--near 2] [--exclude-dnp] [--include-excluded]
```

Re-reads the project whenever you save and prints **what changed**, which is the part that makes it
useful for step 1: fix the `5K6`/`5k6` spelling in KiCad, save, and the terminal says

```
── 20:24:41  (56 ms) ─────────────────────────
343 placements · 94 BOM lines · 89 distinct parts
34 → 33 findings (−1) · 0 errors · 4 warnings · 11 not bought
```

On the reference board a full refresh — `kicad-cli` export, parse, consolidate, and measure all 45
footprints — takes about **550 ms**, comfortably inside M3's one-second target.

Four things the watcher has to get right, and none of them is the file watching itself:

- **A hierarchical save writes thirteen sheets, not one.** Everything is debounced until the
  directory has been quiet for 400 ms, so one save produces one refresh.
- **A save during a refresh queues exactly one more.** Not thirteen exports, and not a dropped
  update either.
- **A half-written schematic must not end the session.** Every failure prints and keeps watching; a
  tool you leave running all afternoon has no business exiting because it caught a file mid-save.
- **`fs.watch` is the fast path, an mtime sweep is the backstop.** Editors that save via a temporary
  file and a rename can leave a watch pointing at an inode that no longer exists, and a missed save
  is far worse than a late one.

Two bugs came out of testing this, both invisible in normal use:

- **The sweep starved the debounce.** The poll re-armed the 400 ms timer every time it saw a change,
  and with a test's fast intervals (20 ms poll, 60 ms settle) the timer never expired and the refresh
  never ran. The fix is that a poll only arms when nothing is pending — a watch event means "more
  writes may follow, wait longer", a poll means "something changed and I will keep saying so".
- **An mtime alone is not enough.** Filesystem timestamps are millisecond-fine at best, and saving a
  hierarchy writes every sheet at once, so sheets can share a timestamp. The staleness check now
  fingerprints modification time _and_ total size, and the UI's cache uses the same signature.
