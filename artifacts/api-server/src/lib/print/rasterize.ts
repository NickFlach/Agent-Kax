import type { Raster } from "./raster";

/**
 * print/rasterize.ts — deterministic SVG→raster for VECTOR MASTERS (#298).
 *
 * Not a general SVG engine and does not try to be: VTracer's output is
 * `<path d="…" fill="#hex"/>` with solid fills and nothing else, so this
 * renders exactly that subset — absolute/relative M L H V C Q Z, solid hex
 * fills, nonzero or evenodd fill rules — with a scanline fill over pixel
 * centers. Anything outside the subset throws rather than approximating:
 * a print master silently missing a feature is a defect a customer finds.
 *
 * DETERMINISTIC by construction: fixed 16-segment bézier flattening, IEEE
 * doubles, stable path order (document order), no anti-aliasing (hard
 * edges resolve identically everywhere). Same SVG + same target = same
 * RGBA = same sha256, which is what the #294 cache keys on.
 */

export const RASTERIZE_PIPELINE_VERSION = "raster-v1";
const BEZIER_SEGMENTS = 16;

interface ParsedPath {
  d: string;
  fill: [number, number, number] | null; // null = fill:none — contributes nothing
  evenOdd: boolean;
}

export interface ParsedSvg {
  width: number;
  height: number;
  paths: ParsedPath[];
}

function parseColor(s: string): [number, number, number] | null {
  const v = s.trim().toLowerCase();
  if (v === "none") return null;
  if (v === "black") return [0, 0, 0];
  if (v === "white") return [255, 255, 255];
  let m = /^#([0-9a-f]{6})$/.exec(v);
  if (m) {
    const n = parseInt(m[1]!, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  m = /^#([0-9a-f]{3})$/.exec(v);
  if (m) {
    const [r, g, b] = m[1]!;
    return [parseInt(r! + r!, 16), parseInt(g! + g!, 16), parseInt(b! + b!, 16)];
  }
  m = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/.exec(v);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  throw new Error(`unsupported fill '${s}' — the master subset is solid hex fills`);
}

/** Parse the master subset. Throws on anything outside it. */
export function parseSvgMaster(svg: string): ParsedSvg {
  const svgTag = /<svg\b[^>]*>/.exec(svg)?.[0];
  if (!svgTag) throw new Error("not an SVG document");
  let width = 0, height = 0;
  const vb = /viewBox="([\d.\s+-]+)"/.exec(svgTag);
  if (vb) {
    const parts = vb[1]!.trim().split(/\s+/).map(Number);
    if (parts.length === 4) { width = parts[2]!; height = parts[3]!; }
  }
  const wAttr = /\bwidth="([\d.]+)(?:px)?"/.exec(svgTag);
  const hAttr = /\bheight="([\d.]+)(?:px)?"/.exec(svgTag);
  if (wAttr) width = Number(wAttr[1]);
  if (hAttr) height = Number(hAttr[1]);
  if (!(width > 0 && height > 0)) throw new Error("SVG has no usable dimensions (width/height or viewBox)");

  // The subset check: elements other than svg/path/g are refusals.
  for (const m of svg.matchAll(/<([a-zA-Z][a-zA-Z0-9-]*)\b/g)) {
    const tag = m[1]!.toLowerCase();
    if (!["svg", "path", "g"].includes(tag)) {
      throw new Error(`unsupported element <${tag}> — vector masters are paths with solid fills`);
    }
  }
  if (/transform="/.test(svg)) throw new Error("unsupported attribute transform — masters are pre-transformed");

  const paths: ParsedPath[] = [];
  for (const m of svg.matchAll(/<path\b([^>]*)\/?>/g)) {
    const attrs = m[1]!;
    const d = /\bd="([^"]*)"/.exec(attrs)?.[1];
    if (!d) continue;
    const fillAttr = /\bfill="([^"]*)"/.exec(attrs)?.[1] ?? "black";
    const rule = /\bfill-rule="([^"]*)"/.exec(attrs)?.[1];
    paths.push({ d, fill: parseColor(fillAttr), evenOdd: rule === "evenodd" });
  }
  return { width, height, paths };
}

type Pt = [number, number];

