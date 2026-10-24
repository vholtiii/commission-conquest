import * as THREE from "three";
import { hash2 } from "./sceneTheme";

/** World height of one storey. Window rows are this tall on every building. */
export const STORY_H = 0.55;
export const FACADE_VARIANTS = 4;
/** Distinct upper-storey rows per variant before the pattern repeats. */
export const STORY_ROWS = 8;
const ATLAS_ROWS = STORY_ROWS + 1;
const STOREFRONT_ROW = STORY_ROWS;
const TILE_W = 256;
const TILE_H = 96;
const WALL = "#d4d0c8";

export interface FacadeMaps {
  albedo: THREE.CanvasTexture;
  emissive: THREE.CanvasTexture;
}

/**
 * Per-instance facade data, packed into one vec4 attribute:
 * x = storeys, y = window variant (0..3), z = row offset (0..7),
 * w = storefront flag + 2 * horizontal repeats.
 */
export function packFacade(floors: number, variant: number, rowOffset: number, storefront: boolean, uRepeat = 1) {
  return [floors, variant, rowOffset, (storefront ? 1 : 0) + 2 * uRepeat] as const;
}

function finish(canvas: HTMLCanvasElement, srgb: boolean): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** Brick speckle, a lintel band at the top, and a sill shadow at the bottom of one storey tile. */
function paintWall(ctx: CanvasRenderingContext2D, x0: number, y0: number, seed: number) {
  ctx.fillStyle = WALL;
  ctx.fillRect(x0, y0, TILE_W, TILE_H);
  for (let i = 0; i < 260; i++) {
    const r = hash2(i, seed, 41);
    const s = hash2(i, seed, 43);
    const v = 150 + Math.floor(hash2(i, seed, 47) * 70);
    ctx.fillStyle = `rgba(${v},${v - 6},${v - 14},0.35)`;
    ctx.fillRect(x0 + r * TILE_W, y0 + s * TILE_H, 3, 2);
  }
  ctx.fillStyle = "#ebe7df";
  ctx.fillRect(x0 + 2, y0 + 3, TILE_W - 4, 5);
  ctx.fillStyle = "rgba(60,54,46,0.35)";
  ctx.fillRect(x0 + 2, y0 + 8, TILE_W - 4, 2);
  ctx.fillStyle = "rgba(60,54,46,0.25)";
  ctx.fillRect(x0 + 2, y0 + TILE_H - 5, TILE_W - 4, 3);
}

/** Canvas y of an atlas row; CanvasTexture flips Y, so row 0 is the bottom strip. */
function rowTop(row: number): number {
  return (ATLAS_ROWS - 1 - row) * TILE_H;
}

/**
 * 4 variants across by 8 storeys + 1 storefront row down. Most panes stay dark;
 * a scattered few are lit so the block reads as evening.
 */
export function makeFacadeAtlas(seed: number): FacadeMaps {
  const albedoCanvas = document.createElement("canvas");
  const emissiveCanvas = document.createElement("canvas");
  albedoCanvas.width = emissiveCanvas.width = TILE_W * FACADE_VARIANTS;
  albedoCanvas.height = emissiveCanvas.height = TILE_H * ATLAS_ROWS;
  const albedo = albedoCanvas.getContext("2d")!;
  const emissive = emissiveCanvas.getContext("2d")!;
  emissive.fillStyle = "#000000";
  emissive.fillRect(0, 0, emissiveCanvas.width, emissiveCanvas.height);

  for (let v = 0; v < FACADE_VARIANTS; v++) {
    const x0 = v * TILE_W;
    const cols = 4;
    const cellW = TILE_W / cols;
    const padX = cellW * (0.2 + v * 0.03);
    const litAt = 0.8 + (v % 2) * 0.06;

    for (let row = 0; row < STORY_ROWS; row++) {
      const y0 = rowTop(row);
      paintWall(albedo, x0, y0, seed + v * 31 + row);
      const winTop = y0 + TILE_H * 0.2;
      const winH = TILE_H * 0.58;
      for (let c = 0; c < cols; c++) {
        const lit = hash2(c + v * 13, row + 3, seed + v * 97 + 101) > litAt;
        const x = x0 + c * cellW + padX;
        const w = cellW - padX * 2;
        // Stone surround, then glass, then a mullion and a sill.
        albedo.fillStyle = "#bfb8ab";
        albedo.fillRect(x - 3, winTop - 3, w + 6, winH + 6);
        albedo.fillStyle = lit ? "#f4efe6" : "#14161c";
        albedo.fillRect(x, winTop, w, winH);
        if (!lit) {
          albedo.fillStyle = "#262a32";
          albedo.fillRect(x, winTop, w, winH * 0.18);
        }
        albedo.fillStyle = lit ? "#a08a6a" : "#2c2f36";
        albedo.fillRect(x + w / 2 - 1, winTop, 2, winH);
        albedo.fillRect(x, winTop + winH * 0.5 - 1, w, 2);
        albedo.fillStyle = "#e6e1d7";
        albedo.fillRect(x - 5, winTop + winH + 2, w + 10, 4);
        if (lit) {
          const warm = hash2(c, row, seed + v * 7) > 0.5;
          emissive.fillStyle = warm ? "#ffffff" : "#c8b89a";
          emissive.fillRect(x, winTop, w, winH);
          emissive.fillStyle = "#000000";
          emissive.fillRect(x + w / 2 - 1, winTop, 2, winH);
          emissive.fillRect(x, winTop + winH * 0.5 - 1, w, 2);
        }
      }
    }

    // Storefront: sign band, two display windows either side of a door.
    const y0 = rowTop(STOREFRONT_ROW);
    paintWall(albedo, x0, y0, seed + v * 31 + 77);
    const signTop = y0 + 10;
    albedo.fillStyle = "#4a4038";
    albedo.fillRect(x0 + 8, signTop, TILE_W - 16, 14);
    const glassTop = signTop + 20;
    const glassH = TILE_H - (glassTop - y0) - 6;
    const doorW = 28;
    const doorX = x0 + TILE_W / 2 - doorW / 2;
    const shopLit = hash2(v, 5, seed + 13) > 0.35;
    for (const [gx, gw] of [
      [x0 + 10, doorX - x0 - 16],
      [doorX + doorW + 6, x0 + TILE_W - 10 - (doorX + doorW + 6)],
    ] as const) {
      albedo.fillStyle = "#2a2622";
      albedo.fillRect(gx - 3, glassTop - 3, gw + 6, glassH + 6);
      albedo.fillStyle = shopLit ? "#e9dcc0" : "#181a1e";
      albedo.fillRect(gx, glassTop, gw, glassH);
      albedo.fillStyle = "#2a2622";
      albedo.fillRect(gx + gw / 2 - 1, glassTop, 2, glassH);
      if (shopLit) {
        emissive.fillStyle = "#8c7c60";
        emissive.fillRect(gx, glassTop, gw, glassH);
      }
    }
    albedo.fillStyle = "#1e1a16";
    albedo.fillRect(doorX, glassTop, doorW, glassH);
  }

  return { albedo: finish(albedoCanvas, true), emissive: finish(emissiveCanvas, false) };
}

