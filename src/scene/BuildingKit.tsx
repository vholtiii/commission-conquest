import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { BLOCK_SIZE, ROAD_GAP } from "@/engine/cityLayout";
import { FACADE_VARIANTS, STORY_H, STORY_ROWS, makeFacadeAtlas, makeFacadeMaterial, packFacade } from "./FacadeMaterial";
import { hash2, type BuildingArchetype } from "./sceneTheme";

const PITCH = BLOCK_SIZE + ROAD_GAP;
/** Standard footprint, as a share of the cell. */
const W = BLOCK_SIZE * 0.86;
const CAP_H = 0.12;
const AWNINGS = ["#6e2a26", "#2a4a3a", "#2e3550", "#7a5a24", "#4a2a3a"];

export interface BuildingSpec {
  key: string;
  gx: number;
  gz: number;
  x: number;
  z: number;
  archetype: BuildingArchetype;
  floors: number;
  color: string;
  roofColor: string;
  /** Unit directions of the faces that front a street. The first gets the door. */
  faces: Array<readonly [number, number]>;
}

export interface PartItem {
  x: number;
  y: number;
  z: number;
  sx: number;
  sy: number;
  sz: number;
  yaw?: number;
  pitch?: number;
  color?: string;
}

interface BodyItem extends PartItem {
  facade: readonly [number, number, number, number];
}

type PartKind =
  | "cap"
  | "cornice"
  | "chimney"
  | "tank"
  | "tankRoof"
  | "tankLeg"
  | "sawtooth"
  | "stoop"
  | "door"
  | "awning"
  | "spire"
  | "beacon"
  | "contact";

function shade(hex: string, k: number): string {
  return new THREE.Color(hex).multiplyScalar(k).getStyle();
}

/** Half-extent of a w x d box along a unit street direction. */
function reach(face: readonly [number, number], w: number, d: number): number {
  return Math.abs(face[0]) * (w / 2) + Math.abs(face[1]) * (d / 2);
}

/** Length of the box face that looks along `face`. */
function span(face: readonly [number, number], w: number, d: number): number {
  return Math.abs(face[1]) * w + Math.abs(face[0]) * d;
}

function yawOf(face: readonly [number, number]): number {
  return Math.atan2(face[0], face[1]);
}

