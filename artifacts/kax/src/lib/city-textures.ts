import * as THREE from "three";

/**
 * Procedural "photo-ish" material textures for the 3D market district.
 *
 * Every texture is drawn once on an offscreen canvas with a seeded PRNG and
 * cached by its parameter key, so the whole street costs a handful of canvas
 * rasters at mount and stays deterministic frame-to-frame (and across HMR).
 * No network fetches: the district renders identically offline, and there is
 * no CDN/CORS failure mode that could regress the scene to untextured gray.
 */

const cache = new Map<string, THREE.CanvasTexture>();

/** mulberry32 — tiny deterministic PRNG so textures never shimmer across renders. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeCanvas(size: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const ctx = c.getContext("2d")!;
  return [c, ctx];
}

function finish(key: string, canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  cache.set(key, tex);
  return tex;
}

/** Clone a cached texture with its own repeat (clones share the bitmap). */
export function repeated(tex: THREE.CanvasTexture, rx: number, ry: number): THREE.CanvasTexture {
  const t = tex.clone() as THREE.CanvasTexture;
  t.repeat.set(rx, ry);
  t.needsUpdate = true;
  return t;
}

/** Fine value-noise speckle over the current canvas state. */
function speckle(
  ctx: CanvasRenderingContext2D,
  rnd: () => number,
  size: number,
  count: number,
  alpha: number,
  light: string,
  dark: string,
  maxR = 1.6,
) {
  for (let i = 0; i < count; i++) {
    ctx.fillStyle = rnd() > 0.5 ? light : dark;
    ctx.globalAlpha = alpha * (0.3 + rnd() * 0.7);
    const r = 0.4 + rnd() * maxR;
    ctx.beginPath();
    ctx.arc(rnd() * size, rnd() * size, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

// ── Street surfaces ─────────────────────────────────────────────────

export function asphaltTexture(): THREE.CanvasTexture {
  const key = "asphalt";
  if (cache.has(key)) return cache.get(key)!;
  const S = 512;
  const [c, ctx] = makeCanvas(S);
  const rnd = prng(101);
  ctx.fillStyle = "#323335";
  ctx.fillRect(0, 0, S, S);
  // Large soft tonal patches (repaired asphalt, oil shadow)
  for (let i = 0; i < 14; i++) {
    const g = ctx.createRadialGradient(rnd() * S, rnd() * S, 10, rnd() * S, rnd() * S, 60 + rnd() * 120);
    const v = rnd() > 0.5 ? 255 : 0;
    g.addColorStop(0, `rgba(${v},${v},${v},${0.03 + rnd() * 0.05})`);
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S);
  }
  // Aggregate speckle — the grain that makes asphalt read as asphalt
  speckle(ctx, rnd, S, 9000, 0.5, "#4a4b4e", "#232425", 1.3);
  speckle(ctx, rnd, S, 900, 0.8, "#5a5b5f", "#1b1c1d", 0.8);
  // Hairline cracks
  ctx.strokeStyle = "rgba(15,15,16,0.55)";
  for (let i = 0; i < 7; i++) {
    ctx.lineWidth = 0.6 + rnd();
    ctx.beginPath();
    let x = rnd() * S;
    let y = rnd() * S;
    ctx.moveTo(x, y);
    const segs = 5 + Math.floor(rnd() * 7);
    for (let s = 0; s < segs; s++) {
      x += (rnd() - 0.5) * 90;
      y += (rnd() - 0.5) * 90;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  return finish(key, c);
}

export function sidewalkTexture(): THREE.CanvasTexture {
  const key = "sidewalk";
  if (cache.has(key)) return cache.get(key)!;
  const S = 512;
  const [c, ctx] = makeCanvas(S);
  const rnd = prng(202);
  const cell = S / 4; // 4×4 pavers per tile
  for (let gy = 0; gy < 4; gy++) {
    for (let gx = 0; gx < 4; gx++) {
      const v = 168 + Math.floor(rnd() * 22) - 10;
      ctx.fillStyle = `rgb(${v},${v - 2},${v - 6})`;
      ctx.fillRect(gx * cell, gy * cell, cell, cell);
    }
  }
  speckle(ctx, rnd, S, 6000, 0.35, "#c9c6c0", "#8f8c86", 1.2);
  // Expansion joints
  ctx.strokeStyle = "rgba(70,68,64,0.85)";
  ctx.lineWidth = 3;
  for (let i = 0; i <= 4; i++) {
    ctx.beginPath();
    ctx.moveTo(i * cell, 0);
    ctx.lineTo(i * cell, S);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, i * cell);
    ctx.lineTo(S, i * cell);
    ctx.stroke();
  }
  // Joint highlight (bevel) — one lighter pixel line beside each joint
  ctx.strokeStyle = "rgba(215,212,205,0.5)";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    ctx.beginPath();
    ctx.moveTo(i * cell + 2.5, 0);
    ctx.lineTo(i * cell + 2.5, S);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, i * cell + 2.5);
    ctx.lineTo(S, i * cell + 2.5);
    ctx.stroke();
  }
  return finish(key, c);
}

// ── Building facades ────────────────────────────────────────────────

const BRICK_BASES: Array<[number, number, number]> = [
  [148, 74, 58], // classic red
  [122, 62, 50], // deep oxblood
  [168, 108, 74], // sandy tan brick
  [96, 66, 58], // brown
];

export function brickTexture(variant: number): THREE.CanvasTexture {
  const v = Math.abs(Math.floor(variant)) % BRICK_BASES.length;
  const key = `brick:${v}`;
  if (cache.has(key)) return cache.get(key)!;
  const S = 512;
  const [c, ctx] = makeCanvas(S);
  const rnd = prng(303 + v * 17);
  const [br, bg, bb] = BRICK_BASES[v];
  // Mortar bed
  ctx.fillStyle = "#b9b2a6";
  ctx.fillRect(0, 0, S, S);
  const rows = 16;
  const bh = S / rows;
  const bw = bh * 2.15;
  for (let r = 0; r < rows; r++) {
    const off = r % 2 === 0 ? 0 : bw / 2;
    for (let x = -bw; x < S + bw; x += bw) {
      const jitter = (rnd() - 0.5) * 14;
      const rr = Math.max(0, Math.min(255, br + jitter + (rnd() - 0.5) * 26));
      const gg = Math.max(0, Math.min(255, bg + jitter + (rnd() - 0.5) * 18));
      const bb2 = Math.max(0, Math.min(255, bb + jitter + (rnd() - 0.5) * 14));
      ctx.fillStyle = `rgb(${rr | 0},${gg | 0},${bb2 | 0})`;
      ctx.fillRect(x + off + 1.5, r * bh + 1.5, bw - 3, bh - 3);
      // Face shading: darker lower edge = raked light
      ctx.fillStyle = "rgba(0,0,0,0.14)";
      ctx.fillRect(x + off + 1.5, r * bh + bh - 5, bw - 3, 3.5);
      ctx.fillStyle = "rgba(255,255,255,0.08)";
      ctx.fillRect(x + off + 1.5, r * bh + 1.5, bw - 3, 2.5);
    }
  }
  speckle(ctx, rnd, S, 2600, 0.25, "#e8ddc9", "#3c2b24", 1.1);
  return finish(key, c);
}

const STUCCO_BASES: Array<[number, number, number]> = [
  [214, 201, 178], // warm cream
  [196, 178, 152], // tan
  [186, 168, 158], // rose gray
  [174, 178, 168], // sage gray
];

export function stuccoTexture(variant: number): THREE.CanvasTexture {
  const v = Math.abs(Math.floor(variant)) % STUCCO_BASES.length;
  const key = `stucco:${v}`;
  if (cache.has(key)) return cache.get(key)!;
  const S = 512;
  const [c, ctx] = makeCanvas(S);
  const rnd = prng(404 + v * 23);
  const [r, g, b] = STUCCO_BASES[v];
  ctx.fillStyle = `rgb(${r},${g},${b})`;
  ctx.fillRect(0, 0, S, S);
  // Blotchy weathering
  for (let i = 0; i < 26; i++) {
    const gr = ctx.createRadialGradient(rnd() * S, rnd() * S, 4, rnd() * S, rnd() * S, 30 + rnd() * 90);
    const dv = rnd() > 0.5 ? 255 : 0;
    gr.addColorStop(0, `rgba(${dv},${dv},${dv},${0.02 + rnd() * 0.05})`);
    gr.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = gr;
    ctx.fillRect(0, 0, S, S);
  }
  speckle(ctx, rnd, S, 5200, 0.22, "#ffffff", "#6b5f52", 1);
  // Faint streaks under imagined sills
  ctx.fillStyle = "rgba(90,80,70,0.06)";
  for (let i = 0; i < 6; i++) {
    ctx.fillRect(rnd() * S, rnd() * S, 3 + rnd() * 5, 40 + rnd() * 80);
  }
  return finish(key, c);
}

export function concreteTexture(): THREE.CanvasTexture {
  const key = "concrete";
  if (cache.has(key)) return cache.get(key)!;
  const S = 256;
  const [c, ctx] = makeCanvas(S);
  const rnd = prng(505);
  ctx.fillStyle = "#9a968e";
  ctx.fillRect(0, 0, S, S);
  speckle(ctx, rnd, S, 2600, 0.3, "#b5b1a8", "#6f6b64", 1.1);
  return finish(key, c);
}

/**
 * An upper-story facade strip: a grid of real-looking windows (frame, sill,
 * glass with sky reflection or a warm lit interior) over the wall base color.
 * Drawn per (variant, floors, litSeed) and mapped 1:1 onto the upper facade.
 */
export function upperWindowsTexture(opts: {
  wall: "brick" | "stucco";
  variant: number;
  floors: number;
  cols: number;
  litSeed: number;
}): THREE.CanvasTexture {
  const floors = Math.max(1, Math.min(12, opts.floors));
  const cols = Math.max(2, Math.min(8, opts.cols));
  const key = `upper:${opts.wall}:${opts.variant}:${floors}:${cols}:${opts.litSeed}`;
  if (cache.has(key)) return cache.get(key)!;
  const W = 512;
  const H = 512;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d")!;
  const rnd = prng(606 + opts.litSeed * 31);

  // Wall base: sample the brick/stucco tile as the backdrop
  const base = opts.wall === "brick" ? brickTexture(opts.variant) : stuccoTexture(opts.variant);
  ctx.drawImage(base.image as HTMLCanvasElement, 0, 0, W, H);

  const cellW = W / cols;
  const cellH = H / floors;
  const winW = cellW * 0.52;
  const winH = cellH * 0.62;
  for (let f = 0; f < floors; f++) {
    for (let col = 0; col < cols; col++) {
      const x = col * cellW + (cellW - winW) / 2;
      const y = f * cellH + (cellH - winH) / 2;
      const lit = rnd() < 0.38;
      // Recess shadow
      ctx.fillStyle = "rgba(0,0,0,0.35)";
      ctx.fillRect(x - 3, y - 3, winW + 6, winH + 8);
      // Frame
      ctx.fillStyle = "#dcd7cc";
      ctx.fillRect(x - 2, y - 2, winW + 4, winH + 4);
      // Glass
      if (lit) {
        const g = ctx.createLinearGradient(x, y, x, y + winH);
        g.addColorStop(0, "#ffe9bd");
        g.addColorStop(1, "#e8b56a");
        ctx.fillStyle = g;
      } else {
        const g = ctx.createLinearGradient(x, y, x + winW, y + winH);
        g.addColorStop(0, "#41535e");
        g.addColorStop(0.5, "#5b7180");
        g.addColorStop(1, "#31404a");
        ctx.fillStyle = g;
      }
      ctx.fillRect(x, y, winW, winH);
      // Sky glint on dark panes
      if (!lit) {
        ctx.fillStyle = "rgba(255,255,255,0.18)";
        ctx.beginPath();
        ctx.moveTo(x + winW * 0.1, y + winH);
        ctx.lineTo(x + winW * 0.45, y);
        ctx.lineTo(x + winW * 0.62, y);
        ctx.lineTo(x + winW * 0.27, y + winH);
        ctx.closePath();
        ctx.fill();
      }
      // Muntins
      ctx.strokeStyle = lit ? "rgba(120,84,40,0.8)" : "rgba(220,215,204,0.9)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x + winW / 2, y);
      ctx.lineTo(x + winW / 2, y + winH);
      ctx.moveTo(x, y + winH / 2);
      ctx.lineTo(x + winW, y + winH / 2);
      ctx.stroke();
      // Sill
      ctx.fillStyle = "#c9c2b4";
      ctx.fillRect(x - 4, y + winH + 2, winW + 8, 5);
      ctx.fillStyle = "rgba(0,0,0,0.25)";
      ctx.fillRect(x - 4, y + winH + 7, winW + 8, 2.5);
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  cache.set(key, tex);
  return tex;
}

/** Striped shop awning canvas. */
export function awningTexture(hex: string): THREE.CanvasTexture {
  const key = `awning:${hex}`;
  if (cache.has(key)) return cache.get(key)!;
  const S = 256;
  const [c, ctx] = makeCanvas(S);
  const rnd = prng(707);
  ctx.fillStyle = "#f3ead9";
  ctx.fillRect(0, 0, S, S);
  ctx.fillStyle = hex;
  const stripe = S / 8;
  for (let x = 0; x < S; x += stripe * 2) {
    ctx.fillRect(x, 0, stripe, S);
  }
  // Canvas weave + fade
  speckle(ctx, rnd, S, 1600, 0.12, "#ffffff", "#5b5245", 0.9);
  const g = ctx.createLinearGradient(0, 0, 0, S);
  g.addColorStop(0, "rgba(255,255,255,0.12)");
  g.addColorStop(1, "rgba(0,0,0,0.12)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  return finish(key, c);
}

/**
 * A skyscraper glass curtain wall: dark blue-green mirror glass in a steel
 * mullion grid, floors of trading screens glowing amber/green at random.
 */
export function glassTowerTexture(litSeed: number): THREE.CanvasTexture {
  const key = `glasstower:${litSeed}`;
  if (cache.has(key)) return cache.get(key)!;
  const W = 512;
  const H = 1024;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d")!;
  const rnd = prng(1300 + litSeed * 7);
  // Sky-reflecting glass backdrop
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, "#16222e");
  g.addColorStop(0.45, "#23384a");
  g.addColorStop(0.55, "#2c4557");
  g.addColorStop(1, "#101a24");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  // Diagonal sky glint
  ctx.fillStyle = "rgba(190,215,230,0.10)";
  ctx.beginPath();
  ctx.moveTo(W * 0.15, H);
  ctx.lineTo(W * 0.55, 0);
  ctx.lineTo(W * 0.8, 0);
  ctx.lineTo(W * 0.4, H);
  ctx.closePath();
  ctx.fill();
  const floors = 26;
  const cols = 8;
  const fh = H / floors;
  const cw = W / cols;
  // Lit panes — trading screens burning after dark
  for (let f = 0; f < floors; f++) {
    for (let col = 0; col < cols; col++) {
      const r = rnd();
      if (r < 0.24) {
        ctx.fillStyle = r < 0.07 ? "rgba(126,231,135,0.75)" : "rgba(255,199,110,0.7)";
        ctx.fillRect(col * cw + 2, f * fh + 2, cw - 4, fh - 4);
      } else if (r < 0.3) {
        ctx.fillStyle = "rgba(140,170,190,0.25)";
        ctx.fillRect(col * cw + 2, f * fh + 2, cw - 4, fh - 4);
      }
    }
  }
  // Mullion grid
  ctx.strokeStyle = "rgba(10,14,18,0.9)";
  ctx.lineWidth = 3;
  for (let f = 0; f <= floors; f++) {
    ctx.beginPath();
    ctx.moveTo(0, f * fh);
    ctx.lineTo(W, f * fh);
    ctx.stroke();
  }
  for (let col = 0; col <= cols; col++) {
    ctx.beginPath();
    ctx.moveTo(col * cw, 0);
    ctx.lineTo(col * cw, H);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  cache.set(key, tex);
  return tex;
}

// ── Interior surfaces ───────────────────────────────────────────────

export function woodFloorTexture(): THREE.CanvasTexture {
  const key = "woodfloor";
  if (cache.has(key)) return cache.get(key)!;
  const S = 512;
  const [c, ctx] = makeCanvas(S);
  const rnd = prng(808);
  const plankH = S / 8;
  for (let p = 0; p < 8; p++) {
    const tone = 122 + Math.floor(rnd() * 36);
    ctx.fillStyle = `rgb(${tone + 32},${tone},${Math.max(0, tone - 42)})`;
    ctx.fillRect(0, p * plankH, S, plankH);
    // Grain streaks
    for (let gI = 0; gI < 26; gI++) {
      ctx.strokeStyle = `rgba(${60 + rnd() * 40},${40 + rnd() * 30},${20 + rnd() * 18},${0.1 + rnd() * 0.18})`;
      ctx.lineWidth = 0.7 + rnd() * 1.4;
      const y = p * plankH + rnd() * plankH;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.bezierCurveTo(S * 0.3, y + (rnd() - 0.5) * 7, S * 0.7, y + (rnd() - 0.5) * 7, S, y + (rnd() - 0.5) * 4);
      ctx.stroke();
    }
    // Occasional knot
    if (rnd() > 0.55) {
      const kx = rnd() * S;
      const ky = p * plankH + plankH * (0.3 + rnd() * 0.4);
      const g = ctx.createRadialGradient(kx, ky, 1, kx, ky, 7);
      g.addColorStop(0, "rgba(45,28,16,0.9)");
      g.addColorStop(1, "rgba(45,28,16,0)");
      ctx.fillStyle = g;
      ctx.fillRect(kx - 8, ky - 8, 16, 16);
    }
    // Plank seams + butt joints
    ctx.fillStyle = "rgba(35,22,12,0.75)";
    ctx.fillRect(0, p * plankH, S, 2);
    const joint = rnd() * S;
    ctx.fillRect(joint, p * plankH, 2, plankH);
  }
  return finish(key, c);
}

export function galleryWallTexture(): THREE.CanvasTexture {
  const key = "gallerywall";
  if (cache.has(key)) return cache.get(key)!;
  const S = 256;
  const [c, ctx] = makeCanvas(S);
  const rnd = prng(909);
  ctx.fillStyle = "#efe9df";
  ctx.fillRect(0, 0, S, S);
  speckle(ctx, rnd, S, 1500, 0.08, "#ffffff", "#b8b0a2", 1);
  return finish(key, c);
}

export function ceilingTexture(): THREE.CanvasTexture {
  const key = "ceiling";
  if (cache.has(key)) return cache.get(key)!;
  const S = 256;
  const [c, ctx] = makeCanvas(S);
  const rnd = prng(1010);
  ctx.fillStyle = "#e7e3da";
  ctx.fillRect(0, 0, S, S);
  speckle(ctx, rnd, S, 2000, 0.07, "#f5f2ea", "#c3bdb0", 0.9);
  return finish(key, c);
}

/** Classic 90s arcade carpet: deep space blue with neon confetti shapes. */
export function arcadeCarpetTexture(): THREE.CanvasTexture {
  const key = "arcadecarpet";
  if (cache.has(key)) return cache.get(key)!;
  const S = 512;
  const [c, ctx] = makeCanvas(S);
  const rnd = prng(1414);
  ctx.fillStyle = "#0d1030";
  ctx.fillRect(0, 0, S, S);
  // Nebula blotches
  for (let i = 0; i < 10; i++) {
    const g = ctx.createRadialGradient(rnd() * S, rnd() * S, 6, rnd() * S, rnd() * S, 60 + rnd() * 90);
    g.addColorStop(0, ["rgba(90,40,160,0.25)", "rgba(20,80,160,0.25)", "rgba(150,30,120,0.2)"][i % 3]);
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S);
  }
  const NEON = ["#ff2fb0", "#28e0ff", "#ffe94a", "#7dff5a", "#ff7a28"];
  // Confetti: squiggles, triangles, lightning zags, dots
  for (let i = 0; i < 90; i++) {
    ctx.strokeStyle = NEON[Math.floor(rnd() * NEON.length)];
    ctx.fillStyle = NEON[Math.floor(rnd() * NEON.length)];
    ctx.lineWidth = 2.2;
    const x = rnd() * S;
    const y = rnd() * S;
    const kind = Math.floor(rnd() * 4);
    ctx.beginPath();
    if (kind === 0) {
      // squiggle
      ctx.moveTo(x, y);
      ctx.bezierCurveTo(x + 12, y - 12, x + 20, y + 12, x + 32, y);
      ctx.stroke();
    } else if (kind === 1) {
      // triangle outline
      ctx.moveTo(x, y);
      ctx.lineTo(x + 14, y + 3);
      ctx.lineTo(x + 5, y + 14);
      ctx.closePath();
      ctx.stroke();
    } else if (kind === 2) {
      // lightning zag
      ctx.moveTo(x, y);
      ctx.lineTo(x + 8, y + 8);
      ctx.lineTo(x + 3, y + 10);
      ctx.lineTo(x + 12, y + 20);
      ctx.stroke();
    } else {
      ctx.arc(x, y, 2.5 + rnd() * 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // Carpet fiber noise
  speckle(ctx, rnd, S, 3200, 0.1, "#3a3f66", "#05071a", 0.9);
  return finish(key, c);
}

/** Polished marble: warm white field with grey/gold veining. */
export function marbleTexture(): THREE.CanvasTexture {
  const key = "marble";
  if (cache.has(key)) return cache.get(key)!;
  const S = 512;
  const [c, ctx] = makeCanvas(S);
  const rnd = prng(1515);
  ctx.fillStyle = "#e9e5dc";
  ctx.fillRect(0, 0, S, S);
  for (let i = 0; i < 14; i++) {
    const g = ctx.createRadialGradient(rnd() * S, rnd() * S, 8, rnd() * S, rnd() * S, 50 + rnd() * 110);
    g.addColorStop(0, "rgba(200,193,180,0.16)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S);
  }
  // Veins — long meandering strokes with fine branches
  for (let v = 0; v < 9; v++) {
    const gold = rnd() < 0.3;
    ctx.strokeStyle = gold ? "rgba(168,138,74,0.4)" : "rgba(120,118,116,0.42)";
    ctx.lineWidth = 1 + rnd() * 1.6;
    let x = rnd() * S;
    let y = 0;
    ctx.beginPath();
    ctx.moveTo(x, y);
    while (y < S) {
      x += (rnd() - 0.5) * 46;
      y += 18 + rnd() * 30;
      ctx.lineTo(x, y);
      if (rnd() < 0.35) {
        // branch
        ctx.moveTo(x, y);
        ctx.lineTo(x + (rnd() - 0.5) * 60, y + 10 + rnd() * 24);
        ctx.moveTo(x, y);
      }
    }
    ctx.stroke();
  }
  speckle(ctx, rnd, S, 1200, 0.06, "#ffffff", "#b8b2a6", 0.8);
  return finish(key, c);
}

// ── Vegetation ──────────────────────────────────────────────────────

export function barkTexture(): THREE.CanvasTexture {
  const key = "bark";
  if (cache.has(key)) return cache.get(key)!;
  const S = 128;
  const [c, ctx] = makeCanvas(S);
  const rnd = prng(1111);
  ctx.fillStyle = "#4f4136";
  ctx.fillRect(0, 0, S, S);
  for (let i = 0; i < 40; i++) {
    ctx.strokeStyle = `rgba(${25 + rnd() * 30},${18 + rnd() * 22},${12 + rnd() * 14},${0.4 + rnd() * 0.4})`;
    ctx.lineWidth = 1 + rnd() * 2.5;
    const x = rnd() * S;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.bezierCurveTo(x + (rnd() - 0.5) * 14, S * 0.33, x + (rnd() - 0.5) * 14, S * 0.66, x + (rnd() - 0.5) * 10, S);
    ctx.stroke();
  }
  speckle(ctx, rnd, S, 500, 0.3, "#7a6a58", "#241a12", 0.9);
  return finish(key, c);
}

/**
 * A ridge of snow-capped mountains, drawn as a transparent strip for a distant
 * billboard. Layers are stacked in the scene with the pale, hazy ones behind —
 * atmospheric perspective does most of the work of selling the distance.
 *
 * `haze` (0..1) washes the whole ridge toward the sky colour, `snowLine` is the
 * height above which rock turns to snow.
 */
export function mountainRidgeTexture(opts: {
  seed: number;
  haze: number;
  snowLine?: number;
  rock?: string;
}): THREE.CanvasTexture {
  const haze = Math.max(0, Math.min(1, opts.haze));
  const snowLine = opts.snowLine ?? 0.45;
  const rock = opts.rock ?? "#4a5568";
  const key = `ridge:${opts.seed}:${haze.toFixed(2)}:${snowLine}:${rock}`;
  if (cache.has(key)) return cache.get(key)!;

  const W = 2048, H = 512;
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const ctx = c.getContext("2d")!;
  const rnd = prng(9001 + opts.seed * 137);

  // Build a jagged skyline by midpoint displacement, then close it into a shape.
  let pts: number[] = [0.42, 0.72, 0.35, 0.8, 0.4];
  for (let pass = 0; pass < 6; pass++) {
    const next: number[] = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i]!, b = pts[i + 1]!;
      next.push(a);
      const rough = 0.34 / (pass + 1);
      next.push(Math.max(0.08, Math.min(0.98, (a + b) / 2 + (rnd() - 0.5) * rough)));
    }
    next.push(pts[pts.length - 1]!);
    pts = next;
  }

  const yFor = (h: number) => H - h * H * 0.92;
  ctx.beginPath();
  ctx.moveTo(0, H);
  for (let i = 0; i < pts.length; i++) {
    ctx.lineTo((i / (pts.length - 1)) * W, yFor(pts[i]!));
  }
  ctx.lineTo(W, H);
  ctx.closePath();

  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, "#e9f0fb");                 // snow catches the light up top
  g.addColorStop(Math.max(0.02, 1 - snowLine - 0.06), "#dbe6f5");
  g.addColorStop(Math.min(0.98, 1 - snowLine + 0.02), rock);
  g.addColorStop(1, "#2b3547");                 // valleys stay dark
  ctx.fillStyle = g;
  ctx.fill();

  // Snow fingers reaching down the gullies, and a few shadowed faces.
  ctx.save();
  ctx.clip();
  for (let i = 0; i < 120; i++) {
    const x = rnd() * W;
    const idx = Math.min(pts.length - 1, Math.floor((x / W) * (pts.length - 1)));
    const peak = yFor(pts[idx]!);
    if (pts[idx]! < snowLine + 0.1) continue;
    ctx.globalAlpha = 0.5 * rnd() + 0.2;
    ctx.fillStyle = "#f3f7ff";
    const w = 6 + rnd() * 22, h = 20 + rnd() * 90;
    ctx.beginPath();
    ctx.moveTo(x, peak);
    ctx.lineTo(x - w / 2, peak + h);
    ctx.lineTo(x + w / 2, peak + h * 0.7);
    ctx.closePath(); ctx.fill();
  }
  ctx.globalAlpha = 0.14;
  ctx.fillStyle = "#111a2b";
  for (let i = 0; i < 60; i++) {
    const x = rnd() * W;
    ctx.fillRect(x, 0, 3 + rnd() * 26, H);      // vertical shadow bands = relief
  }
  ctx.restore();
  ctx.globalAlpha = 1;

  // Atmospheric haze: the farther the ridge, the more it washes out.
  if (haze > 0) {
    ctx.globalCompositeOperation = "source-atop";
    const hg = ctx.createLinearGradient(0, 0, 0, H);
    hg.addColorStop(0, `rgba(200,216,238,${haze * 0.55})`);
    hg.addColorStop(1, `rgba(188,206,232,${haze * 0.9})`);
    ctx.fillStyle = hg;
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = "source-over";
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = 4;
  cache.set(key, tex);
  return tex;
}

/** Open water: banded swell with a little chop. Tinted by the light, not baked. */
export function oceanTexture(): THREE.CanvasTexture {
  const key = "ocean";
  if (cache.has(key)) return cache.get(key)!;
  const S = 1024;
  const [c, ctx] = makeCanvas(S);
  const rnd = prng(4242);

  const g = ctx.createLinearGradient(0, 0, 0, S);
  g.addColorStop(0, "#2a4f74");
  g.addColorStop(0.5, "#20405f");
  g.addColorStop(1, "#16324c");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);

  // Long swell lines, then shorter chop on top.
  for (let i = 0; i < 260; i++) {
    const y = rnd() * S;
    const len = 60 + rnd() * 420;
    const x = rnd() * S;
    ctx.strokeStyle = `rgba(150,190,225,${0.05 + rnd() * 0.13})`;
    ctx.lineWidth = 1 + rnd() * 2.2;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.bezierCurveTo(x + len * 0.3, y - 5, x + len * 0.7, y + 5, x + len, y);
    ctx.stroke();
  }
  for (let i = 0; i < 900; i++) {
    ctx.fillStyle = `rgba(198,225,245,${0.04 + rnd() * 0.14})`;
    ctx.fillRect(rnd() * S, rnd() * S, 1 + rnd() * 3, 1);
  }
  return finish(key, c);
}
