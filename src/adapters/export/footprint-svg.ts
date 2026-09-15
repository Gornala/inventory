import type { Measurement, MeasuredPad } from "../../core/footprint/measure.js";
import { isPin, padExtents } from "../../core/footprint/measure.js";

export type SvgOptions = {
  title?: string;
  /** Pixels per millimetre. */
  scale?: number;
};

function fmt(n: number): string {
  return String(Number(n.toFixed(3)));
}

/**
 * Draws the land pattern with its measurements labelled, for holding next to
 * the datasheet's recommended pattern. It only ever draws what was measured —
 * that is what makes it safe to trust at a glance.
 */
export function footprintSvg(
  pads: readonly MeasuredPad[],
  measured: Measurement,
  options: SvgOptions = {},
): string {
  const scale = options.scale ?? 40;
  const pins = pads.filter(isPin);
  if (pins.length === 0) return "<svg xmlns='http://www.w3.org/2000/svg' width='1' height='1'/>";

  const xs = pins.flatMap((p) => {
    const e = padExtents(p);
    return [p.x - e.w / 2, p.x + e.w / 2];
  });
  const ys = pins.flatMap((p) => {
    const e = padExtents(p);
    return [p.y - e.h / 2, p.y + e.h / 2];
  });
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  const margin = Math.max(1.2, (maxX - minX) * 0.18);
  const vbX = minX - margin;
  const vbY = minY - margin;
  const vbW = maxX - minX + margin * 2;
  const vbH = maxY - minY + margin * 2;

  const stroke = Math.max(0.02, vbW / 600);
  const font = Math.max(0.18, vbW / 34);

  const padRects = pins
    .map((pad) => {
      const isEp = measured.exposedPads.some(
        (e) => e.width === pad.width && e.height === pad.height,
      );
      // SVG's positive rotation is clockwise in a y-down system; KiCad's is
      // counter-clockwise, hence the negated angle.
      const spin =
        pad.angle === 0
          ? ""
          : ` transform="rotate(${fmt(-pad.angle)} ${fmt(pad.x)} ${fmt(pad.y)})"`;
      return (
        `<rect class="${isEp ? "ep" : "pad"}" x="${fmt(pad.x - pad.width / 2)}" ` +
        `y="${fmt(pad.y - pad.height / 2)}" width="${fmt(pad.width)}" height="${fmt(pad.height)}" ` +
        `rx="${fmt(Math.min(pad.width, pad.height) * 0.12)}"${spin}/>`
      );
    })
    .join("");

  // Pin numbers only when they will not turn the drawing into a smudge.
  const labels =
    pins.length <= 24
      ? pins
          .map(
            (pad) =>
              `<text class="num" x="${fmt(pad.x)}" y="${fmt(pad.y + font * 0.35)}">${pad.number}</text>`,
          )
          .join("")
      : "";

  const dimY = maxY + margin * 0.55;
  const dimX = maxX + margin * 0.55;
  const arrows =
    `<g class="dim">` +
    `<line x1="${fmt(minX)}" y1="${fmt(dimY)}" x2="${fmt(maxX)}" y2="${fmt(dimY)}"/>` +
    `<text x="${fmt((minX + maxX) / 2)}" y="${fmt(dimY + font * 1.1)}">${fmt(measured.span.x)} mm</text>` +
    `<line x1="${fmt(dimX)}" y1="${fmt(minY)}" x2="${fmt(dimX)}" y2="${fmt(maxY)}"/>` +
    `<text class="rot" x="${fmt(dimX + font * 0.9)}" y="${fmt((minY + maxY) / 2)}" ` +
    `transform="rotate(90 ${fmt(dimX + font * 0.9)} ${fmt((minY + maxY) / 2)})">${fmt(measured.span.y)} mm</text>` +
    `</g>`;

  const notes = [
    `${measured.padCount} pads`,
    measured.pitch !== undefined
      ? `${pins.length === 2 ? "centres" : "pitch"} ${fmt(measured.pitch)} mm`
      : undefined,
    measured.padSize
      ? `pad ${fmt(measured.padSize.width)} × ${fmt(measured.padSize.height)} mm`
      : undefined,
    measured.exposedPads[0]
      ? `EP ${fmt(measured.exposedPads[0].width)} × ${fmt(measured.exposedPads[0].height)} mm`
      : undefined,
    measured.mounting,
  ]
    .filter((n): n is string => n !== undefined)
    .join("   ·   ");

  const width = Math.round(vbW * scale);
  const height = Math.round(vbH * scale) + 26;

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="${fmt(vbX)} ${fmt(vbY)} ${fmt(vbW)} ${fmt(vbH + 26 / scale)}" ` +
    `font-family="ui-monospace, monospace">` +
    `<style>
      .pad { fill: #c8721f; }
      .ep { fill: #8a5a2b; }
      .num { fill: #fff; font-size: ${fmt(font * 0.6)}px; text-anchor: middle; }
      .dim line { stroke: #7c7970; stroke-width: ${fmt(stroke)}; }
      .dim text { fill: #7c7970; font-size: ${fmt(font * 0.7)}px; text-anchor: middle; }
      .note { fill: #57534a; font-size: ${fmt(font * 0.7)}px; }
      .title { fill: #1c1a17; font-size: ${fmt(font * 0.8)}px; }
      @media (prefers-color-scheme: dark) {
        .pad { fill: #e8934a; } .ep { fill: #a8703a; }
        .num { fill: #1a1a1a; }
        .note { fill: #9b958c; } .title { fill: #e8e6e3; }
      }
    </style>` +
    (options.title === undefined
      ? ""
      : `<text class="title" x="${fmt(vbX + margin * 0.1)}" y="${fmt(vbY + font)}">${escapeXml(options.title)}</text>`) +
    padRects +
    labels +
    arrows +
    `<text class="note" x="${fmt(vbX + margin * 0.1)}" y="${fmt(vbY + vbH + 18 / scale)}">${escapeXml(notes)}</text>` +
    `</svg>`
  );
}

function escapeXml(s: string): string {
  return s.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string,
  );
}
