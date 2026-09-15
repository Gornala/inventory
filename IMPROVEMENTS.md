# Improvements

The running list for the next round of work. `kinv` is **in service** — it is being used on real
boards, and this file is where what those boards turn up gets written down.

## How to add something

One entry, newest at the top of its section, with enough context to act on months later:

```markdown
- **Short name.** What happened, on which board, and what you expected instead. Paste the key, the
  reference or the command if there is one.
```

The board and the key matter more than the diagnosis — "R|10k|0402 showed up twice on transformer_v3"
is worth more than a guess at why. If it is reproducible from a fixture, say which.

---

## Found in use

- **The customer-reference column had to go.** The upload files carried a third column,
  `Customer Reference`, holding the canonical key. It is now off by default in both the UI export
  and `kinv order`; `--reference` puts it back. What is lost with it is the bench-side match from a
  bag of parts to a line, so if that turns out to be missed, the answer is probably to print it
  rather than to upload it.

---

## Known, not yet acted on

Carried over from the build. None of these blocked shipping; each is a real thing.

### Verification gaps

- **KiCad 8 is untested.** The field writer is proven byte-identical on KiCad 9 and 10 fixtures, but
  there is no genuine KiCad 8 file to hand. See `tests/fixtures/kicad9/README.md`.
- **The BOM export is simulated in the round-trip test.** `kicad-cli` is not on the CI machine, so
  `tests/ui/schematic-sync.test.ts` stands it in with a CSV built from the schematic's own field
  names. Each half is tested against real files; only the export step between them is stubbed. A
  test guarded on `liveProject()` would close this.
- **The full-width table layout was never seen.** `main.wide` lost its cap and the description column
  absorbs the slack, both reasoned from the CSS rather than measured — there is no headless browser
  in the project. If a column hogs the room or collapses on a narrow window, the knob is
  `td.bom { min-width }` in `src/ui/page.ts`.
- **One unattributed test error, once.** A full run reported a single error with no failing test and
  it did not reproduce in three consecutive runs afterwards. Not diagnosed. If it comes back, the
  first place to look is JSDOM teardown racing a fetch that is still in flight.

### Decisions worth revisiting after real use

- **The schematic read-back is manual.** `kinv fields read` and its button both require a click, on
  the principle that reading a file is not permission to write a catalog that outlives the board.
  After a few projects it may turn out that adopting on open is what you actually want.
- **Vendor spellings are not folded.** `digikey` and `DigiKey` are two entries in the completion
  list, deliberately, so the drift is visible and you can fix it. If it turns out to be noise rather
  than signal, the fold goes in `vendorList` in `src/ui/page.ts`.
- **A conflicting MPN is reported and left alone.** The schematic and the catalog disagreeing means
  one of them moved on; the tool refuses to guess which, and that part is settled. What is open is
  ergonomics: if in practice the schematic is nearly always the newer one, a "take the schematic's"
  button on those rows would save work without the tool deciding anything.
- **The export directory is remembered for the session only.** Pressing **export CSVs** opens the OS
  folder dialog starting where the last export went; restart `kinv ui` and it starts beside the
  board again. Persisting it would mean a machine-local path in a store, and `.kinv/` is git-tracked
  and travels — `~/.kinv/` keyed by project is the shape it would take if a few real sessions show
  the re-navigation is a nuisance.
- **The folder dialog is proven to open, not to return.** `folderPickers` is unit-tested per
  platform, and on Windows the dialog was found on the desktop by window enumeration — titled
  "Ordner suchen", `topmost=True foreground=True`, about 2.4 s after the spawn — but no test clicks
  OK, because no CI runner has a desktop. The paths through `chooseFolder` after an answer (chosen,
  cancelled, unavailable) are covered with the picker stood in for; what is untested is the OS
  dialog's own answer on macOS and Linux. Nothing checks the _z-order_ automatically either: two
  attempts put the dialog behind the browser and only a hand-run enumeration caught it. If it hides
  again, that probe is the tool — `EnumWindows` filtered by the picker's pid, reading
  `GetWindowLong(h, -20) & WS_EX_TOPMOST`.
- **Two seconds is a long time for a button.** Almost all of it is `Add-Type -AssemblyName
System.Windows.Forms` in a cold PowerShell. The button says what it is waiting for, which is
  enough — but if it starts to grate, the fast paths are the `Shell.Application` COM browser (no
  assembly load, and no owner to make it topmost) or a tiny helper kept warm between presses.
- **`package` on a catalog part is never filled in for you.** Copying the board's own package there
  would make the part-vs-pads check always pass. Worth confirming that the check earns its keep once
  a few real mismatches have gone past.

### Not built

- **Mouser and LCSC order-file dialects.** Only the generic
  `Quantity, Part Number, Customer Reference` form is written today.

---

## Settled — do not re-open without a reason

These are closed. If a board makes one of them look wrong, that is a finding worth writing down
above; short of that, they are answers, not open items.

- **The tool reports, the designer decides.** Tolerance and voltage are never merged, footprints are
  never changed, an MPN is never assigned from a guess, and vendor spellings are never folded
  together. Every one of those is the same rule: the person choosing the part is the one who knows
  that this divider is the feedback network, and a tool that quietly decided would be making a call
  it cannot be accountable for. Special parts are the designer's to take care of.
  (README §8.2, §2.)
- **No global inventory.** What is on the shelf, pooled across boards, with demand rolled up across
  projects, is a different tool. This one stops at "what does this board need, and where do I buy
  it". M7 (`kinv receive`, stock adjustments) is dropped for this reason, and there will be no
  database. The _catalog_ is still shared across every board — what a part is and who sells it is
  worth deciding once — but a count of how many are in the drawer is not tracked. (README §8.3.)
