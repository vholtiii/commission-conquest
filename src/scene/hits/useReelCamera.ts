import { useEffect, useMemo, useRef } from "react";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";
import {
  applyShake,
  dropOffset,
  handheld,
  lensFor,
  moveCam,
  resetLens,
  setLens,
  ShotSolver,
  type CamControls,
  type Coverage,
  type Shot,
  type Space,
} from "./cameraRig";

export interface FrameOpts {
  /** Spring stiffness as the old per-frame share at 60Hz. */
  k: number;
  dt: number;
  coverage: Coverage;
  /** Hard cut on the first frame of this beat instead of easing over. */
  cut?: boolean;
  handheld?: number;
  /** The shot rides a moving subject: match its speed rather than trail it. */
  follow?: boolean;
}

/** Dev only: a move this far in one frame without a cut reads as a jump. */
const JUMP = 0.6;
/** A new beat set up further away than this is cut to; easing over would whip across the street. */
const FAR_SETUP = 8;

/**
 * One camera per reel: every shot is kept out of the buildings, eased on a
 * spring, lensed for its coverage, and given back to the map at the end.
 * `shake` is the reel's jolt, laid on after the spring so the spring never sees it.
 */
export function useReelCamera(space: Space | null, reelKey: string, shake?: { current: number }) {
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls as unknown as CamControls | null);
  const solver = useMemo(() => new ShotSolver(space), [space, reelKey]);
  const beat = useRef("");
  const prevPos = useRef(new THREE.Vector3());
  const seed = useMemo(() => {
    let h = 0;
    for (let i = 0; i < reelKey.length; i++) h = (h * 31 + reelKey.charCodeAt(i)) | 0;
    return Math.abs(h % 1000);
  }, [reelKey]);

  useEffect(() => {
    beat.current = "";
    return () => resetLens(camera);
  }, [camera, reelKey]);

  return {
    frame(beatKey: string, shot: Shot, opts: FrameOpts): void {
      const opening = beat.current === "";
      const first = beat.current !== beatKey;
      if (import.meta.env.DEV && !opening && space && !space.isClear(camera.position)) {
        // Where last frame was actually drawn from, shake included.
        const w = window as unknown as Record<string, unknown>;
        w.__camInside = ((w.__camInside as number) ?? 0) + 1;
      }
      beat.current = beatKey;
      if (first) solver.reset();
      const s = solver.resolve(shot, first ? undefined : camera.position, opts.dt);
      // Easing down from the map, or across a corner into a new beat, would fly the lens through brick. Cut instead.
      const walled = first && !!space && !space.passable(camera.position, s.pos);
      const far = first && camera.position.distanceTo(s.pos) > FAR_SETUP;
      const cut = (!!opts.cut && first) || opening || walled || far;
      moveCam(camera, controls, s.pos, s.look, opts.k, opts.dt, { cut, follow: opts.follow, space });
      setLens(camera, lensFor(opts.coverage), opts.dt, cut);
      if (opts.handheld) handheld(camera, opts.handheld, seed);
      if (space && !space.isClear(camera.position)) dropOffset(camera);
      if (shake) applyShake(camera, shake, opts.dt, space, seed);
      if (import.meta.env.DEV) {
        const w = window as unknown as Record<string, unknown>;
        if (!cut && camera.position.distanceTo(prevPos.current) > JUMP) w.__camJumps = ((w.__camJumps as number) ?? 0) + 1;
        w.__camDbg = { beatKey, shot, s, cut, cam: camera.position.clone(), fov: (camera as THREE.PerspectiveCamera).fov };
      }
      prevPos.current.copy(camera.position);
    },
  };
}
