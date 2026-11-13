import * as THREE from 'three';
import { LIMITS, WORLD } from '../game/catalog.ts';
import type { CreateScene, GameState, HeroId, Projection, SceneHandle, SceneOptions, SkinId } from '../game/types.ts';
import { createWorld } from './models.ts';
import type { World } from './models.ts';

// Camera rig: behind and above the heroine, looking down the causeway. Simulation +z is world -z.
const CAMERA_HEIGHT = 9.5;
const CAMERA_BACK = 17;
const PITCH_DEG = 13;
const BASE_VFOV = 52;
// The deck plus the rails must fit the viewport width at the heroine, with a margin.
const FIT_HALF_WIDTH = WORLD.halfWidth + 0.9;
const MAX_VFOV = 74;
const NEAR = 0.5;
const FAR = 420;

/** Pixel ratio for the WebGL backbuffer: never above the shared cap, 1 for anything unusable. */
export function clampPixelRatio(ratio: number | undefined): number {
  if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio <= 0) return 1;
  return Math.min(ratio, LIMITS.pixelRatio);
}

/** Frames the heroine low, the cathedral high and the lanes inside the viewport for this aspect ratio. */
export function configureCamera(camera: THREE.PerspectiveCamera, aspect: number): void {
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const halfFitTan = FIT_HALF_WIDTH / (CAMERA_BACK * safeAspect);
  const fitFov = THREE.MathUtils.radToDeg(2 * Math.atan(halfFitTan));
  camera.fov = Math.min(MAX_VFOV, Math.max(BASE_VFOV, fitFov));
  camera.aspect = safeAspect;
  camera.near = NEAR;
  camera.far = FAR;
  camera.position.set(0, CAMERA_HEIGHT, CAMERA_BACK);
  camera.up.set(0, 1, 0);
  const pitch = THREE.MathUtils.degToRad(PITCH_DEG);
  camera.lookAt(0, CAMERA_HEIGHT - Math.sin(pitch) * 100, CAMERA_BACK - Math.cos(pitch) * 100);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
}

const scratch = new THREE.Vector3();

/**
 * Projects a simulation point (x, z) at an optional height onto CSS pixels inside a width x height viewport.
 * `visible` is false behind the camera or outside the viewport.
 */
export function projectToViewport(camera: THREE.PerspectiveCamera, x: number, z: number, width: number, height: number, y = 0): Projection {
  camera.updateMatrixWorld();
  scratch.set(x, y, -z);
  const inFront = scratch.clone().applyMatrix4(camera.matrixWorldInverse).z < 0;
  scratch.project(camera);
  const px = (scratch.x + 1) / 2 * width;
  const py = (1 - scratch.y) / 2 * height;
  const finite = Number.isFinite(px) && Number.isFinite(py);
  const visible = finite && inFront && scratch.x >= -1 && scratch.x <= 1 && scratch.y >= -1 && scratch.y <= 1;
  return { x: finite ? px : 0, y: finite ? py : 0, visible };
}

function viewportSize(canvas: HTMLCanvasElement): { width: number; height: number } {
  const width = canvas.clientWidth || canvas.width || 1;
  const height = canvas.clientHeight || canvas.height || 1;
  return { width, height };
}

export const createScene: CreateScene = (canvas: HTMLCanvasElement, options: SceneOptions): SceneHandle => {
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
  } catch (cause) {
    throw new Error('Gravewave could not start WebGL rendering. Try a current browser with hardware acceleration enabled.', { cause });
  }

  const scene = new THREE.Scene();
  let world: World;
  try {
    world = createWorld(scene, options);
  } catch (cause) {
    renderer.dispose();
    throw cause;
  }

  const pixelRatio = clampPixelRatio(options.pixelRatio);
  renderer.setPixelRatio(pixelRatio);
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const camera = new THREE.PerspectiveCamera();
  let { width, height } = viewportSize(canvas);
  let contextLost = false;
  let disposed = false;

  const applySize = (): void => {
    renderer.setSize(width, height, false);
    configureCamera(camera, width / height);
  };
  applySize();

  const onLost = (event: Event): void => { event.preventDefault(); contextLost = true; };
  const onRestored = (): void => { contextLost = false; applySize(); };
  canvas.addEventListener('webglcontextlost', onLost);
  canvas.addEventListener('webglcontextrestored', onRestored);

  const guard = (): void => { if (disposed) throw new Error('Gravewave scene was disposed.'); };

  return {
    resize(nextWidth: number, nextHeight: number): void {
      guard();
      if (!Number.isFinite(nextWidth) || !Number.isFinite(nextHeight) || nextWidth < 1 || nextHeight < 1) return;
      width = nextWidth;
      height = nextHeight;
      applySize();
    },
    render(state: GameState, dt: number): void {
      guard();
      world.sync(state, dt);
      if (contextLost) return;
      renderer.render(scene, camera);
    },
    setAppearance(hero: HeroId, skin: SkinId): void {
      guard();
      world.setAppearance(hero, skin);
    },
    project(x: number, z: number): Projection {
      guard();
      return projectToViewport(camera, x, z, width, height);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
      world.dispose();
      renderer.dispose();
    },
  };
};
