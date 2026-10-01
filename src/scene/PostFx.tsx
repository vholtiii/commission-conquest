import { useLayoutEffect, useMemo } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import {
  BlendFunction,
  BloomEffect,
  EffectComposer,
  EffectPass,
  NoiseEffect,
  RenderPass,
  ToneMappingEffect,
  ToneMappingMode,
  VignetteEffect,
} from "postprocessing";
import { HalfFloatType } from "three";

/**
 * Bloom, vignette, film grain, then filmic tone mapping.
 * Built on postprocessing's composer directly: the @react-three/postprocessing
 * effect components throw in react-three-fiber's prop applier on three 0.170.
 */
export default function PostFx() {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);

  const composer = useMemo(() => {
    const autoClear = gl.autoClear;
    const next = new EffectComposer(gl, {
      multisampling: 0,
      frameBufferType: HalfFloatType,
    });
    const bloom = new BloomEffect({
      mipmapBlur: true,
      luminanceThreshold: 0.85,
      luminanceSmoothing: 0.2,
      intensity: 0.9,
    });
    const vignette = new VignetteEffect({ offset: 0.35, darkness: 0.7 });
    const noise = new NoiseEffect({ blendFunction: BlendFunction.SOFT_LIGHT });
    noise.blendMode.opacity.value = 0.04;
    const tone = new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC });
    next.addPass(new RenderPass(scene, camera));
    next.addPass(new EffectPass(camera, bloom));
    next.addPass(new EffectPass(camera, vignette, noise, tone));
    return { next, autoClear };
  }, [gl, scene, camera]);

  useLayoutEffect(() => {
    composer.next.setSize(size.width, size.height);
  }, [composer, size]);

  useLayoutEffect(() => {
    return () => {
      gl.autoClear = composer.autoClear;
      for (const pass of composer.next.passes) pass.dispose();
      composer.next.inputBuffer.dispose();
      composer.next.outputBuffer.dispose();
    };
  }, [composer, gl]);

  useFrame((_, delta) => {
    composer.next.render(delta);
  }, 1);

  return null;
}