function buildKit(buildings: BuildingSpec[], seed: number) {
  const bodies: BodyItem[] = [];
  const parts: Record<PartKind, PartItem[]> = {
    cap: [],
    cornice: [],
    chimney: [],
    tank: [],
    tankRoof: [],
    tankLeg: [],
    sawtooth: [],
    stoop: [],
    door: [],
    awning: [],
    spire: [],
    beacon: [],
    contact: [],
  };

  for (const b of buildings) {
    const h = (salt: number) => hash2(b.gx, b.gz, seed + salt);
    const variant = Math.floor(h(7) * FACADE_VARIANTS) % FACADE_VARIANTS;
    const rowOffset = Math.floor(h(11) * STORY_ROWS) % STORY_ROWS;
    const main = b.faces[0]!;
    const body = (y: number, w: number, d: number, floors: number, storefront = false, uRepeat = 1) => {
      bodies.push({
        x: b.x,
        y,
        z: b.z,
        sx: w,
        sy: floors * STORY_H,
        sz: d,
        color: b.color,
        facade: packFacade(floors, variant, rowOffset, storefront, uRepeat),
      });
      const top = y + floors * STORY_H;
      parts.cap.push({ x: b.x, y: top, z: b.z, sx: w + 0.06, sy: CAP_H, sz: d + 0.06, color: b.roofColor });
      return top;
    };
    const contact = (w: number, d: number) => {
      // The texture's inner square is the standard footprint; scale so it hugs this one.
      const k = PITCH / W;
      parts.contact.push({ x: b.x, y: 0.007, z: b.z, sx: w * k, sy: d * k, sz: 1, pitch: -Math.PI / 2 });
    };
    const chimney = (top: number, w: number, d: number, salt: number) => {
      const sx = h(salt) > 0.5 ? 1 : -1;
      const sz = h(salt + 1) > 0.5 ? 1 : -1;
      parts.chimney.push({
        x: b.x + sx * w * 0.32,
        y: top + CAP_H,
        z: b.z + sz * d * 0.3,
        sx: 0.16,
        sy: 0.34 + h(salt + 2) * 0.16,
        sz: 0.16,
        color: h(salt + 3) > 0.5 ? "#4a3028" : "#3a2e2a",
      });
      return [sx, sz] as const;
    };
    const waterTower = (top: number, ox: number, oz: number) => {
      const legH = 0.34;
      const y0 = top + CAP_H;
      for (const [lx, lz] of [
        [-1, -1],
        [-1, 1],
        [1, -1],
        [1, 1],
      ] as const) {
        parts.tankLeg.push({ x: ox + lx * 0.16, y: y0, z: oz + lz * 0.16, sx: 0.035, sy: legH, sz: 0.035 });
      }
      parts.tank.push({ x: ox, y: y0 + legH, z: oz, sx: 0.26, sy: 0.42, sz: 0.26 });
      parts.tankRoof.push({ x: ox, y: y0 + legH + 0.42, z: oz, sx: 0.29, sy: 0.2, sz: 0.29 });
    };

    switch (b.archetype) {
      case "tenement":
      case "commercial": {
        const store = b.archetype === "commercial";
        const top = body(0, W, W, b.floors, store);
        parts.cornice.push({
          x: b.x,
          y: top - 0.14,
          z: b.z,
          sx: W + 0.14,
          sy: 0.09,
          sz: W + 0.14,
          color: shade(b.color, store ? 1.15 : 0.8),
        });
        const [cx, cz] = chimney(top, W, W, 31);
        if (h(37) > 0.5) chimney(top, W, W, 41);
        if (h(43) < (store ? 0.2 : 0.35)) {
          waterTower(top, b.x - cx * W * 0.18, b.z - cz * W * 0.16);
        }
        if (store) {
          parts.cornice.push({
            x: b.x,
            y: STORY_H - 0.03,
            z: b.z,
            sx: W + 0.08,
            sy: 0.05,
            sz: W + 0.08,
            color: shade(b.color, 0.7),
          });
          const awning = AWNINGS[Math.floor(h(47) * AWNINGS.length)]!;
          for (const face of b.faces) {
            const r = reach(face, W, W);
            parts.awning.push({
              x: b.x + face[0] * (r + 0.16),
              y: STORY_H * 0.9,
              z: b.z + face[1] * (r + 0.16),
              sx: span(face, W, W) * 0.86,
              sy: 0.035,
              sz: 0.34,
              yaw: yawOf(face),
              pitch: 0.3,
              color: awning,
            });
          }
        }
        contact(W, W);
        break;
      }
      case "brownstone": {
        // Narrow along the street so the row reads as separate houses.
        const narrowX = main[1] !== 0;
        const w = narrowX ? W * 0.84 : W;
        const d = narrowX ? W : W * 0.84;
        const top = body(0, w, d, b.floors);
        parts.cornice.push({ x: b.x, y: top - 0.12, z: b.z, sx: w + 0.16, sy: 0.1, sz: d + 0.16, color: "#d8cfbf" });
        chimney(top, w, d, 31);
        const r = reach(main, w, d);
        parts.stoop.push({
          x: b.x + main[0] * (r + 0.14),
          y: 0,
          z: b.z + main[1] * (r + 0.14),
          sx: 0.5,
          sy: 0.2,
          sz: 0.28,
          yaw: yawOf(main),
          color: "#6b5e52",
        });
        parts.door.push({
          x: b.x + main[0] * (r + 0.01),
          y: 0.2,
          z: b.z + main[1] * (r + 0.01),
          sx: 0.26,
          sy: 0.42,
          sz: 0.03,
          yaw: yawOf(main),
          color: "#2a1e18",
        });
        contact(w, d);
        break;
      }
      case "warehouse": {
        const w = BLOCK_SIZE * 0.92;
        const top = body(0, w, w, b.floors, false, 2);
        for (let i = -1; i <= 1; i++) {
          parts.sawtooth.push({
            x: b.x + (i * w) / 3,
            y: top + CAP_H,
            z: b.z,
            sx: w / 3,
            sy: 0.38,
            sz: w * 0.96,
            color: b.roofColor,
          });
        }
        const r = reach(main, w, w);
        parts.door.push({
          x: b.x + main[0] * (r + 0.02),
          y: 0,
          z: b.z + main[1] * (r + 0.02),
          sx: 0.82,
          sy: 0.64,
          sz: 0.04,
          yaw: yawOf(main),
          color: "#3a3e44",
        });
        contact(w, w);
        break;
      }
      case "tower": {
        const f = b.floors;
        const fBase = Math.max(4, Math.round(f * 0.55));
        const fMid = Math.max(2, Math.round(f * 0.27));
        const fTop = Math.max(2, f - fBase - fMid);
        const top1 = body(0, W, W, fBase) + CAP_H;
        const w2 = W * 0.85;
        const top2 = body(top1, w2, w2, fMid) + CAP_H;
        const w3 = W * 0.65;
        const top3 = body(top2, w3, w3, fTop) + CAP_H;
        const crownW = w3 * 0.55;
        parts.cap.push({ x: b.x, y: top3, z: b.z, sx: crownW, sy: 0.3, sz: crownW, color: b.roofColor });
        parts.beacon.push({ x: b.x, y: top3 + 0.3, z: b.z, sx: 0.2, sy: 0.2, sz: 0.2 });
        parts.spire.push({ x: b.x, y: top3 + 0.5, z: b.z, sx: 0.1, sy: 1.1, sz: 0.1 });
        contact(W, W);
        break;
      }
    }
  }
  return { bodies, parts };
}

