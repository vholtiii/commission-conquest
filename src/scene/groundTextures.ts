import * as THREE from "three";

function canvas(size: number): HTMLCanvasElement {
  const el = document.createElement("canvas");
  el.width = size;
  el.height = size;
  return el;
}

function finish(c: HTMLCanvasElement): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function asphaltBase(ctx: CanvasRenderingContext2D, size: number): void {
  ctx.fillStyle = "#2c2d31";
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 2200; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const v = 30 + Math.random() * 40;
    ctx.fillStyle = `rgba(${v},${v},${v + 5},${0.12 + Math.random() * 0.24})`;
    ctx.fillRect(x, y, 1 + Math.random() * 2, 1 + Math.random() * 2);
  }
}

/**
 * Asphalt tile with a broken centre line and solid edge lines. `along` is the
 * world axis the road runs on when the plane lies flat: "z" for N–S avenues
 * (lines along V), "x" for E–W streets (lines along U). One tile per road cell.
 */
export function asphaltTexture(along: "x" | "z"): THREE.CanvasTexture {
  const size = 128;
  const c = canvas(size);
  const ctx = c.getContext("2d")!;
  asphaltBase(ctx, size);

  const line = (a: number, dashed: boolean) => {
    ctx.beginPath();
    if (along === "z") {
      ctx.moveTo(a, 0);
      ctx.lineTo(a, size);
    } else {
      ctx.moveTo(0, a);
      ctx.lineTo(size, a);
    }
    ctx.setLineDash(dashed ? [10, 12] : []);
    ctx.stroke();
  };

  ctx.strokeStyle = "rgba(232, 214, 160, 0.62)";
  ctx.lineWidth = 4;
  line(size / 2, true);

  ctx.strokeStyle = "rgba(220, 216, 200, 0.34)";
  ctx.lineWidth = 2;
  line(7, false);
  line(size - 7, false);
  return finish(c);
}

/** Plain asphalt for intersections, with a faint crosswalk stripe on each side. */
export function intersectionTexture(): THREE.CanvasTexture {
  const size = 128;
  const c = canvas(size);
  const ctx = c.getContext("2d")!;
  asphaltBase(ctx, size);
  ctx.fillStyle = "rgba(220, 216, 200, 0.2)";
  for (let i = 10; i < size - 10; i += 14) {
    ctx.fillRect(i, 3, 7, 9);
    ctx.fillRect(i, size - 12, 7, 9);
    ctx.fillRect(3, i, 9, 7);
    ctx.fillRect(size - 12, i, 9, 7);
  }
  return finish(c);
}

/** Warm concrete slab with paving seams and a darker curb rim. Covers one 3x3 block. */
export function sidewalkTexture(): THREE.CanvasTexture {
  const size = 256;
  const c = canvas(size);
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#6d675c";
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 5000; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const v = 88 + Math.random() * 50;
    ctx.fillStyle = `rgba(${v},${v - 4},${v - 12},${0.1 + Math.random() * 0.2})`;
    ctx.fillRect(x, y, 1 + Math.random() * 2, 1 + Math.random() * 2);
  }
  ctx.strokeStyle = "rgba(40, 36, 30, 0.45)";
  ctx.lineWidth = 1;
  const step = size / 12;
  for (let i = step; i < size; i += step) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i, size);
    ctx.moveTo(0, i);
    ctx.lineTo(size, i);
    ctx.stroke();
  }
  // Curb: a darker rim so the block edge reads against the road.
  ctx.strokeStyle = "rgba(28, 26, 22, 0.85)";
  ctx.lineWidth = 6;
  ctx.strokeRect(3, 3, size - 6, size - 6);
  ctx.strokeStyle = "rgba(160, 152, 136, 0.55)";
  ctx.lineWidth = 2;
  ctx.strokeRect(8, 8, size - 16, size - 16);
  const tex = finish(c);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

/** Mottled grass so parks are not a flat fill. */
export function parkTexture(): THREE.CanvasTexture {
  const size = 128;
  const c = canvas(size);
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#3a4a35";
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 900; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const g = 50 + Math.random() * 40;
    ctx.fillStyle = `rgba(${30 + Math.random() * 20},${g},${28 + Math.random() * 16},${0.25 + Math.random() * 0.35})`;
    ctx.fillRect(x, y, 2 + Math.random() * 3, 2 + Math.random() * 3);
  }
  return finish(c);
}

/** Tiled ripple normal map. Offset it each frame for a slow shimmer. */
export function waterNormalTexture(): THREE.CanvasTexture {
  const size = 128;
  const c = canvas(size);
  const ctx = c.getContext("2d")!;
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const nx =
        Math.cos((x / size) * Math.PI * 4) * 0.35 +
        Math.cos((y / size) * Math.PI * 2) * 0.15 +
        (Math.random() - 0.5) * 0.12;
      const ny =
        Math.sin((y / size) * Math.PI * 6) * 0.35 +
        Math.sin((x / size) * Math.PI * 3) * 0.12 +
        (Math.random() - 0.5) * 0.12;
      const nz = 1;
      const len = Math.hypot(nx, ny, nz);
      const i = (y * size + x) * 4;
      img.data[i] = ((nx / len) * 0.5 + 0.5) * 255;
      img.data[i + 1] = ((ny / len) * 0.5 + 0.5) * 255;
      img.data[i + 2] = ((nz / len) * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  tex.repeat.set(2, 2);
  return tex;
}
