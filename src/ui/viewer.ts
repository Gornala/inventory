/**
 * Client-side footprint viewer and measuring tool.
 *
 * Kept in its own file because it is browser JavaScript embedded in a template
 * literal: it must contain no backslash escapes and no dollar-brace, either of
 * which is consumed by the literal and reaches the browser as a syntax error.
 */
export const viewerScript = `
var fpDetail = null;
var fpAnchor = null;
var fpSnaps = [];
/** Reference of the row being viewed, so it stays marked across re-renders. */
var fpSelected = null;

function fpMarkSelected() {
  var rows = document.querySelectorAll("[data-fp]");
  for (var i = 0; i < rows.length; i++) {
    rows[i].classList.toggle("sel", rows[i].dataset.fp === fpSelected);
  }
}

function fpNum(n, digits) {
  if (n === null || n === undefined) return "—";
  return String(Number(n.toFixed(digits === undefined ? 3 : digits)));
}

/**
 * Points worth snapping to. Pad centres and corners are what a datasheet's
 * land-pattern drawing dimensions, so those are what the ruler should land on.
 */
function fpSnapPoints(d) {
  var pts = [];
  d.pads.forEach(function (p) {
    var onCopper = p.layers.some(function (l) { return l.indexOf(".Cu") >= 0; });
    if (!onCopper) return;
    var hw = p.width / 2, hh = p.height / 2;
    var label = p.number ? "pad " + p.number : "pad";
    // Offsets are in the pad's own frame, so they have to be spun with it —
    // otherwise the ruler snaps to corners the pad does not have.
    var rad = (-(p.angle || 0) * Math.PI) / 180;
    var cos = Math.cos(rad), sin = Math.sin(rad);
    var at = function (dx, dy, what) {
      pts.push({ x: p.x + dx * cos - dy * sin, y: p.y + dx * sin + dy * cos, what: what });
    };
    at(0, 0, "centre, " + label);
    [-1, 1].forEach(function (sx) {
      [-1, 1].forEach(function (sy) {
        at(sx * hw, sy * hh, "corner, " + label);
      });
      at(sx * hw, 0, "edge, " + label);
      at(0, sx * hh, "edge, " + label);
    });
  });
  if (d.courtyard) {
    var c = d.courtyard;
    [[c.x, c.y], [c.x + c.width, c.y], [c.x, c.y + c.height], [c.x + c.width, c.y + c.height]]
      .forEach(function (pt) { pts.push({ x: pt[0], y: pt[1], what: "courtyard corner" }); });
  }
  return pts;
}

/** Axis-aligned space a pad occupies once its rotation is applied. */
function fpExtents(p) {
  var a = (((p.angle || 0) % 180) + 180) % 180;
  if (a === 0) return { w: p.width, h: p.height };
  if (a === 90) return { w: p.height, h: p.width };
  var r = (a * Math.PI) / 180;
  var c = Math.abs(Math.cos(r)), s = Math.abs(Math.sin(r));
  return { w: p.width * c + p.height * s, h: p.width * s + p.height * c };
}

function fpBounds(d) {
  var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  d.pads.forEach(function (p) {
    var e = fpExtents(p);
    minX = Math.min(minX, p.x - e.w / 2);
    maxX = Math.max(maxX, p.x + e.w / 2);
    minY = Math.min(minY, p.y - e.h / 2);
    maxY = Math.max(maxY, p.y + e.h / 2);
  });
  if (d.courtyard) {
    minX = Math.min(minX, d.courtyard.x);
    minY = Math.min(minY, d.courtyard.y);
    maxX = Math.max(maxX, d.courtyard.x + d.courtyard.width);
    maxY = Math.max(maxY, d.courtyard.y + d.courtyard.height);
  }
  var pad = Math.max(0.4, (maxX - minX) * 0.08);
  return { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 };
}

function fpSvg(d) {
  var b = fpBounds(d);
  var isEp = function (p) {
    return d.measured.exposedPads.some(function (e) {
      return e.width === p.width && e.height === p.height;
    });
  };
  var body = "";

  if (d.courtyard) {
    body += '<rect class="crtyd" x="' + d.courtyard.x + '" y="' + d.courtyard.y +
      '" width="' + d.courtyard.width + '" height="' + d.courtyard.height + '"/>';
  }

  d.pads.forEach(function (p, i) {
    var onCopper = p.layers.some(function (l) { return l.indexOf(".Cu") >= 0; });
    var cls = onCopper ? (isEp(p) ? "ep" : "pad") : "paste";
    // SVG rotates clockwise in a y-down system, KiCad counter-clockwise.
    var spin = p.angle ? ' transform="rotate(' + -p.angle + " " + p.x + " " + p.y + ')"' : "";
    body += fpShape(p, cls, ' data-pad="' + i + '"' + spin);
    // The hole, drawn through the pad so a bushing reads as a bushing.
    if (p.drill) {
      body += '<circle class="drill" cx="' + p.x + '" cy="' + p.y + '" r="' + p.drill / 2 + '"/>';
    }
  });

  var pins = d.pads.filter(function (p) { return p.number; });
  if (pins.length <= 32) {
    var fs = b.w / 40;
    pins.forEach(function (p) {
      body += '<text class="pnum" x="' + p.x + '" y="' + (p.y + fs * 0.35) +
        '" style="font-size:' + fs + 'px">' + esc(p.number) + "</text>";
    });
  }

  // Overlay, updated in place as the pointer moves.
  body += '<line id="fpruler" class="ruler" x1="0" y1="0" x2="0" y2="0" style="display:none"/>' +
    '<circle id="fpanchor" class="mark" r="' + b.w / 220 + '" style="display:none"/>' +
    '<circle id="fpsnap" class="mark snap" r="' + b.w / 260 + '" style="display:none"/>';

  return '<svg id="fpsvg" viewBox="' + b.x + " " + b.y + " " + b.w + " " + b.h +
    '" preserveAspectRatio="xMidYMid meet">' + body + "</svg>";
}

/**
 * Draws a pad in its actual shape. Everything was a rectangle until a 4 mm
 * bushing with a single round pad turned up looking square.
 */
function fpShape(p, cls, extra) {
  var attrs = 'class="' + cls + '"' + extra;
  if (p.shape === "circle" || (p.shape === "oval" && p.width === p.height)) {
    return "<circle " + attrs + ' cx="' + p.x + '" cy="' + p.y + '" r="' + p.width / 2 + '"/>';
  }
  var rx = p.shape === "oval"
    ? Math.min(p.width, p.height) / 2
    : p.shape === "roundrect"
      ? Math.min(p.width, p.height) * (p.roundrectRatio || 0.25)
      : p.shape === "rect" || p.shape === "trapezoid"
        ? 0
        : Math.min(p.width, p.height) * 0.12;
  return "<rect " + attrs + ' x="' + (p.x - p.width / 2) + '" y="' + (p.y - p.height / 2) +
    '" width="' + p.width + '" height="' + p.height + '" rx="' + rx + '"/>';
}

function fpPanel(d) {
  var m = d.measured, n = d.declared;
  var claims = [
    n.pinCount ? n.pinCount + " pins" : null,
    n.pitch ? n.pitch + " mm pitch" : null,
    n.body ? "body " + n.body.x + " × " + n.body.y + " mm" : null,
    n.chip ? "chip " + n.chip.imperial : null,
    n.exposedPad ? "exposed pad" : null
  ].filter(Boolean).join(" · ") || "nothing";

  var rows = [
    ["pads", m.padCount + (m.pasteOnlyPads ? " (+" + m.pasteOnlyPads + " paste-only)" : "")],
    [m.padCount === 2 ? "pad centres" : "pitch", fpNum(m.pitch) + " mm"],
    ["outer span", fpNum(m.span.x) + " × " + fpNum(m.span.y) + " mm"],
    ["pad size", m.padSize ? fpNum(m.padSize.width) + " × " + fpNum(m.padSize.height) + " mm" : "—"],
    ["exposed pad", m.exposedPads.length
      ? fpNum(m.exposedPads[0].width) + " × " + fpNum(m.exposedPads[0].height) + " mm" : "—"],
    ["courtyard", d.courtyard
      ? fpNum(d.courtyard.width) + " × " + fpNum(d.courtyard.height) + " mm" : "—"],
    ["mounting", m.mounting + ((m.shapes || []).length ? "  (" + m.shapes.join(", ") + ")" : "")],
    ["solder paste", !m.pinsWithPaste
      ? "none — a reflow oven will not solder this"
      : m.pinsWithPaste + " of " + m.padCount + " pads"],
    ["drills", m.drills.length ? m.drills.map(function (x) { return fpNum(x); }).join(", ") + " mm" : "—"]
  ];

  return '<div class="fpmeta"><table class="kv">' +
    rows.map(function (r) {
      return "<tr><th>" + esc(r[0]) + "</th><td>" + esc(String(r[1])) + "</td></tr>";
    }).join("") +
    '<tr><th>name claims</th><td>' + esc(claims) + "</td></tr></table>" +
    (d.findings.length
      ? d.findings.map(function (f) {
          return '<div class="fpfind"><span class="sev ' + f.severity + '">' + esc(f.code) +
            "</span> " + esc(f.message) + "</div>";
        }).join("")
      : '<div class="fpfind ok">✓ geometry agrees with the name</div>') +
    '<div class="fppath">' + esc(d.path) + "</div></div>";
}

function fpRender() {
  var host = document.getElementById("fpview");
  if (!host || !fpDetail) return;
  host.innerHTML =
    '<div class="card fpcard"><div class="head"><span class="key">' + esc(fpDetail.reference) +
    '</span><button class="linkish" id="fpclose">close</button></div>' +
    '<div class="fpgrid"><div class="fpstage">' + fpSvg(fpDetail) +
    '<div class="fpread" id="fpread">hover to read a position · click to start measuring</div>' +
    "</div>" + fpPanel(fpDetail) + "</div></div>";

  fpSnaps = fpSnapPoints(fpDetail);
  fpAnchor = null;
  fpAttach();
}

function fpAttach() {
  var svg = document.getElementById("fpsvg");
  if (!svg) return;

  function toMm(evt) {
    var ctm = svg.getScreenCTM();
    if (!ctm) return null;
    var pt = svg.createSVGPoint();
    pt.x = evt.clientX;
    pt.y = evt.clientY;
    var p = pt.matrixTransform(ctm.inverse());
    return { x: p.x, y: p.y, scale: ctm.a || 1 };
  }

  function snapTo(p) {
    // Snap radius is constant on screen, so zooming does not change the feel.
    var limit = 9 / p.scale;
    var best = null, bestD = limit;
    fpSnaps.forEach(function (s) {
      var d = Math.hypot(s.x - p.x, s.y - p.y);
      if (d < bestD) { bestD = d; best = s; }
    });
    return best || { x: p.x, y: p.y, what: null };
  }

  svg.addEventListener("mousemove", function (evt) {
    var raw = toMm(evt);
    if (!raw) return;
    var s = snapTo(raw);

    var marker = document.getElementById("fpsnap");
    marker.setAttribute("cx", s.x);
    marker.setAttribute("cy", s.y);
    marker.style.display = "";
    marker.classList.toggle("free", !s.what);

    var read = document.getElementById("fpread");
    if (fpAnchor) {
      var dx = s.x - fpAnchor.x, dy = s.y - fpAnchor.y;
      var line = document.getElementById("fpruler");
      line.setAttribute("x1", fpAnchor.x);
      line.setAttribute("y1", fpAnchor.y);
      line.setAttribute("x2", s.x);
      line.setAttribute("y2", s.y);
      line.style.display = "";
      read.innerHTML = "<b>" + fpNum(Math.hypot(dx, dy)) + " mm</b>" +
        '<span class="muted">  dx ' + fpNum(Math.abs(dx)) + "  dy " + fpNum(Math.abs(dy)) +
        (s.what ? "  → " + esc(s.what) : "") + "  · click to clear</span>";
    } else {
      read.innerHTML = fpNum(s.x) + ", " + fpNum(s.y) + " mm" +
        '<span class="muted">' + (s.what ? "  " + esc(s.what) : "  free") +
        "  · click to start measuring</span>";
    }
  });

  svg.addEventListener("click", function (evt) {
    var raw = toMm(evt);
    if (!raw) return;
    if (fpAnchor) {
      fpAnchor = null;
      document.getElementById("fpruler").style.display = "none";
      document.getElementById("fpanchor").style.display = "none";
      return;
    }
    var s = snapTo(raw);
    fpAnchor = { x: s.x, y: s.y };
    var a = document.getElementById("fpanchor");
    a.setAttribute("cx", s.x);
    a.setAttribute("cy", s.y);
    a.style.display = "";
  });

  svg.addEventListener("mouseleave", function () {
    var marker = document.getElementById("fpsnap");
    if (marker) marker.style.display = "none";
  });
}

document.addEventListener("keydown", function (e) {
  if (e.key !== "Escape") return;
  if (fpAnchor) {
    fpAnchor = null;
    var line = document.getElementById("fpruler");
    var a = document.getElementById("fpanchor");
    if (line) line.style.display = "none";
    if (a) a.style.display = "none";
  } else if (fpDetail) {
    fpClose();
  }
});

/** Takes the drawing off screen but remembers it — for leaving the tab. */
function fpClearView() {
  var host = document.getElementById("fpview");
  if (host) host.innerHTML = "";
}

/** Puts it back when the tab returns, and re-marks the row. */
function fpRestore() {
  if (fpDetail) fpRender();
  fpMarkSelected();
}

/** Actually done with it — for the close button and Escape. */
function fpClose() {
  fpDetail = null;
  fpSelected = null;
  fpClearView();
  fpMarkSelected();
}

function fpOpen(ref) {
  var host = document.getElementById("fpview");
  fpSelected = ref;
  fpMarkSelected();
  if (host) host.innerHTML = '<p class="empty">reading ' + esc(ref) + "…</p>";
  fetch("/api/footprint?ref=" + encodeURIComponent(ref))
    .then(function (r) {
      if (!r.ok) return r.text().then(function (t) { throw new Error(t); });
      return r.json();
    })
    .then(function (d) {
      fpDetail = d;
      fpRender();
      // A convenience, and not available everywhere: never let it take the
      // drawing down with it.
      try {
        if (host && host.scrollIntoView) host.scrollIntoView({ block: "nearest" });
      } catch (ignored) { /* no scrolling, no problem */ }
    })
    .catch(function (e) {
      if (host) host.innerHTML = '<p class="empty">' + esc(e.message) + "</p>";
    });
}

document.addEventListener("click", function (e) {
  var row = e.target.closest("[data-fp]");
  if (row) { fpOpen(row.dataset.fp); return; }
  if (e.target.id === "fpclose") fpClose();
});
`;
