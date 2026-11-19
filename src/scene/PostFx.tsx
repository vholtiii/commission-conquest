import { useLayoutEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import {
  BlendFunction,
  BloomEffect,
  DepthOfFieldEffect,
  EffectComposer,
  EffectPass,
  NoiseEffect,
  RenderPass,
  SMAAEffect,
  SMAAPreset,
  ToneMappingEffect,
  ToneMappingMode,
  VignetteEffect,
  type Effect,
} from "postprocessing";
import { reelFocus } from "./hits/reelFocus";
import { N8AOPostPass } from "n8ao";
import { HalfFloatType } from "three";
import type { GraphicsTier } from "./sceneTheme";

/**
 * Ambient occlusion (high only), bloom, then SMAA, vignette, film grain and
 * filmic tone mapping in one merged pass.
 * Built on postprocessing's composer directly: the @react-three/postprocessing
 * effect components throw in react-three-fiber's prop applier on three 0.170.
 */
export default function PostFx({ tier }: { tier: GraphicsTier }) {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  const dpr = useThree((s) => s.viewport.dpr);

  const composer = useMemo(() => {
    const autoClear = gl.autoClear;
    const next = new EffectComposer(gl, {
      multisampling: 0,
      frameBufferType: HalfFloatType,
    });
    next.addPass(new RenderPass(scene, camera));

    if (tier === "high") {
      // Half-res with trimmed sample counts: roughly 3-4 ms at 1080p on an Intel UHD 770.
      const ao = new N8AOPostPass(scene, camera);
      Object.assign(ao.configuration, {
        halfRes: true,
        aoSamples: 8,
        denoiseSamples: 4,
        denoiseRadius: 6,
        aoRadius: 2.5,
        intensity: 2.5,
        distanceFalloff: 1,
        screenSpaceRadius: false,
        gammaCorrection: false,
      });
      // The composer never clears its output buffer's depth, so N8AO's final
      // full-screen copy fails the depth test unless it is disabled.
      ao.copyQuad.material.depthTest = false;
      next.addPass(ao);
    }

    let dof: DepthOfFieldEffect | null = null;
    let dofPass: EffectPass | null = null;
    if (tier !== "low") {
      next.addPass(
        new EffectPass(
          camera,
          new BloomEffect({
            mipmapBlur: true,
            luminanceThreshold: 0.85,
            luminanceSmoothing: 0.2,
            intensity: 0.9,
          }),
        ),
      );
      // Compiled on the first frame (bokeh at 0), then only while a reel names a focus.
      dof = new DepthOfFieldEffect(camera, {
        focusDistance: 8,
        focusRange: 3,
        bokehScale: 0,
        resolutionScale: tier === "high" ? 0.5 : 0.35,
      });
      dof.target = null;
      dofPass = new EffectPass(camera, dof);
      next.addPass(dofPass);
    }

    const finals: Effect[] = [];
    if (tier !== "low") {
      finals.push(new SMAAEffect({ preset: tier === "high" ? SMAAPreset.MEDIUM : SMAAPreset.LOW }));
    }
    const noise = new NoiseEffect({ blendFunction: BlendFunction.SOFT_LIGHT });
    noise.blendMode.opacity.value = 0.04;
    finals.push(
      new VignetteEffect({ offset: 0.35, darkness: 0.7 }),
      noise,
      new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC }),
    );
    next.addPass(new EffectPass(camera, ...finals));
    return { next, autoClear, dof, dofPass };
  }, [gl, scene, camera, tier]);

  useLayoutEffect(() => {
    // Passes (N8AO included) get their sizes from the composer, in drawing-buffer pixels.
    composer.next.setSize(size.width, size.height);
  }, [composer, size, dpr]);

  useLayoutEffect(() => {
    return () => {
      gl.autoClear = composer.autoClear;
      for (const pass of composer.next.passes) pass.dispose();
      composer.next.inputBuffer.dispose();
      composer.next.outputBuffer.dispose();
    };
  }, [composer, gl]);

  const dofWarmed = useRef(false);

  useFrame((_, delta) => {
    const dof = composer.dof;
    const pass = composer.dofPass;
    if (dof && pass) {
      const on = reelFocus.active;
      // One frame at zero bokeh compiles the pass before a reel needs it.
      if (!dofWarmed.current) {
        pass.enabled = true;
        dof.bokehScale = 0;
        dofWarmed.current = true;
      } else {
        pass.enabled = on;
        dof.bokehScale = on ? 2.6 : 0;
        dof.target = on ? reelFocus.point : null;
      }
    }
    composer.next.render(delta);
  }, 1);

  return null;
}