const VERTEX_DECL = /* glsl */ `
attribute vec4 aFacade;
varying vec4 vFacade;
varying vec2 vFacadeUv;
`;

const FRAGMENT_DECL = /* glsl */ `
varying vec4 vFacade;
varying vec2 vFacadeUv;
`;

/** Atlas lookup with gradients from the continuous coordinate, so storey seams do not drop a mip. */
const FACADE_UV = /* glsl */ `
float facadeFloors = max(vFacade.x, 1.0);
float facadeStory = vFacadeUv.y * facadeFloors;
float facadeIdx = floor(facadeStory);
float facadeStore = mod(vFacade.w, 2.0);
float facadeURep = max(1.0, floor(vFacade.w / 2.0));
float facadeRow = (facadeStore > 0.5 && facadeIdx < 0.5)
  ? ${STOREFRONT_ROW.toFixed(1)}
  : mod(facadeIdx + vFacade.z, ${STORY_ROWS.toFixed(1)});
float facadeU = vFacadeUv.x * facadeURep;
vec2 facadeAtlasUv = vec2(
  (fract(facadeU) + vFacade.y) / ${FACADE_VARIANTS.toFixed(1)},
  (facadeRow + fract(facadeStory)) / ${ATLAS_ROWS.toFixed(1)}
);
vec2 facadeCont = vec2(facadeU / ${FACADE_VARIANTS.toFixed(1)}, facadeStory / ${ATLAS_ROWS.toFixed(1)});
vec2 facadeDx = dFdx(facadeCont);
vec2 facadeDy = dFdy(facadeCont);
`;

const MAP_FRAGMENT = /* glsl */ `
${FACADE_UV}
#ifdef USE_MAP
  diffuseColor *= textureGrad(map, facadeAtlasUv, facadeDx, facadeDy);
#endif
`;

const EMISSIVE_FRAGMENT = /* glsl */ `
#ifdef USE_EMISSIVEMAP
  totalEmissiveRadiance *= textureGrad(emissiveMap, facadeAtlasUv, facadeDx, facadeDy).rgb;
#endif
`;

/** Baked occlusion: the bottom storey and a half sits in shade, and so does the cornice underside. */
const AO_FRAGMENT = /* glsl */ `
#include <color_fragment>
float facadeBaseAo = mix(0.55, 1.0, smoothstep(0.0, 1.6 / facadeFloors, vFacadeUv.y));
float facadeTopAo = mix(1.0, 0.85, smoothstep(0.9, 1.0, vFacadeUv.y));
diffuseColor.rgb *= facadeBaseAo * facadeTopAo;
`;

/**
 * Standard material that reads the facade atlas per storey. Instance colour
 * tints the albedo only, so lit windows stay warm on every brick colour.
 */
export function makeFacadeMaterial(maps: FacadeMaps): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    map: maps.albedo,
    emissiveMap: maps.emissive,
    emissive: new THREE.Color("#ffd27a"),
    emissiveIntensity: 1.8,
    roughness: 0.85,
  });
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${VERTEX_DECL}`)
      .replace("#include <uv_vertex>", "#include <uv_vertex>\nvFacade = aFacade;\nvFacadeUv = uv;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${FRAGMENT_DECL}`)
      .replace("#include <map_fragment>", MAP_FRAGMENT)
      .replace("#include <color_fragment>", AO_FRAGMENT)
      .replace("#include <emissivemap_fragment>", EMISSIVE_FRAGMENT);
  };
  mat.customProgramCacheKey = () => "facade-atlas-v1";
  return mat;
}