function contactTexture(): THREE.CanvasTexture {
  const size = 128;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d")!;
  const img = ctx.createImageData(size, size);
  const inner = W / PITCH / 2;
  const round = 0.03;
  const fade = 0.5 - inner;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = Math.abs((x + 0.5) / size - 0.5) - inner + round;
      const py = Math.abs((y + 0.5) / size - 0.5) - inner + round;
      const d = Math.hypot(Math.max(px, 0), Math.max(py, 0)) - round;
      const t = Math.max(0, Math.min(1, d / fade));
      const a = 0.6 * (1 - t * t * (3 - 2 * t));
      const i = (y * size + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 0;
      img.data[i + 3] = Math.round(a * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

const scratch = {
  m: new THREE.Matrix4(),
  q: new THREE.Quaternion(),
  e: new THREE.Euler(0, 0, 0, "YXZ"),
  p: new THREE.Vector3(),
  s: new THREE.Vector3(),
  c: new THREE.Color(),
};

function writeInstances(mesh: THREE.InstancedMesh, items: PartItem[]) {
  const { m, q, e, p, s, c } = scratch;
  items.forEach((it, i) => {
    e.set(it.pitch ?? 0, it.yaw ?? 0, 0, "YXZ");
    q.setFromEuler(e);
    p.set(it.x, it.y, it.z);
    s.set(it.sx, it.sy, it.sz);
    m.compose(p, q, s);
    mesh.setMatrixAt(i, m);
    if (it.color) mesh.setColorAt(i, c.set(it.color));
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.computeBoundingSphere();
}

/** One instanced mesh over a list of placed parts. */
export function PartMesh({
  geometry,
  material,
  items,
  castShadow = false,
  receiveShadow = false,
}: {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  items: PartItem[];
  castShadow?: boolean;
  receiveShadow?: boolean;
}) {
  const ref = useRef<THREE.InstancedMesh>(null);
  useLayoutEffect(() => {
    if (ref.current) writeInstances(ref.current, items);
  }, [items]);
  if (items.length === 0) return null;
  return (
    <instancedMesh
      key={items.length}
      ref={ref}
      args={[geometry, material, items.length]}
      castShadow={castShadow}
      receiveShadow={receiveShadow}
    />
  );
}

function FacadeBodies({
  items,
  material,
  base,
}: {
  items: BodyItem[];
  material: THREE.Material;
  base: THREE.BufferGeometry;
}) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const geometry = useMemo(() => {
    const g = base.clone();
    const data = new Float32Array(items.length * 4);
    items.forEach((it, i) => data.set(it.facade, i * 4));
    g.setAttribute("aFacade", new THREE.InstancedBufferAttribute(data, 4));
    return g;
  }, [base, items]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  useLayoutEffect(() => {
    if (ref.current) writeInstances(ref.current, items);
  }, [items, geometry]);
  if (items.length === 0) return null;
  return (
    <instancedMesh
      key={items.length}
      ref={ref}
      args={[geometry, material, items.length]}
      castShadow
      receiveShadow
    />
  );
}

/** Base-anchored unit primitives so a part's y is where it sits. */
function useKitGeometry() {
  return useMemo(() => {
    const box = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    const cylinder = new THREE.CylinderGeometry(1, 1, 1, 10).translate(0, 0.5, 0);
    const cone = new THREE.ConeGeometry(1, 1, 10).translate(0, 0.5, 0);
    const spire = new THREE.ConeGeometry(1, 1, 6).translate(0, 0.5, 0);
    const tooth = new THREE.Shape();
    tooth.moveTo(-0.5, 0);
    tooth.lineTo(0.5, 0);
    tooth.lineTo(0.5, 1);
    tooth.closePath();
    const sawtooth = new THREE.ExtrudeGeometry(tooth, { depth: 1, bevelEnabled: false }).translate(0, 0, -0.5);
    const plane = new THREE.PlaneGeometry(1, 1);
    return { box, cylinder, cone, spire, sawtooth, plane };
  }, []);
}

/**
 * The city's ordinary buildings: five archetypes sharing one facade-shaded
 * body mesh, plus one instanced mesh per roof and street part. All placement
 * is seeded, so a saved game rebuilds the same skyline.
 */
export default function BuildingKit({ buildings, seed }: { buildings: BuildingSpec[]; seed: number }) {
  const geo = useKitGeometry();
  const maps = useMemo(() => makeFacadeAtlas(seed), [seed]);
  const facade = useMemo(() => makeFacadeMaterial(maps), [maps]);
  const contactTex = useMemo(contactTexture, []);
  const mats = useMemo(
    () => ({
      solid: new THREE.MeshStandardMaterial({ roughness: 0.9 }),
      wood: new THREE.MeshStandardMaterial({ color: "#5a4030", roughness: 0.95 }),
      roof: new THREE.MeshStandardMaterial({ color: "#2a2420", roughness: 0.9 }),
      iron: new THREE.MeshStandardMaterial({ color: "#1c1c1e", roughness: 0.6, metalness: 0.5 }),
      metal: new THREE.MeshStandardMaterial({ color: "#c9b89a", roughness: 0.35, metalness: 0.65 }),
      beacon: new THREE.MeshStandardMaterial({
        color: "#f0e0b0",
        emissive: "#ffcf7a",
        emissiveIntensity: 2.2,
      }),
      contact: new THREE.MeshBasicMaterial({
        map: contactTex,
        color: "#000000",
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -2,
      }),
    }),
    [contactTex],
  );

  useEffect(
    () => () => {
      maps.albedo.dispose();
      maps.emissive.dispose();
      facade.dispose();
    },
    [maps, facade],
  );
  useEffect(
    () => () => {
      contactTex.dispose();
      for (const m of Object.values(mats)) m.dispose();
    },
    [mats, contactTex],
  );
  useEffect(
    () => () => {
      for (const g of Object.values(geo)) g.dispose();
    },
    [geo],
  );

  const { bodies, parts } = useMemo(() => buildKit(buildings, seed), [buildings, seed]);

  return (
    <group>
      <FacadeBodies items={bodies} material={facade} base={geo.box} />
      <PartMesh geometry={geo.box} material={mats.solid} items={parts.cap} castShadow receiveShadow />
      <PartMesh geometry={geo.box} material={mats.solid} items={parts.cornice} castShadow />
      <PartMesh geometry={geo.box} material={mats.solid} items={parts.chimney} castShadow />
      <PartMesh geometry={geo.cylinder} material={mats.wood} items={parts.tank} castShadow />
      <PartMesh geometry={geo.cone} material={mats.roof} items={parts.tankRoof} castShadow />
      <PartMesh geometry={geo.box} material={mats.iron} items={parts.tankLeg} />
      <PartMesh geometry={geo.sawtooth} material={mats.solid} items={parts.sawtooth} castShadow receiveShadow />
      <PartMesh geometry={geo.box} material={mats.solid} items={parts.stoop} />
      <PartMesh geometry={geo.box} material={mats.solid} items={parts.door} />
      <PartMesh geometry={geo.box} material={mats.solid} items={parts.awning} castShadow />
      <PartMesh geometry={geo.spire} material={mats.metal} items={parts.spire} castShadow />
      <PartMesh geometry={geo.box} material={mats.beacon} items={parts.beacon} />
      <PartMesh geometry={geo.plane} material={mats.contact} items={parts.contact} />
    </group>
  );
}
