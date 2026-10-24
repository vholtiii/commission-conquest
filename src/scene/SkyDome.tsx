import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import type { CityLayout } from "@/engine/cityLayout";
import { useGameStore } from "@/engine/store";
import { useReelLook } from "./hits/reelLook";
import { hash2, seasonPalette, WATER_COLOR } from "./sceneTheme";

const SETTLE_SECONDS = 0.45;
const DOME_RADIUS = 280;
const SEA_RADIUS = 270;
const SKYLINE_FRONT = 64;
const SKYLINE_BACK = 40;
/** Drawn after the city so the depth test discards every pixel a building already covers. */
const SKY_RENDER_ORDER = 2;
const SEA_RENDER_ORDER = 1;

const SKY_VERTEX = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const SKY_FRAGMENT = /* glsl */ `
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGround;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uDim;
varying vec3 vDir;
void main() {
  vec3 dir = normalize(vDir);
  float h = dir.y;
  vec3 col = mix(uHorizon, uZenith, pow(smoothstep(0.0, 0.55, h), 0.7));
  col = mix(col, uGround, smoothstep(0.0, 0.35, -h));
  float sun = max(dot(dir, uSunDir), 0.0);
  col += uSunColor * (pow(sun, 18.0) * 0.18 + pow(sun, 4.0) * 0.05) * step(-0.02, h);
  gl_FragColor = vec4(col * uDim, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** Dark streets and a few lit windows, tinted per instance. */
function skylineTexture(): THREE.CanvasTexture {
  const w = 256;
  const h = 256;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#1b1e24";
  ctx.fillRect(0, 0, w, h);
  for (let y = 6; y < h - 4; y += 10) {
    for (let x = 4; x < w - 4; x += 8) {
      const r = hash2(x, y, 911);
      if (r > 0.9) {
        ctx.fillStyle = r > 0.97 ? "#ffd890" : "#c79a5c";
        ctx.fillRect(x, y, 3, 4);
      }
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

interface SkylineQuad {
  x: number;
  z: number;
  yaw: number;
  w: number;
  h: number;
  shade: number;
}

function skylineQuads(layout: CityLayout): SkylineQuad[] {
  const quads: SkylineQuad[] = [];
  const rings: Array<{ count: number; rx: number; rz: number; seed: number; minH: number; maxH: number }> = [
    { count: SKYLINE_FRONT, rx: layout.width * 0.72, rz: layout.depth * 0.9, seed: 3, minH: 4, maxH: 13 },
    { count: SKYLINE_BACK, rx: layout.width * 0.8, rz: layout.depth * 1.02, seed: 17, minH: 8, maxH: 20 },
  ];
  for (const ring of rings) {
    for (let i = 0; i < ring.count; i++) {
      const jitter = hash2(i, ring.seed, 5) - 0.5;
      const a = ((i + jitter * 0.6) / ring.count) * Math.PI * 2;
      const x = Math.cos(a) * ring.rx;
      const z = Math.sin(a) * ring.rz;
      const step = (2 * Math.PI * Math.max(ring.rx, ring.rz)) / ring.count;
      const r = hash2(i, ring.seed, 9);
      quads.push({
        x,
        z,
        // Face the middle of the map.
        yaw: Math.atan2(-x, -z),
        w: step * (0.8 + hash2(i, ring.seed, 13) * 0.7),
        h: ring.minH + Math.pow(r, 2.2) * (ring.maxH - ring.minH),
        shade: 0.75 + hash2(i, ring.seed, 21) * 0.35,
      });
    }
  }
  return quads;
}

/**
 * Seasonal gradient sky, a sea out to the horizon, and a far skyline so the
 * city does not end at a cliff. The dome and sea follow the camera.
 */
export default function SkyDome({ layout }: { layout: CityLayout }) {
  const dome = useRef<THREE.Mesh>(null);
  const sea = useRef<THREE.Mesh>(null);
  const skyline = useRef<THREE.InstancedMesh>(null);
  const keyRef = useRef("");
  const snapped = useRef(false);
  const target = useRef(seasonPalette({ month: 1, day: 1 }));
  const dim = useRef(1);
  const sunDirTarget = useMemo(() => new THREE.Vector3(), []);

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: {
          uZenith: { value: new THREE.Color("#1c2230") },
          uHorizon: { value: new THREE.Color("#4a5260") },
          uGround: { value: new THREE.Color("#1c1f26") },
          uSunDir: { value: new THREE.Vector3(30, 45, 20).normalize() },
          uSunColor: { value: new THREE.Color("#ffd9a8") },
          uDim: { value: 1 },
        },
        vertexShader: SKY_VERTEX,
        fragmentShader: SKY_FRAGMENT,
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
      }),
    [],
  );
  const seaMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: new THREE.Color(WATER_COLOR).multiplyScalar(0.55),
        roughness: 0.35,
        metalness: 0.25,
      }),
    [],
  );
  const skylineTex = useMemo(skylineTexture, []);
  const skylineMat = useMemo(
    () => new THREE.MeshBasicMaterial({ map: skylineTex, side: THREE.DoubleSide }),
    [skylineTex],
  );
  const skylineGeo = useMemo(() => new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0), []);
  const quads = useMemo(() => skylineQuads(layout), [layout]);

  useEffect(
    () => () => {
      material.dispose();
      seaMat.dispose();
      skylineTex.dispose();
      skylineMat.dispose();
      skylineGeo.dispose();
    },
    [material, seaMat, skylineTex, skylineMat, skylineGeo],
  );

  useLayoutEffect(() => {
    const mesh = skyline.current;
    if (!mesh) return;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const p = new THREE.Vector3();
    const s = new THREE.Vector3();
    const color = new THREE.Color();
    quads.forEach((quad, i) => {
      p.set(quad.x, -0.1, quad.z);
      q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, quad.yaw);
      s.set(quad.w, quad.h, 1);
      m.compose(p, q, s);
      mesh.setMatrixAt(i, m);
      mesh.setColorAt(i, color.setScalar(quad.shade));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [quads]);

  useFrame(({ camera }, dt) => {
    const date = useGameStore.getState().date;
    const key = `${date.year}-${date.month}-${date.day}`;
    if (key !== keyRef.current) {
      keyRef.current = key;
      target.current = seasonPalette(date);
    }
    const look = target.current;
    const k = snapped.current ? 1 - Math.exp(-dt / SETTLE_SECONDS) : 1;
    snapped.current = true;
    const u = material.uniforms;
    (u.uZenith!.value as THREE.Color).lerp(look.zenith, k);
    (u.uHorizon!.value as THREE.Color).lerp(look.horizon, k);
    (u.uGround!.value as THREE.Color).lerp(look.horizon, k);
    (u.uSunColor!.value as THREE.Color).lerp(look.sunColor, k);
    sunDirTarget.set(30, look.sunElevation, 20).normalize();
    (u.uSunDir!.value as THREE.Vector3).lerp(sunDirTarget, k).normalize();
    const grade = useReelLook.getState().grade;
    dim.current += (1 - grade * 0.6 - dim.current) * (1 - Math.exp(-dt / 0.6));
    u.uDim!.value = dim.current;

    if (dome.current) dome.current.position.copy(camera.position);
    if (sea.current) sea.current.position.set(camera.position.x, -0.12, camera.position.z);
  });

  return (
    <group>
      <mesh ref={dome} material={material} renderOrder={SKY_RENDER_ORDER} frustumCulled={false}>
        <sphereGeometry args={[DOME_RADIUS, 32, 16]} />
      </mesh>
      <mesh
        ref={sea}
        material={seaMat}
        rotation={[-Math.PI / 2, 0, 0]}
        renderOrder={SEA_RENDER_ORDER}
        frustumCulled={false}
      >
        <circleGeometry args={[SEA_RADIUS, 48]} />
      </mesh>
      <instancedMesh
        key={quads.length}
        ref={skyline}
        args={[skylineGeo, skylineMat, quads.length]}
        renderOrder={SEA_RENDER_ORDER}
      />
    </group>
  );
}
