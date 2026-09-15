/**
 * Click-to-sort for every data table.
 *
 * Sorting is **cumulative and stable**: each click re-sorts the rows as they
 * currently stand, so clicking Value and then Key groups the rows by key and
 * keeps them ordered by value inside each group. That is the whole reason it
 * sorts the live row order rather than the original data.
 *
 * Browser JavaScript in a template literal: no backslash escapes, no
 * dollar-brace.
 */
export const sortScript = `
/** table id -> [{ col, dir }], oldest click first. */
var sortChains = {};

function sortKey(row, col) {
  var cell = row.children[col];
  if (!cell) return "";
  var raw = cell.dataset && cell.dataset.sort !== undefined
    ? cell.dataset.sort
    : cell.textContent.trim();
  return raw;
}

function sortCompare(a, b) {
  // Numbers compare as numbers, so 9 sorts before 10; everything else uses a
  // natural compare so R2 sorts before R10.
  var na = parseFloat(a), nb = parseFloat(b);
  var aNum = a !== "" && !isNaN(na) && String(na) === a.trim();
  var bNum = b !== "" && !isNaN(nb) && String(nb) === b.trim();
  if (aNum && bNum) return na - nb;
  if (a === "") return 1;
  if (b === "") return -1;
  return a.localeCompare(b, "en", { numeric: true, sensitivity: "base" });
}

function applySort(table) {
  var chain = sortChains[table.id] || [];
  var body = table.tBodies[0];
  if (!body) return;
  var rows = Array.prototype.slice.call(body.rows);

  // Oldest click first: later clicks become the outer grouping, and a stable
  // sort preserves the order the earlier ones established.
  chain.forEach(function (step) {
    rows.sort(function (x, y) {
      var r = sortCompare(sortKey(x, step.col), sortKey(y, step.col));
      return step.dir === "desc" ? -r : r;
    });
  });

  rows.forEach(function (row) { body.appendChild(row); });

  var heads = table.tHead ? table.tHead.rows[0].cells : [];
  for (var i = 0; i < heads.length; i++) {
    var pos = -1;
    for (var j = 0; j < chain.length; j++) if (chain[j].col === i) pos = j;
    heads[i].classList.toggle("sorted", pos >= 0);
    var marker = heads[i].querySelector(".sortmark");
    if (!marker) continue;
    if (pos < 0) {
      marker.textContent = "";
    } else {
      // Rank shown from the outside in: the last click is the primary key.
      var rank = chain.length - pos;
      marker.textContent =
        (chain[pos].dir === "desc" ? "▼" : "▲") + (chain.length > 1 ? String(rank) : "");
    }
  }
}

/** Re-applies the stored order after a re-render. */
function restoreSorts() {
  var tables = document.querySelectorAll("table[id]");
  for (var i = 0; i < tables.length; i++) {
    if (sortChains[tables[i].id]) applySort(tables[i]);
  }
}

document.addEventListener("click", function (e) {
  var th = e.target.closest ? e.target.closest("th[data-col]") : null;
  if (!th) return;
  var table = th.closest("table");
  if (!table || !table.id) return;

  var col = Number(th.dataset.col);
  var chain = sortChains[table.id] || [];
  var existing = null;
  for (var i = 0; i < chain.length; i++) if (chain[i].col === col) existing = chain[i];

  // Clicking a column already in the chain flips it and promotes it to
  // primary; a fresh column joins as primary with the rest kept underneath.
  chain = chain.filter(function (s) { return s.col !== col; });
  chain.push({ col: col, dir: existing && existing.dir === "asc" ? "desc" : "asc" });
  if (chain.length > 3) chain.shift();

  sortChains[table.id] = chain;
  applySort(table);
});
`;
