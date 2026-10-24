declare module "n8ao" {
  import type { Camera, Color, Scene, ShaderMaterial } from "three";
  import { Pass } from "postprocessing";

  export class N8AOPostPass extends Pass {
    constructor(scene: Scene, camera: Camera, width?: number, height?: number);
    configuration: {
      aoSamples: number;
      aoRadius: number;
      denoiseSamples: number;
      denoiseRadius: number;
      distanceFalloff: number;
      intensity: number;
      color: Color;
      gammaCorrection: boolean;
      screenSpaceRadius: boolean;
      halfRes: boolean;
      depthAwareUpsampling: boolean;
      transparencyAware: boolean;
      accumulate: boolean;
    };
    copyQuad: { material: ShaderMaterial };
    setSize(width: number, height: number): void;
    dispose(): void;
  }
}