/** Flatten one path's data into closed polygons, scaled. Throws off-subset. */
export function flattenPathData(d: string, sx: number, sy: number): Pt[][] {
  // Every letter is a token so an off-subset command (A, S, T, …) reaches
  // the switch and throws by NAME instead of being silently skipped.
  const tokens = d.match(/[A-Za-z]|-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/g) ?? [];
  const polys: Pt[][] = [];
  let poly: Pt[] = [];
  let cx = 0, cy = 0, startX = 0, startY = 0;
  let i = 0;
  const num = (): number => {
    const t = tokens[i++];
    const n = Number(t);
    if (!Number.isFinite(n)) throw new Error(`bad number '${t}' in path data`);
    return n;
  };
  const push = (x: number, y: number): void => {
    poly.push([x * sx, y * sy]);
  };
  const cubic = (x1: number, y1: number, x2: number, y2: number, x: number, y: number): void => {
    for (let s = 1; s <= BEZIER_SEGMENTS; s++) {
      const t = s / BEZIER_SEGMENTS, u = 1 - t;
      push(
        u * u * u * cx + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x,
        u * u * u * cy + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y,
      );
    }
    cx = x; cy = y;
  };
  const quad = (x1: number, y1: number, x: number, y: number): void => {
    for (let s = 1; s <= BEZIER_SEGMENTS; s++) {
      const t = s / BEZIER_SEGMENTS, u = 1 - t;
      push(u * u * cx + 2 * u * t * x1 + t * t * x, u * u * cy + 2 * u * t * y1 + t * t * y);
    }
    cx = x; cy = y;
  };
  let cmd = "";
  while (i < tokens.length) {
    const t = tokens[i]!;
    if (/^[a-zA-Z]$/.test(t)) { cmd = t; i++; }
    // implicit repeat keeps the previous command (M repeats as L per spec)
    else if (cmd === "M") cmd = "L";
    else if (cmd === "m") cmd = "l";

    switch (cmd) {
      case "M": case "m": {
        if (poly.length >= 3) polys.push(poly);
        poly = [];
        const x = num(), y = num();
        cx = cmd === "m" ? cx + x : x;
        cy = cmd === "m" ? cy + y : y;
        startX = cx; startY = cy;
        push(cx, cy);
        break;
      }
      case "L": case "l": {
        const x = num(), y = num();
        cx = cmd === "l" ? cx + x : x;
        cy = cmd === "l" ? cy + y : y;
        push(cx, cy);
        break;
      }
      case "H": case "h": {
        const x = num();
        cx = cmd === "h" ? cx + x : x;
        push(cx, cy);
        break;
      }
      case "V": case "v": {
        const y = num();
        cy = cmd === "v" ? cy + y : y;
        push(cx, cy);
        break;
      }
      case "C": case "c": {
        const rel = cmd === "c";
        const x1 = num() + (rel ? cx : 0), y1 = num() + (rel ? cy : 0);
        const x2 = num() + (rel ? cx : 0), y2 = num() + (rel ? cy : 0);
        const x = num() + (rel ? cx : 0), y = num() + (rel ? cy : 0);
        cubic(x1, y1, x2, y2, x, y);
        break;
      }
      case "Q": case "q": {
        const rel = cmd === "q";
        const x1 = num() + (rel ? cx : 0), y1 = num() + (rel ? cy : 0);
        const x = num() + (rel ? cx : 0), y = num() + (rel ? cy : 0);
        quad(x1, y1, x, y);
        break;
      }
      case "Z": case "z": {
        cx = startX; cy = startY;
        if (poly.length >= 3) polys.push(poly);
        poly = [];
        break;
      }
      default:
        throw new Error(`unsupported path command '${cmd}' — the master subset is M L H V C Q Z`);
    }
  }
  if (poly.length >= 3) polys.push(poly);
  return polys;
}

/**
 * Render at exactly (targetW, targetH). White opaque ground (print paper),
 * paths painted in document order, nonzero winding unless the path says
 * evenodd, pixel centers, no anti-aliasing.
 */
export function renderSvgMaster(svg: string, targetW: number, targetH: number): Raster {
  const parsed = parseSvgMaster(svg);
  const sx = targetW / parsed.width;
  const sy = targetH / parsed.height;
  const data = new Uint8ClampedArray(targetW * targetH * 4).fill(255);

  for (const p of parsed.paths) {
    if (!p.fill) continue;
    const polys = flattenPathData(p.d, sx, sy);
    if (polys.length === 0) continue;
    // Edge list across all subpaths (winding crosses subpaths — that is
    // what makes holes work in nonzero AND evenodd).
    const edges: Array<[number, number, number, number]> = [];
    let minY = Infinity, maxY = -Infinity;
    for (const poly of polys) {
      for (let j = 0; j < poly.length; j++) {
        const [x0, y0] = poly[j]!;
        const [x1, y1] = poly[(j + 1) % poly.length]!;
        if (y0 !== y1) edges.push([x0, y0, x1, y1]);
        if (y0 < minY) minY = y0;
        if (y0 > maxY) maxY = y0;
      }
    }
    const [r, g, b] = p.fill;
    const yStart = Math.max(0, Math.floor(minY));
    const yEnd = Math.min(targetH - 1, Math.ceil(maxY));
    for (let py = yStart; py <= yEnd; py++) {
      const yc = py + 0.5;
      // Crossings with their winding directions at this scanline.
      const xs: Array<[number, number]> = [];
      for (const [x0, y0, x1, y1] of edges) {
        if ((y0 <= yc && y1 > yc) || (y1 <= yc && y0 > yc)) {
          const x = x0 + ((yc - y0) / (y1 - y0)) * (x1 - x0);
          xs.push([x, y1 > y0 ? 1 : -1]);
        }
      }
      xs.sort((a, b2) => a[0] - b2[0]);
      let winding = 0;
      for (let k = 0; k < xs.length - 1; k++) {
        winding += xs[k]![1]!;
        const inside = p.evenOdd ? (k + 1) % 2 === 1 : winding !== 0;
        if (!inside) continue;
        const xFrom = Math.max(0, Math.ceil(xs[k]![0]! - 0.5));
        const xTo = Math.min(targetW - 1, Math.floor(xs[k + 1]![0]! - 0.5));
        for (let px = xFrom; px <= xTo; px++) {
          const o = (py * targetW + px) * 4;
          data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = 255;
        }
      }
    }
  }
  return { width: targetW, height: targetH, data };
}
