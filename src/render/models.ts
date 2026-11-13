import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { LIMITS, SECTORS, WORLD, getSkin } from '../game/catalog.ts';
import type { GameEvent, GameState, HeroId, Palette, SceneOptions, SectorDefinition, SkinId, Telegraph } from '../game/types.ts';

// World space: x is simulation x, y is up, world z is -simulation z. The camera sits at +z looking toward -z.

export const LANDMARK_ANCHOR = { x: 0, y: 22, z: -118 } as const;

const MAX_DT = 0.1;
const SCROLL_SPEED = 9;
const REDUCED_SCROLL = 0.3;
const RING_POOL = 8;
const DECK_HALF = WORLD.halfWidth + 1.3;
const DECK_LENGTH = 190;
const DECK_Z_NEAR = 20;
const DECK_TILE = 8;
const WATER_Y = -3.6;
const MODULES = 16;
const MODULE_SPACING = 8;
const MODULE_Z_NEAR = 14;
const MOON = { x: 16, y: 30, z: -165 } as const;
const HEAD_YAW = -2.4;
const HERO_SCALE = 1.2;
const GHOST_BASE_Y = 0.95;

export type EntityKind = 'player' | 'enemy' | 'object' | 'telegraph';

export interface WorldCounts {
  enemies: number;
  pooledEnemies: number;
  projectiles: number;
  objects: number;
  telegraphs: number;
  ghosts: number;
  particles: number;
  rings: number;
}

export interface World {
  /** Diagnostic: the group that holds every node the world owns. */
  readonly root: THREE.Group;
  /** Diagnostic: live presentation counts, updated in place by sync. */
  readonly counts: Readonly<WorldCounts>;
  /** Diagnostic: the view for a simulation entity, or undefined when none is shown. */
  find(kind: EntityKind, id: number): THREE.Object3D | undefined;
  sync(state: Readonly<GameState>, dt: number): void;
  setAppearance(hero: HeroId, skin: SkinId): void;
  dispose(): void;
}

export type CreateWorld = (scene: THREE.Scene, options: SceneOptions) => World;

export interface TelegraphBounds { minX: number; maxX: number; minZ: number; maxZ: number }

/** Simulation-space damage rectangle of a telegraph; (x, z) is its center. */
export function telegraphBounds(t: Pick<Telegraph, 'x' | 'z' | 'width' | 'depth'>): TelegraphBounds {
  return { minX: t.x - t.width / 2, maxX: t.x + t.width / 2, minZ: t.z - t.depth / 2, maxZ: t.z + t.depth / 2 };
}

// ---------------------------------------------------------------- helpers

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const damp = (current: number, target: number, rate: number, dt: number): number => lerp(current, target, 1 - Math.exp(-rate * dt));
const smoothstep = (a: number, b: number, v: number): number => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const TAU = Math.PI * 2;
const HEX = /^#[0-9a-f]{6}$/i;

function sectorSlot(sector: number): number {
  const n = Number.isFinite(sector) ? Math.floor(sector) : 0;
  return ((n % SECTORS.length) + SECTORS.length) % SECTORS.length;
}

function createRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

// ---------------------------------------------------------------- ownership

interface Owned {
  geo<T extends THREE.BufferGeometry>(g: T): T;
  mat<T extends THREE.Material>(m: T): T;
  tex<T extends THREE.Texture>(t: T): T;
  inst<T extends THREE.InstancedMesh>(m: T): T;
  disposeAll(): void;
}

function createOwned(): Owned {
  const geos = new Set<THREE.BufferGeometry>();
  const mats = new Set<THREE.Material>();
  const texs = new Set<THREE.Texture>();
  const insts = new Set<THREE.InstancedMesh>();
  return {
    geo: g => { geos.add(g); return g; },
    mat: m => { mats.add(m); return m; },
    tex: t => { texs.add(t); return t; },
    inst: m => { insts.add(m); return m; },
    disposeAll() {
      for (const m of insts) m.dispose();
      for (const g of geos) g.dispose();
      for (const m of mats) m.dispose();
      for (const t of texs) t.dispose();
      insts.clear(); geos.clear(); mats.clear(); texs.clear();
    },
  };
}

// ---------------------------------------------------------------- geometry kit

type V3 = readonly [number, number, number];
interface Part { g: THREE.BufferGeometry; p?: V3; r?: V3; s?: V3; c?: THREE.ColorRepresentation }

const box = (w: number, h: number, d: number): THREE.BufferGeometry => new THREE.BoxGeometry(w, h, d);
const sph = (r: number, ws = 14, hs = 10): THREE.BufferGeometry => new THREE.SphereGeometry(r, ws, hs);
const cyl = (rt: number, rb: number, h: number, seg = 14, open = false): THREE.BufferGeometry => new THREE.CylinderGeometry(rt, rb, h, seg, 1, open);
const cone = (r: number, h: number, seg = 12): THREE.BufferGeometry => new THREE.ConeGeometry(r, h, seg);
const tor = (r: number, tube: number, arc = TAU, seg = 20, radial = 8): THREE.BufferGeometry => new THREE.TorusGeometry(r, tube, radial, seg, arc);
const circ = (r: number, seg = 24): THREE.BufferGeometry => new THREE.CircleGeometry(r, seg);
const quad = (w: number, h: number): THREE.BufferGeometry => new THREE.PlaneGeometry(w, h);
const flat = (g: THREE.BufferGeometry): THREE.BufferGeometry => { g.rotateX(-Math.PI / 2); return g; };

const scratchMatrix = new THREE.Matrix4();
const scratchQuat = new THREE.Quaternion();
const scratchEuler = new THREE.Euler();
const scratchPos = new THREE.Vector3();
const scratchScale = new THREE.Vector3();

function mergeParts(own: Owned, parts: readonly Part[], colored = false): THREE.BufferGeometry {
  const list: THREE.BufferGeometry[] = [];
  for (const part of parts) {
    const g = part.g.index ? part.g.toNonIndexed() : part.g.clone();
    const [px, py, pz] = part.p ?? [0, 0, 0];
    const [rx, ry, rz] = part.r ?? [0, 0, 0];
    const [sx, sy, sz] = part.s ?? [1, 1, 1];
    scratchMatrix.compose(scratchPos.set(px, py, pz), scratchQuat.setFromEuler(scratchEuler.set(rx, ry, rz)), scratchScale.set(sx, sy, sz));
    g.applyMatrix4(scratchMatrix);
    if (colored) {
      const color = new THREE.Color(part.c ?? 0xffffff);
      const count = g.attributes.position.count;
      const array = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) { array[i * 3] = color.r; array[i * 3 + 1] = color.g; array[i * 3 + 2] = color.b; }
      g.setAttribute('color', new THREE.BufferAttribute(array, 3));
    }
    list.push(g);
  }
  const merged = mergeGeometries(list, false);
  if (!merged) throw new Error('Gravewave could not merge model parts.');
  return own.geo(merged);
}

function heartShape(size: number): THREE.ShapeGeometry {
  const s = new THREE.Shape();
  s.moveTo(0, -0.6);
  s.bezierCurveTo(-1.1, 0.1, -0.6, 0.9, 0, 0.35);
  s.bezierCurveTo(0.6, 0.9, 1.1, 0.1, 0, -0.6);
  const g = new THREE.ShapeGeometry(s, 8);
  g.scale(size, size, size);
  return g;
}

// ---------------------------------------------------------------- materials and textures

interface Kit {
  own: Owned;
  gradient: THREE.DataTexture;
  glowTexture: THREE.DataTexture;
  toon(color: THREE.ColorRepresentation, extra?: THREE.MeshToonMaterialParameters): THREE.MeshToonMaterial;
  basic(color: THREE.ColorRepresentation, extra?: THREE.MeshBasicMaterialParameters): THREE.MeshBasicMaterial;
  additive(color: THREE.ColorRepresentation, opacity: number, extra?: THREE.MeshBasicMaterialParameters): THREE.MeshBasicMaterial;
  glow(color: THREE.ColorRepresentation, opacity: number): THREE.SpriteMaterial;
}

function dataTexture(own: Owned, data: Uint8Array, w: number, h: number, format: THREE.PixelFormat = THREE.RGBAFormat): THREE.DataTexture {
  const t = own.tex(new THREE.DataTexture(data, w, h, format));
  t.needsUpdate = true;
  return t;
}

function createKit(own: Owned): Kit {
  const gradient = dataTexture(own, new Uint8Array([70, 142, 216, 255]), 4, 1, THREE.RedFormat);
  gradient.minFilter = THREE.NearestFilter;
  gradient.magFilter = THREE.NearestFilter;
  gradient.generateMipmaps = false;

  const size = 64;
  const glowData = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.min(1, Math.hypot((x + 0.5) / size - 0.5, (y + 0.5) / size - 0.5) * 2);
      const a = Math.pow(1 - d, 2.2);
      const i = (y * size + x) * 4;
      glowData[i] = 255; glowData[i + 1] = 255; glowData[i + 2] = 255; glowData[i + 3] = Math.round(a * 255);
    }
  }
  const glowTexture = dataTexture(own, glowData, size, size);
  glowTexture.colorSpace = THREE.SRGBColorSpace;
  glowTexture.minFilter = THREE.LinearFilter;
  glowTexture.generateMipmaps = false;

  return {
    own, gradient, glowTexture,
    toon: (color, extra) => own.mat(new THREE.MeshToonMaterial({ color, gradientMap: gradient, ...extra })),
    basic: (color, extra) => own.mat(new THREE.MeshBasicMaterial({ color, ...extra })),
    additive: (color, opacity, extra) => own.mat(new THREE.MeshBasicMaterial({ color, opacity, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, ...extra })),
    glow: (color, opacity) => own.mat(new THREE.SpriteMaterial({ map: glowTexture, color, opacity, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })),
  };
}

function paintDeck(data: Uint8Array, w: number, h: number, base: THREE.Color, accent: THREE.Color): void {
  const b = base.getRGB({ r: 0, g: 0, b: 0 }, THREE.SRGBColorSpace);
  const a = accent.getRGB({ r: 0, g: 0, b: 0 }, THREE.SRGBColorSpace);
  const width = DECK_HALF * 2;
  const put = (i: number, r: number, g: number, bl: number): void => {
    data[i] = clamp(r, 0, 1) * 255; data[i + 1] = clamp(g, 0, 1) * 255; data[i + 2] = clamp(bl, 0, 1) * 255; data[i + 3] = 255;
  };
  for (let iy = 0; iy < h; iy++) {
    const v = ((iy + 0.5) / h) * DECK_TILE;
    for (let ix = 0; ix < w; ix++) {
      const x = ((ix + 0.5) / w - 0.5) * width;
      const ax = Math.abs(x);
      const i = (iy * w + ix) * 4;
      // Bright play lanes, darker shoulders, so side lanes read at a glance.
      let k = ax < WORLD.halfWidth ? 1.55 : 0.95;
      const lane = Math.floor((x + WORLD.halfWidth) / (WORLD.halfWidth * 2 / 3));
      if (ax < WORLD.halfWidth && lane === 1) k *= 1.08;
      if (Math.floor(v / 2) % 2 === 0) k *= 0.93;
      if (v % 2 < 0.07) k *= 0.62;
      let r = Math.min(0.85, b.r * k + 0.05);
      let g = Math.min(0.85, b.g * k + 0.05);
      let bl = Math.min(0.9, b.b * k + 0.07);
      const lanePos = Math.abs(ax - WORLD.halfWidth * 2 / 6);
      if (lanePos < 0.05 && v % 4 < 2.3) { r = lerp(r, a.r, 0.7); g = lerp(g, a.g, 0.7); bl = lerp(bl, a.b, 0.7); }
      const edge = Math.abs(ax - WORLD.halfWidth);
      if (edge < 0.1) { r = a.r; g = a.g; bl = a.b; }
      else if (edge < 0.3 && ax > WORLD.halfWidth) { const m = 0.35 * (1 - edge / 0.3); r = lerp(r, a.r, m); g = lerp(g, a.g, m); bl = lerp(bl, a.b, m); }
      if (ax > DECK_HALF - 0.45) { r *= 0.55; g *= 0.55; bl *= 0.6; }
      put(i, r, g, bl);
    }
  }
}

// ---------------------------------------------------------------- environment

interface Environment {
  readonly group: THREE.Group;
  applySector(sector: SectorDefinition, slot: number): void;
  update(clock: number, elapsed: number): void;
  /** Restores the scene's previous fog and background, but only while this world's own are still installed. */
  release(): void;
}

interface StripOptions {
  zNear: number; zFar: number; segments: number; y: number;
  half(z: number): number; center(z: number): number; u(x: number, center: number, half: number): number; vTile: number; fade(z: number): number;
}

function fadedStrip(own: Owned, o: StripOptions): THREE.BufferGeometry {
  const rows = o.segments + 1;
  const pos = new Float32Array(rows * 6);
  const uv = new Float32Array(rows * 4);
  const col = new Float32Array(rows * 6);
  const index: number[] = [];
  for (let r = 0; r < rows; r++) {
    const z = lerp(o.zNear, o.zFar, r / o.segments);
    const h = o.half(z);
    const c = o.center(z);
    const f = o.fade(z);
    const v = (o.zNear - z) / o.vTile;
    pos.set([c - h, o.y, z, c + h, o.y, z], r * 6);
    uv.set([o.u(c - h, c, h), v, o.u(c + h, c, h), v], r * 4);
    col.set([f, f, f, f, f, f], r * 6);
    if (r < o.segments) { const a = r * 2; index.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(index);
  return own.geo(g);
}

function buildEnvironment(kit: Kit, scene: THREE.Scene, reduced: boolean): Environment {
  const { own } = kit;
  const group = new THREE.Group();
  group.name = 'environment';

  // Lights: moonlight key from the camera side, cool rim from the horizon.
  const hemi = new THREE.HemisphereLight(0xb9c4ff, 0x3a1d5c, 1.6);
  const moonLight = new THREE.DirectionalLight(0xdbe2ff, 2.5);
  moonLight.position.set(-6, 12, 10);
  const rim = new THREE.DirectionalLight(0x7fe9ff, 1.2);
  rim.position.set(7, 5, -9);
  group.add(hemi, moonLight, rim);

  // Sky dome with painted gradient.
  const skyGeo = own.geo(new THREE.SphereGeometry(180, 28, 18));
  skyGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(skyGeo.attributes.position.count * 3), 3));
  const sky = new THREE.Mesh(skyGeo, own.mat(new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false })));
  sky.name = 'sky';
  sky.renderOrder = -10;
  sky.frustumCulled = false;
  group.add(sky);

  // Stars.
  const random = createRandom(2026);
  const starCount = 240;
  const starPos = new Float32Array(starCount * 3);
  const starCol = new Float32Array(starCount * 3);
  const tint = new THREE.Color();
  for (let i = 0; i < starCount; i++) {
    const theta = random() * TAU;
    const elev = 0.06 + random() * 0.9;
    const radius = 170;
    const planar = Math.sqrt(1 - elev * elev);
    starPos.set([Math.cos(theta) * planar * radius, elev * radius, -Math.abs(Math.sin(theta)) * planar * radius - 10], i * 3);
    tint.setHSL(0.55 + random() * 0.2, 0.6, 0.78 + random() * 0.2);
    starCol.set([tint.r, tint.g, tint.b], i * 3);
  }
  const starGeo = own.geo(new THREE.BufferGeometry());
  starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
  starGeo.setAttribute('color', new THREE.BufferAttribute(starCol, 3));
  const starMat = own.mat(new THREE.PointsMaterial({ size: 2.4, sizeAttenuation: false, vertexColors: true, fog: false, transparent: true, opacity: 0.9, depthWrite: false }));
  const stars = new THREE.Points(starGeo, starMat);
  stars.name = 'stars';
  stars.frustumCulled = false;
  stars.renderOrder = -9;
  group.add(stars);

  // Moon, halo and horizon glow.
  const moon = new THREE.Group();
  moon.name = 'moon';
  moon.position.set(MOON.x, MOON.y, MOON.z);
  const moonFace = new THREE.Mesh(own.geo(circ(11, 48)), kit.basic('#f6f3ff', { fog: false }));
  const craters = new THREE.Mesh(mergeParts(own, [
    { g: circ(2.2, 20), p: [-3.5, 2.8, 0.05] }, { g: circ(1.4, 18), p: [3.2, -2.5, 0.05] },
    { g: circ(3.0, 20), p: [2.8, 4.2, 0.05] }, { g: circ(1.0, 14), p: [-4.5, -3.4, 0.05] },
  ]), kit.basic('#d9d3f5', { fog: false }));
  const moonHalo = new THREE.Sprite(kit.glow('#9fb4ff', 0.8));
  moonHalo.scale.set(70, 70, 1);
  moonHalo.material.fog = false;
  moonHalo.position.z = -0.5;
  moon.add(moonHalo, moonFace, craters);
  group.add(moon);
  const horizonGlow = new THREE.Sprite(kit.glow('#72e9f3', 0.4));
  horizonGlow.scale.set(300, 60, 1);
  horizonGlow.material.fog = false;
  horizonGlow.position.set(0, 8, -172);
  group.add(horizonGlow);

  // Ocean, ripples and moonlight glitter.
  const oceanMat = kit.basic('#1d1450');
  const ocean = new THREE.Mesh(own.geo(flat(new THREE.PlaneGeometry(520, 440))), oceanMat);
  ocean.name = 'ocean';
  ocean.position.set(0, WATER_Y, -130);
  group.add(ocean);

  const rippleSize = 64;
  const rippleData = new Uint8Array(rippleSize * rippleSize * 4);
  for (let y = 0; y < rippleSize; y++) {
    for (let x = 0; x < rippleSize; x++) {
      const u = x / rippleSize; const v = y / rippleSize;
      const w = Math.sin(TAU * (2 * u + 0.35 * Math.sin(TAU * v))) * Math.sin(TAU * (3 * v + 0.3 * Math.sin(TAU * 2 * u)));
      const i = (y * rippleSize + x) * 4;
      rippleData.set([190, 176, 255, Math.round(Math.pow(clamp(w, 0, 1), 3) * 255)], i);
    }
  }
  const rippleTex = dataTexture(own, rippleData, rippleSize, rippleSize);
  rippleTex.colorSpace = THREE.SRGBColorSpace;
  rippleTex.wrapS = THREE.RepeatWrapping; rippleTex.wrapT = THREE.RepeatWrapping;
  rippleTex.minFilter = THREE.LinearMipmapLinearFilter; rippleTex.generateMipmaps = true;
  const rippleMat = kit.additive('#8a7bff', 0.55, { map: rippleTex, vertexColors: true, fog: false });
  const ripples = new THREE.Mesh(fadedStrip(own, {
    zNear: 36, zFar: -120, segments: 14, y: WATER_Y + 0.02, half: () => 80, center: () => 0, u: x => x / 16, vTile: 16,
    fade: z => smoothstep(36, 18, z) * (1 - smoothstep(-40, -118, z)),
  }), rippleMat);
  ripples.name = 'ripples';
  ripples.frustumCulled = false;
  group.add(ripples);

  const glitterW = 32; const glitterH = 128;
  const glitterData = new Uint8Array(glitterW * glitterH * 4);
  const grand = createRandom(77);
  for (let i = 0; i < glitterW * glitterH; i++) glitterData.set([255, 255, 255, 0], i * 4);
  for (let n = 0; n < 150; n++) {
    const y = Math.floor(grand() * glitterH);
    const cx = clamp(Math.round(glitterW / 2 + (grand() + grand() + grand() - 1.5) * 9), 1, glitterW - 2);
    const len = 2 + Math.floor(grand() * 6);
    const alpha = 90 + grand() * 165;
    for (let k = 0; k < len; k++) {
      const x = clamp(cx - (len >> 1) + k, 0, glitterW - 1);
      glitterData[(y * glitterW + x) * 4 + 3] = Math.max(glitterData[(y * glitterW + x) * 4 + 3], alpha);
    }
  }
  const glitterTex = dataTexture(own, glitterData, glitterW, glitterH);
  glitterTex.colorSpace = THREE.SRGBColorSpace;
  glitterTex.wrapT = THREE.RepeatWrapping;
  glitterTex.minFilter = THREE.LinearMipmapLinearFilter; glitterTex.generateMipmaps = true;
  const camZ = 9;
  const glitterMat = kit.additive('#ecf0ff', 0.95, { map: glitterTex, vertexColors: true, fog: false });
  const glitter = new THREE.Mesh(fadedStrip(own, {
    zNear: 24, zFar: -150, segments: 14, y: WATER_Y + 0.05,
    half: z => 1.2 + 0.2 * (24 - z), center: z => MOON.x * (camZ - z) / (camZ - MOON.z), u: (x, c, h) => (x - c) / (2 * h) + 0.5, vTile: 7,
    fade: z => smoothstep(24, 4, z) * (1 - smoothstep(-70, -150, z)),
  }), glitterMat);
  glitter.name = 'moon-glitter';
  glitter.frustumCulled = false;
  group.add(glitter);

  // Causeway.
  const deckW = 128; const deckH = 64;
  const deckData = new Uint8Array(deckW * deckH * 4);
  const deckTex = dataTexture(own, deckData, deckW, deckH);
  deckTex.colorSpace = THREE.SRGBColorSpace;
  deckTex.wrapS = THREE.ClampToEdgeWrapping; deckTex.wrapT = THREE.RepeatWrapping;
  deckTex.repeat.set(1, DECK_LENGTH / DECK_TILE);
  deckTex.minFilter = THREE.LinearMipmapLinearFilter; deckTex.generateMipmaps = true; deckTex.anisotropy = 4;
  const deck = new THREE.Mesh(own.geo(flat(new THREE.PlaneGeometry(DECK_HALF * 2, DECK_LENGTH))), kit.basic(0xffffff, { map: deckTex }));
  deck.name = 'deck';
  deck.position.set(0, 0, DECK_Z_NEAR - DECK_LENGTH / 2);
  group.add(deck);
  const slab = new THREE.Mesh(own.geo(box(DECK_HALF * 2 + 0.8, 1.1, DECK_LENGTH)), kit.toon('#1c1233'));
  slab.position.set(0, -0.58, DECK_Z_NEAR - DECK_LENGTH / 2);
  group.add(slab);
  const silver = kit.toon('#cfd6ee', { emissive: new THREE.Color('#9fb0d8'), emissiveIntensity: 0.25 });
  const railGeo = own.geo(box(0.12, 0.12, DECK_LENGTH));
  const railParts: THREE.Mesh[] = [];
  for (const s of [-1, 1]) for (const y of [1.1, 0.62]) {
    const rail = new THREE.Mesh(railGeo, silver);
    rail.position.set(s * (DECK_HALF - 0.15), y, DECK_Z_NEAR - DECK_LENGTH / 2);
    railParts.push(rail);
  }
  group.add(...railParts);

  // Scrolling bridge furniture: instanced modules recycled along the causeway.
  const lanternColor = kit.basic('#9be8ff', { fog: true });
  const accentToon = kit.toon('#72e9f3', { emissive: new THREE.Color('#72e9f3'), emissiveIntensity: 0.35 });
  const stone = kit.toon('#2d2250');
  const lampPillar = mergeParts(own, [
    { g: cyl(0.13, 0.17, 3.0, 10), p: [0, 1.5, 0] }, { g: box(0.5, 0.3, 0.5), p: [0, 0.15, 0] },
    { g: cone(0.17, 0.4, 8), p: [0, 3.2, 0] }, { g: tor(0.2, 0.025, TAU, 14, 5), p: [0, 2.2, 0], r: [Math.PI / 2, 0, 0] },
  ]);
  const armArcLeft = own.geo(tor(1.4, 0.07, Math.PI / 2, 14, 6));
  const armArcRight = own.geo(tor(1.4, 0.07, Math.PI / 2, 14, 6));
  armArcRight.rotateY(Math.PI);
  const lantern = own.geo(new THREE.IcosahedronGeometry(0.22, 1));
  const lanternCap = own.geo(cone(0.16, 0.2, 8));
  const post = own.geo(box(0.14, 1.15, 0.14));
  const pier = own.geo(box(1.1, 2.7, 1.1));
  const underArch = own.geo(tor(MODULE_SPACING / 2, 0.22, Math.PI, 18, 6));
  underArch.rotateX(Math.PI);
  underArch.rotateY(Math.PI / 2);
  const bulb = own.geo(sph(0.1, 8, 6));
  const bulbMat = kit.basic(0xffffff, { fog: true });

  const makeInstanced = (g: THREE.BufferGeometry, m: THREE.Material, count: number, name: string): THREE.InstancedMesh => {
    const mesh = own.inst(new THREE.InstancedMesh(g, m, count));
    mesh.name = name;
    mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    return mesh;
  };
  const pillars = makeInstanced(lampPillar, stone, MODULES * 2, 'lamp-pillars');
  const armsL = makeInstanced(armArcLeft, silver, MODULES, 'lamp-arms-left');
  const armsR = makeInstanced(armArcRight, silver, MODULES, 'lamp-arms-right');
  const lanterns = makeInstanced(lantern, lanternColor, MODULES * 2, 'lanterns');
  const caps = makeInstanced(lanternCap, silver, MODULES * 2, 'lantern-caps');
  const posts = makeInstanced(post, silver, MODULES * 2, 'rail-posts');
  const piers = makeInstanced(pier, stone, MODULES * 2, 'piers');
  const arches = makeInstanced(underArch, stone, MODULES * 2, 'under-arches');
  const BULBS = 4;
  const bulbs = makeInstanced(bulb, bulbMat, MODULES * 2 * BULBS, 'string-lights');
  bulbs.setColorAt(0, new THREE.Color(0xffffff));
  const lanternGlow = kit.glow('#7fdcff', 0.75);
  const glows: THREE.Sprite[] = [];

  const lampX = DECK_HALF - 0.25;
  const lampTop = 3.0;
  const m4 = new THREE.Matrix4();
  for (let i = 0; i < MODULES; i++) {
    for (let side = 0; side < 2; side++) {
      const s = side === 0 ? -1 : 1;
      const k = i * 2 + side;
      pillars.setMatrixAt(k, m4.makeTranslation(s * lampX, 0, 0));
      lanterns.setMatrixAt(k, m4.makeTranslation(s * (lampX - 1.4), lampTop + 0.95, 0));
      caps.setMatrixAt(k, m4.makeTranslation(s * (lampX - 1.4), lampTop + 1.25, 0));
      posts.setMatrixAt(k, m4.makeTranslation(s * (DECK_HALF - 0.15), 0.57, MODULE_SPACING / 2));
      piers.setMatrixAt(k, m4.makeTranslation(s * (DECK_HALF - 0.55), WATER_Y + 1.3, 0));
      arches.setMatrixAt(k, m4.makeTranslation(s * (DECK_HALF - 0.55), -1.15, MODULE_SPACING / 2));
      for (let b = 0; b < BULBS; b++) {
        const t = (b + 1) / (BULBS + 1);
        bulbs.setMatrixAt(k * BULBS + b, m4.makeTranslation(s * (lampX - 1.4), lampTop + 0.85 - 0.28 * Math.sin(Math.PI * t), t * MODULE_SPACING));
        bulbs.setColorAt(k * BULBS + b, new THREE.Color(0xffffff));
      }
      const sprite = new THREE.Sprite(lanternGlow);
      sprite.scale.set(2.2, 2.2, 1);
      glows.push(sprite);
      group.add(sprite);
    }
    armsL.setMatrixAt(i, m4.makeTranslation(-lampX + 1.4, lampTop, 0));
    armsR.setMatrixAt(i, m4.makeTranslation(lampX - 1.4, lampTop, 0));
  }
  for (const m of [pillars, armsL, armsR, lanterns, caps, posts, piers, arches, bulbs]) group.add(m);
  const instanced = [pillars, armsL, armsR, lanterns, caps, posts, piers, arches, bulbs];
  const bulbPalette = [new THREE.Color('#ffffff'), new THREE.Color('#72e9f3'), new THREE.Color('#ff8fc2'), new THREE.Color('#ffe08a')];
  const bulbAccent = new THREE.Color();
  const bulbColor = new THREE.Color();

  // Landmarks, one per sector.
  const landmarks: THREE.Group[] = SECTORS.map(sector => buildLandmark(kit, sector));
  for (const lm of landmarks) group.add(lm);

  let slot = -1;
  let accent = new THREE.Color();
  const fog = new THREE.Fog(SECTORS[0].fog, 28, 125);
  const backgroundColor = new THREE.Color(SECTORS[0].sky);
  const previousFog = scene.fog;
  const previousBackground = scene.background;
  scene.fog = fog;
  scene.background = backgroundColor;

  const paintSky = (top: THREE.Color, horizon: THREE.Color): void => {
    const position = skyGeo.attributes.position;
    const colors = skyGeo.attributes.color as THREE.BufferAttribute;
    const mix = new THREE.Color();
    for (let i = 0; i < position.count; i++) {
      const t = Math.pow(clamp(position.getY(i) / 180, 0, 1), 0.55);
      mix.copy(horizon).lerp(top, t);
      colors.setXYZ(i, mix.r, mix.g, mix.b);
    }
    colors.needsUpdate = true;
  };

  const applySector = (sector: SectorDefinition, index: number): void => {
    if (index === slot) return;
    slot = index;
    accent = new THREE.Color(sector.accent);
    const fogColor = new THREE.Color(sector.fog);
    fog.color.copy(fogColor);
    backgroundColor.set(sector.sky);
    paintSky(new THREE.Color(sector.sky), fogColor);
    paintDeck(deckData, deckW, deckH, new THREE.Color(sector.color), accent);
    deckTex.needsUpdate = true;
    oceanMat.color.set(sector.fog).lerp(new THREE.Color('#4a2a9a'), 0.5).multiplyScalar(1.25);
    rippleMat.color.copy(accent).lerp(new THREE.Color('#8a7bff'), 0.6);
    accentToon.color.copy(accent);
    accentToon.emissive.copy(accent);
    lanternColor.color.copy(accent).lerp(new THREE.Color('#e8fbff'), 0.55);
    lanternGlow.color.copy(accent).lerp(new THREE.Color('#7fdcff'), 0.4);
    horizonGlow.material.color.copy(accent);
    hemi.color.copy(accent).lerp(new THREE.Color('#d8dcff'), 0.55);
    hemi.groundColor.set(sector.color);
    bulbAccent.copy(accent);
    landmarks.forEach((lm, i) => { lm.visible = i === index; });
  };

  const span = MODULES * MODULE_SPACING;
  const update = (clock: number, elapsed: number): void => {
    const speed = reduced ? SCROLL_SPEED * REDUCED_SCROLL : SCROLL_SPEED;
    const scroll = Math.max(0, elapsed) * speed;
    const motion = reduced ? 0.15 : 1;
    deckTex.offset.y = scroll / DECK_TILE;
    rippleTex.offset.set(clock * 0.012 * motion, clock * 0.045 * motion);
    glitterTex.offset.y = -clock * 0.08 * motion;
    glitterMat.opacity = reduced ? 0.85 : 0.82 + 0.13 * Math.sin(clock * 5.3);
    starMat.opacity = reduced ? 0.9 : 0.78 + 0.14 * Math.sin(clock * 1.7);
    for (let i = 0; i < MODULES; i++) {
      const z = MODULE_Z_NEAR - ((((i * MODULE_SPACING + scroll) % span) + span) % span);
      for (let side = 0; side < 2; side++) {
        const k = i * 2 + side;
        pillars.instanceMatrix.array[k * 16 + 14] = z;
        lanterns.instanceMatrix.array[k * 16 + 14] = z;
        caps.instanceMatrix.array[k * 16 + 14] = z;
        posts.instanceMatrix.array[k * 16 + 14] = z + MODULE_SPACING / 2;
        piers.instanceMatrix.array[k * 16 + 14] = z;
        arches.instanceMatrix.array[k * 16 + 14] = z + MODULE_SPACING / 2;
        const s = side === 0 ? -1 : 1;
        glows[k].position.set(s * (lampX - 1.4), lampTop + 0.95, z);
        for (let b = 0; b < BULBS; b++) {
          const idx = k * BULBS + b;
          bulbs.instanceMatrix.array[idx * 16 + 14] = z + ((b + 1) / (BULBS + 1)) * MODULE_SPACING;
          const pulse = reduced ? 0.85 : 0.65 + 0.35 * Math.sin(clock * 3 + idx * 1.7);
          bulbColor.copy(b % 2 === 0 ? bulbAccent : bulbPalette[(idx + b) % bulbPalette.length]).multiplyScalar(pulse);
          bulbs.setColorAt(idx, bulbColor);
        }
      }
      armsL.instanceMatrix.array[i * 16 + 14] = z;
      armsR.instanceMatrix.array[i * 16 + 14] = z;
    }
    for (const m of instanced) m.instanceMatrix.needsUpdate = true;
    if (bulbs.instanceColor) bulbs.instanceColor.needsUpdate = true;
    for (const lm of landmarks) { const wheel = lm.getObjectByName('ferris-wheel'); if (wheel && !reduced) wheel.rotation.z = -clock * 0.05; }
  };

  const release = (): void => {
    if (scene.fog === fog) scene.fog = previousFog;
    if (scene.background === backgroundColor) scene.background = previousBackground;
  };

  return { group, applySector, update, release };
}

function buildLandmark(kit: Kit, sector: SectorDefinition): THREE.Group {
  const { own } = kit;
  const g = new THREE.Group();
  g.name = `landmark-${sector.id}`;
  const far = new THREE.Color(sector.sky).lerp(new THREE.Color('#04020a'), 0.5);
  const mid = far.clone().lerp(new THREE.Color(sector.fog), 0.28);
  const window = new THREE.Color(sector.accent).lerp(new THREE.Color('#ffffff'), 0.35);
  const silhouetteMat = kit.basic(0xffffff, { vertexColors: true, fog: false });
  const windowMat = kit.basic(0xffffff, { vertexColors: true, fog: false });
  const body: Part[] = [];
  const lights: Part[] = [];
  const Z = LANDMARK_ANCHOR.z;

  const tower = (x: number, z: number, w: number, h: number, spire: number, c: THREE.Color): void => {
    body.push({ g: box(w, h, w), p: [x, h / 2, z], c });
    body.push({ g: cone(w * 0.78, spire, 4), p: [x, h + spire / 2, z], r: [0, Math.PI / 4, 0], c });
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) body.push({ g: cone(w * 0.12, w * 0.45, 4), p: [x + sx * w * 0.5, h + w * 0.2, z + sz * w * 0.5], c });
    const rows = Math.max(1, Math.floor(h / (w * 1.1)));
    for (let r = 0; r < rows; r++) {
      const y = h * 0.3 + (r + 0.5) * ((h * 0.65) / rows);
      for (const dx of [-0.22, 0.22]) lights.push({ g: quad(w * 0.12, w * 0.3), p: [x + dx * w, y, z + w / 2 + 0.05], c: window });
    }
  };

  if (sector.id === 0) {
    // Ghostlight Pier: cathedral spires, a lighthouse and a long lamplit pier.
    const xs = [-58, -42, -26, -8, 8, 26, 44, 60];
    xs.forEach((x, i) => tower(x, Z - (i % 2) * 8, 7 + (i % 3) * 2, 20 + ((i * 7) % 5) * 7, 16 + (i % 3) * 8, i % 2 ? far : mid));
    body.push({ g: cyl(2.4, 4.2, 40, 10), p: [-70, 20, Z + 14], c: mid });
    body.push({ g: cyl(4, 4, 3, 10), p: [-70, 41, Z + 14], c: far });
    body.push({ g: cone(4.5, 5, 10), p: [-70, 45, Z + 14], c: mid });
    lights.push({ g: sph(2.6, 10, 8), p: [-70, 41.5, Z + 14], c: new THREE.Color('#bff6ff') });
    body.push({ g: box(150, 3, 5), p: [0, 1.5, Z + 22], c: far });
    for (let i = -7; i <= 7; i++) lights.push({ g: sph(0.7, 6, 5), p: [i * 9, 4.4, Z + 24.6], c: window });
  } else if (sector.id === 1) {
    // Velvet Midway: ferris wheel, striped big top and roller-coaster loop.
    const wedges = 14;
    for (let i = 0; i < wedges; i++) {
      const c = new THREE.Color(i % 2 ? '#b81c4a' : '#f3d9ff').lerp(new THREE.Color('#1b0d2a'), 0.45);
      body.push({ g: new THREE.ConeGeometry(18, 18, 1, 1, false, (i / wedges) * TAU, TAU / wedges), p: [24, 20, Z + 16], c });
    }
    body.push({ g: cyl(18, 18, 11, 14), p: [24, 5.5, Z + 16], c: mid });
    for (let i = 0; i < 16; i++) lights.push({ g: sph(0.55, 6, 5), p: [24 + Math.cos((i / 16) * TAU) * 18.2, 11.4, Z + 16 + Math.sin((i / 16) * TAU) * 18.2], c: i % 2 ? window : new THREE.Color('#ffd27a') });
    body.push({ g: cone(0.5, 6, 6), p: [24, 31, Z + 16], c: far });
    lights.push({ g: sph(1.1, 8, 6), p: [24, 35, Z + 16], c: new THREE.Color('#ff6f9a') });
    [-60, -46, 4, 60].forEach((x, i) => tower(x, Z - 6, 6 + (i % 2) * 2, 16 + i * 5, 12 + i * 3, mid));
    body.push({ g: tor(22, 0.7, Math.PI * 1.15, 48, 6), p: [-12, 0, Z - 10], r: [0, 0, 0.1], c: far });
    for (let i = -2; i <= 2; i++) body.push({ g: box(0.7, 24, 0.7), p: [-12 + i * 10 - 2, 10, Z - 10], c: far });
    const wheel = new THREE.Group();
    wheel.name = 'ferris-wheel';
    const wheelParts: Part[] = [{ g: tor(23, 0.55, TAU, 56, 6), c: mid }, { g: tor(14, 0.3, TAU, 40, 5), c: far }, { g: cyl(1.6, 1.6, 1.4, 10), r: [Math.PI / 2, 0, 0], c: far }];
    const wheelLights: Part[] = [];
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * TAU;
      wheelParts.push({ g: box(0.35, 46, 0.35), r: [0, 0, a], c: far });
      wheelLights.push({ g: sph(1.0, 8, 6), p: [Math.cos(a) * 23, Math.sin(a) * 23, 0.5], c: i % 3 === 0 ? new THREE.Color('#ff6f9a') : i % 3 === 1 ? new THREE.Color('#ffd27a') : window });
    }
    wheel.add(new THREE.Mesh(mergeParts(own, wheelParts, true), silhouetteMat), new THREE.Mesh(mergeParts(own, wheelLights, true), windowMat));
    wheel.position.set(-34, 27, Z + 6);
    g.add(wheel);
    body.push({ g: box(1.5, 24, 1.5), p: [-37, 12, Z + 5], r: [0, 0, 0.25], c: far });
    body.push({ g: box(1.5, 24, 1.5), p: [-31, 12, Z + 5], r: [0, 0, -0.25], c: far });
  } else {
    // Cathedral of Static: facade, twin spires, rose window and floating amplifier stacks.
    body.push({ g: box(46, 46, 10), p: [0, 23, Z], c: mid });
    body.push({ g: cone(26, 24, 4), p: [0, 58, Z], r: [0, Math.PI / 4, 0], s: [1, 1, 0.38], c: far });
    for (const s of [-1, 1]) {
      tower(s * 30, Z + 2, 12, 64, 34, far);
      body.push({ g: box(3, 30, 3), p: [s * 46, 15, Z + 3], r: [0, 0, s * 0.45], c: far });
      body.push({ g: cone(2.2, 14, 4), p: [s * 20, 52, Z + 2], c: mid });
    }
    const rose: Part[] = [];
    const jewels = ['#ff4d8d', '#7a5cff', '#2de2e6', '#ffd24d', '#ff7a45', '#9d5cff'];
    for (let i = 0; i < 18; i++) rose.push({ g: new THREE.CircleGeometry(8, 1, (i / 18) * TAU, TAU / 18), p: [0, 33, Z + 5.2], c: jewels[i % jewels.length] });
    lights.push(...rose);
    body.push({ g: tor(8.4, 0.6, TAU, 40, 5), p: [0, 33, Z + 5.2], c: far });
    for (let i = -3; i <= 3; i++) lights.push({ g: quad(1.6, 9), p: [i * 5.5, 14, Z + 5.2], c: window });
    for (const s of [-1, 1]) for (let i = 0; i < 3; i++) {
      const c = new THREE.Color(sector.accent).lerp(new THREE.Color('#ffffff'), 0.25);
      body.push({ g: box(5, 6, 3.4), p: [s * (52 + i * 6), 20 + i * 10, Z + 10 - i * 3], c: far });
      lights.push({ g: circ(1.8, 18), p: [s * (52 + i * 6), 20 + i * 10, Z + 11.8 - i * 3], c });
    }
  }
  g.add(new THREE.Mesh(mergeParts(own, body, true), silhouetteMat), new THREE.Mesh(mergeParts(own, lights, true), windowMat));
  g.children.forEach(child => { child.frustumCulled = false; });
  return g;
}

// ---------------------------------------------------------------- characters

interface PaletteMaterials {
  body: THREE.MeshToonMaterial; cape: THREE.MeshToonMaterial; trim: THREE.MeshToonMaterial; hair: THREE.MeshToonMaterial;
  glowA: THREE.MeshBasicMaterial; glowB: THREE.MeshBasicMaterial; iris: THREE.MeshBasicMaterial; aura: THREE.MeshBasicMaterial;
}

function createPaletteMaterials(kit: Kit, palette: Readonly<Palette>): PaletteMaterials {
  return {
    body: kit.toon(palette.body),
    cape: kit.toon(palette.body, { side: THREE.DoubleSide }),
    trim: kit.toon(palette.trim, { emissive: new THREE.Color(palette.trim), emissiveIntensity: 0.2 }),
    hair: kit.toon(palette.hair, { side: THREE.DoubleSide, emissive: new THREE.Color(palette.hair), emissiveIntensity: 0.12 }),
    glowA: kit.basic(palette.projectile, { fog: true }),
    glowB: kit.basic(palette.trim, { fog: true }),
    iris: kit.basic(palette.trim),
    aura: kit.additive(palette.trim, 0.5, { side: THREE.DoubleSide }),
  };
}

function applyPalette(m: PaletteMaterials, palette: Readonly<Palette>): void {
  m.body.color.set(palette.body);
  m.cape.color.set(palette.body).multiplyScalar(0.72);
  m.trim.color.set(palette.trim); m.trim.emissive.set(palette.trim);
  m.hair.color.set(palette.hair); m.hair.emissive.set(palette.hair);
  m.glowA.color.set(palette.projectile);
  m.glowB.color.set(palette.trim);
  m.iris.color.set(palette.trim);
  m.aura.color.set(palette.trim);
}

interface HeroRig {
  group: THREE.Group;
  head: THREE.Group;
  tails: THREE.Group[];
  cape: THREE.Mesh;
  skirt: THREE.Mesh;
  shield: THREE.Mesh;
  aura: THREE.Mesh;
  weapons: Record<HeroId, THREE.Group>;
  accessories: Record<HeroId, THREE.Group>;
  materials: PaletteMaterials;
}

function buildHero(kit: Kit, palette: Readonly<Palette>): HeroRig {
  const { own } = kit;
  const m = createPaletteMaterials(kit, palette);
  const skin = kit.toon('#f8dcd2');
  const dark = kit.toon('#17102a');
  const silver = kit.toon('#d3dbf0', { emissive: new THREE.Color('#a8b6dc'), emissiveIntensity: 0.25 });
  const eyeDark = kit.basic('#2a1240');
  const white = kit.basic('#ffffff');
  const blush = kit.basic('#ff8fb0', { transparent: true, opacity: 0.7 });

  const group = new THREE.Group();
  group.name = 'hero';
  const body = new THREE.Group();
  body.rotation.y = Math.PI;
  body.scale.setScalar(HERO_SCALE);
  group.add(body);
  const add = (geometry: THREE.BufferGeometry, material: THREE.Material, parent: THREE.Object3D = body): THREE.Mesh => { const mesh = new THREE.Mesh(geometry, material); parent.add(mesh); return mesh; };
  const HP = Math.PI / 2;

  add(mergeParts(own, [
    { g: cyl(0.07, 0.085, 0.62, 10), p: [-0.13, 0.55, 0] }, { g: cyl(0.07, 0.085, 0.62, 10), p: [0.13, 0.55, 0] },
    { g: box(0.2, 0.2, 0.36), p: [-0.13, 0.14, 0.05] }, { g: box(0.2, 0.2, 0.36), p: [0.13, 0.14, 0.05] },
    { g: cyl(0.12, 0.14, 0.12, 10), p: [-0.13, 0.06, -0.06] }, { g: cyl(0.12, 0.14, 0.12, 10), p: [0.13, 0.06, -0.06] },
  ]), dark);
  add(mergeParts(own, [
    { g: tor(0.085, 0.016, TAU, 10, 5), p: [-0.13, 0.3, 0.02], r: [HP, 0, 0] }, { g: tor(0.085, 0.016, TAU, 10, 5), p: [0.13, 0.3, 0.02], r: [HP, 0, 0] },
    { g: tor(0.075, 0.012, TAU, 12, 5), p: [0, 1.66, 0], r: [HP, 0, 0] }, { g: cone(0.03, 0.09, 6), p: [0, 1.58, 0.07], r: [Math.PI, 0, 0] },
  ]), silver);
  const skirt = add(mergeParts(own, [
    { g: cyl(0.24, 0.54, 0.5, 18), p: [0, 0.95, 0] }, { g: cyl(0.2, 0.23, 0.46, 14), p: [0, 1.43, 0] },
    { g: sph(0.1, 10, 8), p: [-0.27, 1.6, 0] }, { g: sph(0.1, 10, 8), p: [0.27, 1.6, 0] },
    { g: cyl(0.055, 0.065, 0.36, 8), p: [-0.28, 1.4, 0.02], r: [0.12, 0, 0.1] },
  ]), m.body);
  add(mergeParts(own, [
    { g: tor(0.54, 0.05, TAU, 24, 8), p: [0, 0.71, 0], r: [HP, 0, 0] }, { g: tor(0.46, 0.04, TAU, 22, 8), p: [0, 0.84, 0], r: [HP, 0, 0] },
    { g: cyl(0.215, 0.215, 0.07, 14), p: [0, 1.2, 0] },
    { g: box(0.03, 0.3, 0.015), p: [0, 1.42, -0.215], r: [0, 0, 0.55] }, { g: box(0.03, 0.3, 0.015), p: [0, 1.42, -0.215], r: [0, 0, -0.55] },
    { g: cone(0.12, 0.2, 6), p: [-0.13, 1.22, -0.26], r: [0, 0, HP] }, { g: cone(0.12, 0.2, 6), p: [0.13, 1.22, -0.26], r: [0, 0, -HP] }, { g: sph(0.05, 8, 6), p: [0, 1.22, -0.26] },
    { g: tor(0.1, 0.014, 4.6, 14, 5), p: [0, 1.6, -0.27] },
  ]), m.trim);
  const cape = add(new THREE.CylinderGeometry(0.3, 0.52, 1.0, 14, 1, true, Math.PI - 0.95, 1.9), m.cape);
  own.geo(cape.geometry);
  cape.position.set(0, 1.12, -0.13);
  // Arms, hands and neck.
  add(mergeParts(own, [
    { g: cyl(0.05, 0.055, 0.46, 8), p: [0.27, 1.5, 0.2], r: [HP - 0.2, 0, 0] }, { g: sph(0.06, 8, 6), p: [0.27, 1.43, 0.43] },
    { g: sph(0.055, 8, 6), p: [-0.3, 1.2, 0.05] }, { g: cyl(0.05, 0.06, 0.12, 8), p: [0, 1.72, 0] },
  ]), skin);

  // Head: face, hair, twin tails.
  const head = new THREE.Group();
  head.name = 'hero-head';
  head.position.set(0, 1.92, 0);
  head.rotation.y = HEAD_YAW;
  body.add(head);
  add(own.geo(new THREE.SphereGeometry(0.23, 18, 14).scale(1, 0.96, 0.96)), skin, head);
  add(mergeParts(own, [
    { g: sph(0.052, 10, 8), p: [-0.085, 0.01, 0.2], s: [1, 1.4, 0.45] }, { g: sph(0.052, 10, 8), p: [0.085, 0.01, 0.2], s: [1, 1.4, 0.45] },
    { g: box(0.075, 0.014, 0.01), p: [-0.085, 0.09, 0.21], r: [0, 0, -0.28] }, { g: box(0.075, 0.014, 0.01), p: [0.085, 0.09, 0.21], r: [0, 0, 0.28] },
    { g: tor(0.04, 0.008, Math.PI, 10, 4), p: [0, -0.04, 0.222], r: [0, 0, Math.PI] },
  ]), eyeDark, head);
  add(mergeParts(own, [
    { g: sph(0.04, 8, 6), p: [-0.085, 0.01, 0.222], s: [1, 1.45, 0.4] }, { g: sph(0.04, 8, 6), p: [0.085, 0.01, 0.222], s: [1, 1.45, 0.4] },
  ]), m.iris, head);
  add(mergeParts(own, [
    { g: sph(0.016, 6, 5), p: [-0.07, 0.04, 0.236] }, { g: sph(0.016, 6, 5), p: [0.1, 0.04, 0.236] },
    { g: sph(0.008, 6, 5), p: [-0.1, -0.02, 0.236] }, { g: sph(0.008, 6, 5), p: [0.07, -0.02, 0.236] },
    { g: cone(0.012, 0.03, 6), p: [0.035, -0.07, 0.223], r: [Math.PI, 0, 0] },
  ]), white, head);
  add(mergeParts(own, [
    { g: circ(0.04, 12), p: [-0.15, -0.04, 0.17], r: [0, -0.7, 0] }, { g: circ(0.04, 12), p: [0.15, -0.04, 0.17], r: [0, 0.7, 0] },
  ]), blush, head);
  add(mergeParts(own, [
    { g: new THREE.SphereGeometry(0.275, 18, 12, Math.PI / 2 + 0.9, TAU - 1.8, 0, Math.PI * 0.62), p: [0, 0.02, -0.01] },
    { g: sph(0.075, 8, 6), p: [-0.15, 0.14, 0.2], s: [1, 1.35, 0.6] }, { g: sph(0.075, 8, 6), p: [-0.07, 0.17, 0.215], s: [1, 1.3, 0.6] },
    { g: sph(0.075, 8, 6), p: [0.02, 0.18, 0.218], s: [1, 1.3, 0.6] }, { g: sph(0.075, 8, 6), p: [0.11, 0.165, 0.21], s: [1, 1.3, 0.6] },
    { g: sph(0.075, 8, 6), p: [0.17, 0.12, 0.19], s: [1, 1.35, 0.6] },
    { g: cyl(0.2, 0.1, 0.7, 10), p: [0, -0.3, -0.14] },
  ]), m.hair, head);
  const tails: THREE.Group[] = [];
  const tailGeo = mergeParts(own, [{ g: cone(0.11, 0.85, 8), p: [0, -0.42, 0], r: [Math.PI, 0, 0] }]);
  const tieGeo = mergeParts(own, [{ g: tor(0.1, 0.022, TAU, 12, 5), p: [0, -0.02, 0], r: [HP, 0, 0] }, { g: sph(0.05, 6, 5), p: [0, -0.88, 0] }]);
  for (const s of [-1, 1]) {
    const pivot = new THREE.Group();
    pivot.position.set(s * 0.26, 0.1, -0.05);
    pivot.add(new THREE.Mesh(tailGeo, m.hair), new THREE.Mesh(tieGeo, m.trim));
    head.add(pivot);
    tails.push(pivot);
  }
  add(mergeParts(own, [
    { g: cone(0.045, 0.14, 6), p: [0.17, 0.27, 0.04], r: [0, 0, -0.4] }, { g: cone(0.045, 0.14, 6), p: [0.27, 0.22, 0.04], r: [0, 0, -1.2] }, { g: sph(0.035, 6, 5), p: [0.21, 0.23, 0.045] },
  ]), m.trim);

  // Per-heroine accessories.
  const accessories = {} as Record<HeroId, THREE.Group>;
  for (const id of ['mira', 'rin', 'sera'] as const) { const a = new THREE.Group(); a.name = `accessory-${id}`; head.add(a); accessories[id] = a; }
  add(own.geo(tor(0.09, 0.018, 4.4, 14, 5)), silver, accessories.mira).position.set(-0.2, 0.2, 0.05);
  accessories.mira.children[0].rotation.set(0, 0.3, 0.5);
  add(mergeParts(own, [{ g: cone(0.045, 0.2, 6), p: [-0.13, 0.27, 0.03], r: [0, 0, 0.35] }, { g: cone(0.045, 0.2, 6), p: [0.13, 0.27, 0.03], r: [0, 0, -0.35] }]), dark, accessories.rin);
  add(mergeParts(own, [{ g: tor(0.07, 0.015, TAU, 12, 5), p: [-0.13, 0.4, 0.02] }, { g: tor(0.07, 0.015, TAU, 12, 5), p: [0.13, 0.4, 0.02] }]), m.trim, accessories.rin);
  add(own.geo(tor(0.2, 0.02, TAU, 24, 6)), m.glowB, accessories.sera).position.set(0, 0.42, 0);
  accessories.sera.children[0].rotation.x = HP;
  add(mergeParts(own, [{ g: sph(0.05, 8, 6), p: [0.22, 0.12, 0.02], s: [1, 1.2, 1] }, { g: cone(0.045, 0.12, 6), p: [0.22, 0.04, 0.02], r: [Math.PI, 0, 0] }]), white, accessories.sera);

  // Weapons held out front (local +z is the heroine's facing).
  const weapons = {} as Record<HeroId, THREE.Group>;
  const mount = new THREE.Group();
  mount.position.set(0.27, 1.42, 0.44);
  body.add(mount);
  const railgun = new THREE.Group(); railgun.name = 'weapon-parasol-railgun';
  add(mergeParts(own, [
    { g: cyl(0.04, 0.05, 1.1, 10), p: [0, 0, 0.4], r: [HP, 0, 0] }, { g: cyl(0.07, 0.07, 0.3, 10), p: [0, 0, -0.1], r: [HP, 0, 0] },
    { g: cyl(0.012, 0.012, 0.45, 6), p: [0, 0.22, 0.1] },
  ]), silver, railgun);
  add(mergeParts(own, [{ g: tor(0.08, 0.016, TAU, 12, 5), p: [0, 0, 0.92] }, { g: tor(0.34, 0.012, TAU, 20, 4), p: [0, 0.4, 0.1], r: [HP, 0, 0] }]), m.trim, railgun);
  add(own.geo(new THREE.SphereGeometry(0.36, 16, 6, 0, TAU, 0, Math.PI / 2).translate(0, 0.4, 0.1)), m.cape, railgun);
  add(own.geo(sph(0.065, 8, 6).translate(0, 0, 1.0)), m.glowA, railgun);
  const guitar = new THREE.Group(); guitar.name = 'weapon-coffin-guitar';
  const coffin = new THREE.Shape();
  coffin.moveTo(-0.12, -0.3); coffin.lineTo(0.12, -0.3); coffin.lineTo(0.24, 0.0); coffin.lineTo(0.15, 0.32); coffin.lineTo(-0.15, 0.32); coffin.lineTo(-0.24, 0.0);
  const coffinGeo = new THREE.ExtrudeGeometry(coffin, { depth: 0.1, bevelEnabled: true, bevelSize: 0.02, bevelThickness: 0.02, bevelSegments: 1 });
  coffinGeo.rotateX(-HP);
  add(mergeParts(own, [{ g: coffinGeo, p: [0, -0.05, 0.05] }]), m.body, guitar);
  add(mergeParts(own, [
    { g: box(0.07, 0.05, 0.85), p: [0, 0.03, 0.6] }, { g: box(0.12, 0.06, 0.16), p: [0, 0.03, 1.1] }, { g: box(0.2, 0.03, 0.06), p: [0, -0.02, 0.1] },
  ]), dark, guitar);
  add(mergeParts(own, [
    { g: box(0.012, 0.012, 0.8), p: [-0.018, 0.065, 0.6] }, { g: box(0.012, 0.012, 0.8), p: [0, 0.065, 0.6] }, { g: box(0.012, 0.012, 0.8), p: [0.018, 0.065, 0.6] },
    { g: tor(0.07, 0.01, Math.PI, 10, 4), p: [0, 0.07, 0.04], r: [-HP, 0, 0] },
  ]), m.glowA, guitar);
  add(mergeParts(own, [{ g: tor(0.17, 0.015, TAU, 6, 4), p: [0, -0.01, 0.02], r: [HP, 0, 0] }]), m.trim, guitar);
  const grimoire = new THREE.Group(); grimoire.name = 'weapon-grimoire';
  add(mergeParts(own, [
    { g: box(0.3, 0.035, 0.4), p: [-0.15, 0, 0.0], r: [0, 0, 0.45] }, { g: box(0.3, 0.035, 0.4), p: [0.15, 0, 0.0], r: [0, 0, -0.45] },
  ]), m.body, grimoire);
  add(mergeParts(own, [
    { g: box(0.26, 0.012, 0.36), p: [-0.14, 0.02, 0.0], r: [0, 0, 0.45] }, { g: box(0.26, 0.012, 0.36), p: [0.14, 0.02, 0.0], r: [0, 0, -0.45] },
  ]), white, grimoire);
  add(mergeParts(own, [{ g: tor(0.3, 0.012, TAU, 24, 4), p: [0, 0.35, 0], r: [0.3, 0, 0] }, { g: sph(0.05, 8, 6), p: [0, 0.18, 0] }]), m.glowA, grimoire);
  add(mergeParts(own, [{ g: tor(0.12, 0.012, TAU, 14, 4), p: [0, 0.02, 0], r: [HP, 0, 0] }]), silver, grimoire);
  weapons.mira = railgun; weapons.rin = guitar; weapons.sera = grimoire;
  for (const id of ['mira', 'rin', 'sera'] as const) mount.add(weapons[id]);

  const shield = new THREE.Mesh(own.geo(new THREE.SphereGeometry(1.3, 20, 14)), kit.additive('#8be9ff', 0.16, { side: THREE.DoubleSide }));
  shield.name = 'shield';
  shield.position.y = 1.2;
  shield.visible = false;
  group.add(shield);
  const aura = new THREE.Mesh(own.geo(flat(new THREE.RingGeometry(0.72, 0.9, 40))), m.aura);
  aura.name = 'hero-aura';
  aura.position.y = 0.035;
  group.add(aura);
  return { group, head, tails, cape, skirt, shield, aura, weapons, accessories, materials: m };
}

interface GhostRig { group: THREE.Group; appear: number; shown: boolean; phase: number }

function buildGhosts(kit: Kit, m: PaletteMaterials): GhostRig[] {
  const { own } = kit;
  const sheet = kit.toon('#eaf5ff', { emissive: new THREE.Color('#9ed6ff'), emissiveIntensity: 0.4 });
  const dark = kit.basic('#2a1240');
  const blush = kit.basic('#ff9ab8', { transparent: true, opacity: 0.8 });
  const bodyGeo = mergeParts(own, [
    { g: sph(0.3, 14, 10), p: [0, 0.32, 0], s: [1, 1.05, 1] },
    { g: cyl(0.29, 0.34, 0.34, 12), p: [0, 0.0, 0] },
    { g: sph(0.1, 8, 6), p: [-0.22, -0.2, 0.05] }, { g: sph(0.1, 8, 6), p: [0, -0.22, 0.1] }, { g: sph(0.1, 8, 6), p: [0.22, -0.2, 0.05] },
    { g: sph(0.07, 8, 6), p: [-0.33, 0.28, 0.04] }, { g: sph(0.07, 8, 6), p: [0.35, 0.42, 0.04] },
  ]);
  const faceGeo = mergeParts(own, [
    { g: sph(0.04, 8, 6), p: [-0.1, 0.38, 0.27], s: [0.8, 1.4, 0.5] }, { g: sph(0.04, 8, 6), p: [0.1, 0.38, 0.27], s: [0.8, 1.4, 0.5] },
    { g: tor(0.04, 0.008, Math.PI, 8, 4), p: [0, 0.3, 0.29], r: [0, 0, Math.PI] },
  ]);
  const blushGeo = mergeParts(own, [{ g: circ(0.045, 10), p: [-0.17, 0.3, 0.25], r: [0, -0.5, 0] }, { g: circ(0.045, 10), p: [0.17, 0.3, 0.25], r: [0, 0.5, 0] }]);
  const bandGeo = mergeParts(own, [{ g: tor(0.28, 0.018, Math.PI, 14, 4), p: [0, 0.4, 0], r: [0.3, 0, 0] }, { g: sph(0.05, 6, 5), p: [0, 0.68, 0.06] }]);
  const stickGeo = mergeParts(own, [{ g: cyl(0.012, 0.012, 0.32, 5), p: [0.36, 0.6, 0.04] }, { g: sph(0.05, 8, 6), p: [0.36, 0.78, 0.04] }]);
  const rigs: GhostRig[] = [];
  for (let i = 0; i < LIMITS.visibleGhosts; i++) {
    const g = new THREE.Group();
    g.name = `ghost-${i}`;
    g.add(new THREE.Mesh(bodyGeo, sheet), new THREE.Mesh(faceGeo, dark), new THREE.Mesh(blushGeo, blush));
    g.add(new THREE.Mesh(bandGeo, i % 2 ? m.glowA : m.glowB), new THREE.Mesh(stickGeo, i % 2 ? m.glowB : m.glowA));
    g.visible = false;
    rigs.push({ group: g, appear: 0, shown: false, phase: i * 1.37 });
  }
  return rigs;
}

// ---------------------------------------------------------------- enemies

interface View { root: THREE.Group; key: string; stamp: number }

interface HealthBar { group: THREE.Group; fill: THREE.Mesh }

interface EnemyView extends View {
  model: THREE.Group;
  bar: HealthBar;
  top: number;
  baseRadius: number;
  wings: THREE.Object3D[];
  wheels: THREE.Object3D[];
  spinners: THREE.Object3D[];
  bat: THREE.Group | null;
  teddy: THREE.Group | null;
  mods: { haste: THREE.Object3D; armored: THREE.Object3D; volatile: THREE.Object3D };
  ring: THREE.Mesh;
}

interface EnemyLib {
  build(key: string): EnemyView;
  setAccent(color: THREE.Color): void;
}

function createHealthBar(geometry: THREE.BufferGeometry, backGeometry: THREE.BufferGeometry, back: THREE.Material, fill: THREE.Material): HealthBar {
  const group = new THREE.Group();
  const bg = new THREE.Mesh(backGeometry, back);
  const f = new THREE.Mesh(geometry, fill);
  f.name = 'health-fill';
  f.position.z = 0.002;
  group.add(bg, f);
  group.rotation.x = -0.85;
  group.visible = false;
  return { group, fill: f };
}

function createEnemyLib(kit: Kit): EnemyLib {
  const { own } = kit;
  const HP = Math.PI / 2;
  const fur = kit.toon('#7b4ca8');
  const furLight = kit.toon('#e6b8ff');
  const stitch = kit.toon('#1a0e26');
  const crimsonGlow = kit.basic('#ff3358');
  const fang = kit.basic('#fff6ff');
  const bow = kit.toon('#72e9f3', { emissive: new THREE.Color('#72e9f3'), emissiveIntensity: 0.3 });
  const wingMat = kit.toon('#573086', { side: THREE.DoubleSide });
  const pink = kit.toon('#ff8fc2', { side: THREE.DoubleSide });
  const rose = kit.toon('#d46a94');
  const roseLight = kit.toon('#ffd1e3');
  const gold = kit.toon('#ffd36a', { emissive: new THREE.Color('#ffb83a'), emissiveIntensity: 0.35 });
  const coffinMat = kit.toon('#3a1e3f');
  const coffinTrim = kit.toon('#c9b3e8', { emissive: new THREE.Color('#8f78c0'), emissiveIntensity: 0.25 });
  const iron = kit.toon('#1b1228');
  const lampBlue = kit.basic('#9be8ff');
  const wraithCloak = kit.toon('#3f4d8c', { transparent: true, opacity: 0.88, emissive: new THREE.Color('#5b6cff'), emissiveIntensity: 0.35, side: THREE.DoubleSide });
  const wraithVoid = kit.toon('#0b0716');
  const hasteMat = kit.additive('#7ff0ff', 0.7);
  const armorMat = kit.toon('#e8edf8', { emissive: new THREE.Color('#aab6dd'), emissiveIntensity: 0.3 });
  const volatileGlow = kit.glow('#ff5a3a', 0.9);
  const threatRing = kit.additive('#ff2d55', 0.5, { side: THREE.DoubleSide });
  const ringGeo = own.geo(flat(new THREE.RingGeometry(0.78, 1, 28)));
  const barFill = kit.basic('#ff6b86');
  const barBack = kit.basic('#1a0e26', { transparent: true, opacity: 0.8 });
  const barFillGeo = own.geo(quad(1, 0.1).translate(0.5, 0, 0));
  const barBackGeo = own.geo(quad(1.06, 0.16).translate(0.5, 0, 0));

  const wingShape = (span: number, depth: number): THREE.BufferGeometry => {
    const s = new THREE.Shape();
    s.moveTo(0, 0.1);
    s.lineTo(span * 0.35, depth);
    s.quadraticCurveTo(span * 0.55, depth * 0.45, span * 0.68, depth * 0.78);
    s.quadraticCurveTo(span * 0.85, depth * 0.3, span, depth * 0.45);
    s.quadraticCurveTo(span * 0.82, -depth * 0.35, span * 0.6, -depth * 0.55);
    s.quadraticCurveTo(span * 0.3, -depth * 0.3, 0, -0.1);
    return own.geo(new THREE.ShapeGeometry(s, 6));
  };
  const mirrored = (g: THREE.BufferGeometry): THREE.BufferGeometry => own.geo(g.clone().scale(-1, 1, 1));

  const bat = (royal: boolean): { group: THREE.Group; wings: THREE.Object3D[] } => {
    const k = royal ? 1.7 : 1;
    const group = new THREE.Group();
    const wings: THREE.Object3D[] = [];
    const mesh = (g: THREE.BufferGeometry, mt: THREE.Material): THREE.Mesh => { const x = new THREE.Mesh(g, mt); group.add(x); return x; };
    const fm = royal ? kit.toon('#6a2f7e') : fur;
    mesh(mergeParts(own, [
      { g: sph(0.5 * k, 16, 12), p: [0, 0.85 * k, 0], s: [1, 1.08, 0.95] }, { g: sph(0.4 * k, 16, 12), p: [0, 1.42 * k, 0.12 * k] },
      { g: cone(0.16 * k, 0.52 * k, 8), p: [-0.25 * k, 1.84 * k, 0.05 * k], r: [0, 0, 0.3] }, { g: cone(0.16 * k, 0.52 * k, 8), p: [0.25 * k, 1.84 * k, 0.05 * k], r: [0, 0, -0.3] },
      { g: sph(0.12 * k, 8, 6), p: [-0.2 * k, 0.4 * k, 0.1 * k] }, { g: sph(0.12 * k, 8, 6), p: [0.2 * k, 0.4 * k, 0.1 * k] },
    ]), fm);
    mesh(mergeParts(own, [
      { g: cone(0.09 * k, 0.36 * k, 8), p: [-0.25 * k, 1.82 * k, 0.1 * k], r: [0, 0, 0.3] }, { g: cone(0.09 * k, 0.36 * k, 8), p: [0.25 * k, 1.82 * k, 0.1 * k], r: [0, 0, -0.3] },
      { g: sph(0.2 * k, 12, 8), p: [0, 1.32 * k, 0.4 * k], s: [1.1, 0.8, 0.6] },
    ]), furLight);
    mesh(mergeParts(own, [
      { g: heartShape(0.22 * k), p: [0, 0.78 * k, 0.5 * k] },
    ]), pink);
    mesh(mergeParts(own, [
      { g: tor(0.5 * k, 0.012, TAU, 28, 4), p: [0, 0.85 * k, 0], r: [HP, 0, 0] },
      { g: tor(0.17 * k, 0.012 * k, Math.PI, 12, 4), p: [0, 1.3 * k, 0.5 * k], r: [0, 0, Math.PI] },
      { g: box(0.13 * k, 0.018 * k, 0.012), p: [-0.16 * k, 1.62 * k, 0.45 * k], r: [0, 0, 0.5] }, { g: box(0.13 * k, 0.018 * k, 0.012), p: [0.16 * k, 1.62 * k, 0.45 * k], r: [0, 0, -0.5] },
    ]), stitch);
    mesh(mergeParts(own, [
      { g: cyl(0.075 * k, 0.075 * k, 0.03, 12), p: [-0.15 * k, 1.5 * k, 0.48 * k], r: [HP, 0, 0] }, { g: cyl(0.075 * k, 0.075 * k, 0.03, 12), p: [0.15 * k, 1.5 * k, 0.48 * k], r: [HP, 0, 0] },
    ]), crimsonGlow);
    mesh(mergeParts(own, [
      { g: cone(0.03 * k, 0.1 * k, 6), p: [-0.1 * k, 1.24 * k, 0.5 * k], r: [Math.PI, 0, 0] }, { g: cone(0.03 * k, 0.1 * k, 6), p: [0.1 * k, 1.24 * k, 0.5 * k], r: [Math.PI, 0, 0] },
    ]), fang);
    mesh(mergeParts(own, [
      { g: cone(0.1 * k, 0.22 * k, 6), p: [-0.1 * k, 1.04 * k, 0.4 * k], r: [0, 0, HP] }, { g: cone(0.1 * k, 0.22 * k, 6), p: [0.1 * k, 1.04 * k, 0.4 * k], r: [0, 0, -HP] }, { g: sph(0.06 * k, 8, 6), p: [0, 1.04 * k, 0.42 * k] },
    ]), bow);
    const wing = wingShape((royal ? 1.9 : 1.15), (royal ? 1.0 : 0.6));
    const wingL = mirrored(wing);
    const right = new THREE.Group(); right.position.set(0.4 * k, 1.0 * k, -0.05); right.add(new THREE.Mesh(wing, wingMat));
    const left = new THREE.Group(); left.position.set(-0.4 * k, 1.0 * k, -0.05); left.add(new THREE.Mesh(wingL, wingMat));
    group.add(right, left);
    wings.push(right, left);
    if (royal) {
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * TAU;
        mesh(mergeParts(own, [{ g: cone(0.07, 0.3, 6), p: [Math.cos(a) * 0.28, 2.18 * k * 0.97, Math.sin(a) * 0.28] }, { g: sph(0.05, 6, 5), p: [Math.cos(a) * 0.28, 2.38 * k * 0.97, Math.sin(a) * 0.28] }]), gold);
      }
      mesh(mergeParts(own, [{ g: tor(0.28, 0.06, TAU, 18, 6), p: [0, 2.13 * k * 0.97, 0], r: [HP, 0, 0] }]), gold);
      mesh(own.geo(new THREE.CylinderGeometry(0.62 * k, 0.95 * k, 1.5 * k, 14, 1, true, Math.PI - 1.0, 2.0).translate(0, 0.95 * k, -0.2)), kit.toon('#b81c4a', { side: THREE.DoubleSide }));
      mesh(mergeParts(own, [{ g: tor(0.54 * k, 0.07, 2.0, 12, 5), p: [0, 1.5 * k, -0.1], r: [-0.3, 0, Math.PI / 2 + 0.5 + 1.0] }]), furLight);
    }
    return { group, wings };
  };

  const teddy = (): THREE.Group => {
    const group = new THREE.Group();
    const mesh = (g: THREE.BufferGeometry, mt: THREE.Material): void => { group.add(new THREE.Mesh(g, mt)); };
    mesh(mergeParts(own, [
      { g: sph(0.5, 16, 12), p: [0, 0.72, 0], s: [1, 1.05, 0.9] }, { g: sph(0.4, 16, 12), p: [0, 1.32, 0.05] },
      { g: sph(0.15, 10, 8), p: [-0.3, 1.64, 0.02] }, { g: sph(0.15, 10, 8), p: [0.3, 1.64, 0.02] },
      { g: sph(0.14, 10, 8), p: [-0.58, 0.95, 0.12] }, { g: sph(0.14, 10, 8), p: [0.58, 0.95, 0.12] },
      { g: sph(0.16, 10, 8), p: [-0.26, 0.2, 0.15] }, { g: sph(0.16, 10, 8), p: [0.26, 0.2, 0.15] },
    ]), rose);
    mesh(mergeParts(own, [
      { g: sph(0.15, 10, 8), p: [0, 1.22, 0.4], s: [1.1, 0.85, 0.7] }, { g: sph(0.08, 8, 6), p: [-0.3, 1.64, 0.1] }, { g: sph(0.08, 8, 6), p: [0.3, 1.64, 0.1] },
      { g: sph(0.26, 10, 8), p: [0, 0.7, 0.4], s: [1, 1.1, 0.4] },
    ]), roseLight);
    mesh(mergeParts(own, [
      { g: sph(0.045, 6, 5), p: [0, 1.28, 0.5], s: [1.2, 0.8, 0.8] },
      { g: box(0.4, 0.03, 0.012), p: [0, 0.72, 0.52], r: [0, 0, 0.7] }, { g: box(0.4, 0.03, 0.012), p: [0, 0.72, 0.52], r: [0, 0, -0.7] },
      { g: tor(0.14, 0.012, Math.PI, 10, 4), p: [0, 1.16, 0.48], r: [0, 0, Math.PI] }, { g: tor(0.52, 0.012, TAU, 26, 4), p: [0, 0.72, 0], r: [HP, 0, 0] },
    ]), stitch);
    mesh(mergeParts(own, [
      { g: cyl(0.07, 0.07, 0.03, 12), p: [-0.14, 1.4, 0.4], r: [HP, 0, 0] }, { g: cyl(0.07, 0.07, 0.03, 12), p: [0.14, 1.4, 0.4], r: [HP, 0, 0] },
    ]), crimsonGlow);
    mesh(mergeParts(own, [
      { g: cone(0.1, 0.2, 6), p: [-0.1, 1.0, 0.4], r: [0, 0, HP] }, { g: cone(0.1, 0.2, 6), p: [0.1, 1.0, 0.4], r: [0, 0, -HP] }, { g: sph(0.06, 8, 6), p: [0, 1.0, 0.42] },
    ]), bow);
    return group;
  };

  const wraith = (): { group: THREE.Group; spinners: THREE.Object3D[] } => {
    const group = new THREE.Group();
    const spinners: THREE.Object3D[] = [];
    group.add(new THREE.Mesh(mergeParts(own, [
      { g: new THREE.ConeGeometry(0.55, 1.45, 14, 1, true), p: [0, 0.95, 0], r: [Math.PI, 0, 0] },
      { g: sph(0.3, 12, 10), p: [0, 1.75, 0], s: [1, 1.1, 1] }, { g: cone(0.32, 0.5, 10), p: [0, 2.0, -0.08], r: [-0.25, 0, 0] },
      { g: cone(0.06, 0.55, 6), p: [-0.46, 1.15, 0.38], r: [HP + 0.25, 0, 0.2] }, { g: cone(0.06, 0.55, 6), p: [0.46, 1.15, 0.38], r: [HP + 0.25, 0, -0.2] },
    ]), wraithCloak));
    group.add(new THREE.Mesh(mergeParts(own, [{ g: sph(0.22, 10, 8), p: [0, 1.72, 0.14], s: [1, 1.1, 0.8] }]), wraithVoid));
    group.add(new THREE.Mesh(mergeParts(own, [
      { g: sph(0.05, 6, 5), p: [-0.09, 1.74, 0.29], s: [1, 1.5, 0.6] }, { g: sph(0.05, 6, 5), p: [0.09, 1.74, 0.29], s: [1, 1.5, 0.6] },
    ]), crimsonGlow));
    const wisps = new THREE.Group();
    wisps.add(new THREE.Mesh(mergeParts(own, [
      { g: cone(0.1, 0.55, 6), p: [-0.3, 0.25, 0.1], r: [Math.PI, 0, 0.2] }, { g: cone(0.12, 0.7, 6), p: [0, 0.2, 0.15], r: [Math.PI, 0, 0] },
      { g: cone(0.1, 0.5, 6), p: [0.3, 0.27, 0.1], r: [Math.PI, 0, -0.2] }, { g: cone(0.08, 0.45, 6), p: [-0.12, 0.2, -0.25], r: [Math.PI, 0, 0.1] },
    ]), wraithCloak));
    group.add(wisps);
    spinners.push(wisps);
    return { group, spinners };
  };

  const carriage = (grand: boolean): { group: THREE.Group; wheels: THREE.Object3D[] } => {
    const k = grand ? 1.5 : 1;
    const group = new THREE.Group();
    const wheels: THREE.Object3D[] = [];
    const shape = new THREE.Shape();
    shape.moveTo(-0.26, -1.0); shape.lineTo(0.26, -1.0); shape.lineTo(0.55, -0.45); shape.lineTo(0.4, 0.95); shape.lineTo(-0.4, 0.95); shape.lineTo(-0.55, -0.45);
    const coffinGeo = new THREE.ExtrudeGeometry(shape, { depth: 0.55, bevelEnabled: true, bevelSize: 0.05, bevelThickness: 0.05, bevelSegments: 1 });
    coffinGeo.rotateX(-HP);
    // after rotateX(-90deg): shape y -> world -z. Wide shoulders trail; narrow foot leads, so flip to lead with the wide end.
    coffinGeo.rotateY(Math.PI);
    const lid = new THREE.ExtrudeGeometry(shape, { depth: 0.12, bevelEnabled: false });
    lid.rotateX(-HP); lid.rotateY(Math.PI);
    group.add(new THREE.Mesh(mergeParts(own, [
      { g: coffinGeo, p: [0, 0.5 * k, 0], s: [k, k, k] }, { g: box(0.9 * k, 0.12, 2.1 * k), p: [0, 0.38, 0] },
    ]), coffinMat));
    group.add(new THREE.Mesh(mergeParts(own, [
      { g: lid, p: [0, 1.12 * k, 0], s: [0.78 * k, 1, 0.84 * k] },
      { g: tor(0.1 * k, 0.025, 4.4, 10, 5), p: [0, 1.18 * k, 0.1], r: [HP, 0, 0] },
      { g: tor(0.12, 0.02, Math.PI, 8, 4), p: [-0.6 * k, 0.8 * k, 0.2], r: [0, HP, 0] }, { g: tor(0.12, 0.02, Math.PI, 8, 4), p: [0.6 * k, 0.8 * k, 0.2], r: [0, HP, 0] },
      { g: box(1.2 * k, 0.05, 0.05), p: [0, 0.34, 0.95 * k] },
    ]), coffinTrim));
    const lampParts: Part[] = [];
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) lampParts.push({ g: sph(0.1, 8, 6), p: [sx * 0.55 * k, 1.4 * k, sz * 0.8 * k] });
    group.add(new THREE.Mesh(mergeParts(own, lampParts), lampBlue));
    const posts: Part[] = [];
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) posts.push({ g: cyl(0.03, 0.03, 0.5 * k, 6), p: [sx * 0.55 * k, 1.15 * k, sz * 0.8 * k] });
    group.add(new THREE.Mesh(mergeParts(own, posts), iron));
    group.add(new THREE.Mesh(mergeParts(own, [
      { g: sph(0.09, 8, 6), p: [-0.25 * k, 0.62, 1.05 * k] }, { g: sph(0.09, 8, 6), p: [0.25 * k, 0.62, 1.05 * k] },
    ]), crimsonGlow));
    const axles = grand ? [-1.1, 0, 1.1] : [-0.7, 0.7];
    const wheelGeo = mergeParts(own, [
      { g: cyl(0.34, 0.34, 0.1, 16), r: [0, 0, HP] }, { g: cyl(0.4, 0.4, 0.04, 16), r: [0, 0, HP] },
      { g: box(0.12, 0.62, 0.05), r: [0, 0, 0] }, { g: box(0.12, 0.05, 0.62) },
      { g: box(0.12, 0.62, 0.05), r: [0.78, 0, 0] }, { g: box(0.12, 0.62, 0.05), r: [-0.78, 0, 0] },
    ]);
    for (const z of axles) for (const sx of [-1, 1]) {
      const w = new THREE.Mesh(wheelGeo, iron);
      w.position.set(sx * 0.72 * k, 0.36, z * k);
      group.add(w);
      wheels.push(w);
    }
    if (grand) {
      // Gilded cathedral spires, drapes and a funeral wreath.
      group.add(new THREE.Mesh(mergeParts(own, [
        { g: cone(0.22, 1.1, 6), p: [0, 2.0, 0.6] }, { g: cone(0.16, 0.8, 6), p: [-0.6, 1.9, -0.5] }, { g: cone(0.16, 0.8, 6), p: [0.6, 1.9, -0.5] },
        { g: cone(0.1, 0.5, 6), p: [0, 2.0, -0.9] }, { g: tor(0.7, 0.07, TAU, 20, 6), p: [0, 1.0, 1.55], r: [0, 0, 0] },
      ]), gold));
      group.add(new THREE.Mesh(mergeParts(own, [
        { g: box(0.08, 0.5, 2.2), p: [-0.78, 1.3, 0] }, { g: box(0.08, 0.5, 2.2), p: [0.78, 1.3, 0] },
      ]), kit.toon('#b81c4a', { side: THREE.DoubleSide })));
      group.add(new THREE.Mesh(mergeParts(own, [
        { g: sph(0.11, 6, 5), p: [-0.45, 1.02, 1.6] }, { g: sph(0.11, 6, 5), p: [0.45, 1.02, 1.6] }, { g: sph(0.11, 6, 5), p: [0, 1.65, 1.58] }, { g: sph(0.11, 6, 5), p: [0, 0.4, 1.55] },
      ]), kit.toon('#ff8fc2', { emissive: new THREE.Color('#ff8fc2'), emissiveIntensity: 0.3 })));
    }
    return { group, wheels };
  };

  const saint = (): { group: THREE.Group; wings: THREE.Object3D[]; spinners: THREE.Object3D[] } => {
    const group = new THREE.Group();
    const wings: THREE.Object3D[] = [];
    const spinners: THREE.Object3D[] = [];
    const jewels = ['#ff4d8d', '#7a5cff', '#2de2e6', '#ffd24d', '#ff7a45', '#9d5cff', '#4dff9a'];
    const leadMat = kit.toon('#2b2742');
    const glass = kit.basic(0xffffff, { vertexColors: true, side: THREE.DoubleSide });
    group.add(new THREE.Mesh(mergeParts(own, [
      { g: cone(0.9, 3.2, 12), p: [0, 1.6, 0], r: [Math.PI, 0, 0] }, { g: sph(0.38, 14, 10), p: [0, 3.5, 0] },
      { g: cyl(0.08, 0.08, 1.4, 6), p: [-0.8, 2.2, 0.35], r: [0.6, 0, 0.35] }, { g: cyl(0.08, 0.08, 1.4, 6), p: [0.8, 2.2, 0.35], r: [0.6, 0, -0.35] },
    ]), leadMat));
    const panes: Part[] = [];
    for (let row = 0; row < 7; row++) {
      const y = 0.45 + row * 0.42;
      const half = 0.86 * (1 - (y / 3.3)) + 0.12;
      const cols = Math.max(1, Math.round(half * 4));
      for (let c = 0; c < cols; c++) {
        const x = (c - (cols - 1) / 2) * (half * 2 / cols);
        panes.push({ g: quad((half * 2 / cols) * 0.86, 0.34), p: [x, y, Math.sqrt(Math.max(0.0, 0.81 * (1 - y / 3.4) * (1 - y / 3.4) - x * x)) + 0.02], c: jewels[(row * 3 + c) % jewels.length] });
      }
    }
    group.add(new THREE.Mesh(mergeParts(own, panes, true), glass));
    group.add(new THREE.Mesh(mergeParts(own, [
      { g: sph(0.34, 14, 10), p: [0, 3.5, 0.05], s: [0.95, 1.05, 0.9] },
    ]), kit.toon('#f1ecff', { emissive: new THREE.Color('#c8bdff'), emissiveIntensity: 0.35 })));
    group.add(new THREE.Mesh(mergeParts(own, [
      { g: sph(0.09, 8, 6), p: [0, 3.52, 0.34], s: [1.5, 1, 0.5] }, { g: box(0.3, 0.025, 0.02), p: [0, 3.34, 0.32], r: [0, 0, 0.1] },
    ]), crimsonGlow));
    const halo = new THREE.Group();
    halo.position.set(0, 4.15, 0);
    const haloParts: Part[] = [{ g: tor(0.9, 0.06, TAU, 30, 6), c: '#ffd36a' }];
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * TAU;
      haloParts.push({ g: cyl(0.04, 0.18, 0.3, 8), p: [Math.cos(a) * 0.98, Math.sin(a) * 0.98, 0], r: [0, 0, a - HP], c: '#ffffff' });
    }
    halo.add(new THREE.Mesh(mergeParts(own, haloParts, true), kit.basic(0xffffff, { vertexColors: true })));
    group.add(halo);
    spinners.push(halo);
    const shard = (len: number, c: string): Part => ({ g: new THREE.ConeGeometry(0.2, len, 4), p: [0, len / 2, 0], c });
    for (const s of [-1, 1]) {
      const wing = new THREE.Group();
      wing.position.set(s * 0.35, 3.0, -0.15);
      const parts: Part[] = [];
      for (let i = 0; i < 7; i++) {
        const a = 0.35 + i * 0.32;
        const len = 2.6 - i * 0.18;
        parts.push({ ...shard(len, jewels[i % jewels.length]), r: [0, 0, -s * a], s: [1.3, 1, 0.25] });
      }
      wing.add(new THREE.Mesh(mergeParts(own, parts, true), glass));
      group.add(wing);
      wings.push(wing);
    }
    return { group, wings, spinners };
  };

  const modifierMarkers = (): { haste: THREE.Object3D; armored: THREE.Object3D; volatile: THREE.Object3D } => {
    const haste = new THREE.Mesh(mergeParts(own, [
      { g: box(0.08, 0.04, 0.9), p: [-0.3, 0.8, -0.9] }, { g: box(0.08, 0.04, 0.9), p: [0.3, 0.8, -0.9] }, { g: box(0.08, 0.04, 1.2), p: [0, 1.1, -1.0] },
    ]), hasteMat);
    const armored = new THREE.Mesh(mergeParts(own, [
      { g: tor(0.62, 0.07, TAU, 20, 6), p: [0, 0.95, 0], r: [HP, 0, 0] }, { g: sph(0.15, 8, 6), p: [-0.55, 1.25, 0.1], s: [1, 0.6, 1] }, { g: sph(0.15, 8, 6), p: [0.55, 1.25, 0.1], s: [1, 0.6, 1] },
    ]), armorMat);
    const volatile = new THREE.Sprite(volatileGlow);
    volatile.scale.set(2.4, 2.4, 1);
    volatile.position.y = 1.0;
    return { haste, armored, volatile };
  };

  return {
    setAccent: color => { bow.color.copy(color); bow.emissive.copy(color); },
    build(key) {
      const root = new THREE.Group();
      const model = new THREE.Group();
      root.add(model);
      let wings: THREE.Object3D[] = [];
      let wheels: THREE.Object3D[] = [];
      let spinners: THREE.Object3D[] = [];
      let batGroup: THREE.Group | null = null;
      let teddyGroup: THREE.Group | null = null;
      let top = 2.2;
      let baseRadius = 0.55;
      if (key === 'plush') {
        const b = bat(false);
        batGroup = b.group; wings = b.wings; teddyGroup = teddy();
        model.add(batGroup, teddyGroup);
        top = 2.1;
      } else if (key === 'wraith') {
        const w = wraith();
        model.add(w.group); spinners = w.spinners; top = 2.4; baseRadius = 0.5;
      } else if (key === 'carriage') {
        const c = carriage(false);
        model.add(c.group); wheels = c.wheels; top = 1.5; baseRadius = 0.75;
      } else if (key === 'boss-0') {
        const b = bat(true);
        b.group.scale.setScalar(1.15);
        model.add(b.group); wings = b.wings; top = 4.6; baseRadius = 1.15;
      } else if (key === 'boss-1') {
        const c = carriage(true);
        model.add(c.group); wheels = c.wheels; top = 3.2; baseRadius = 1.3;
      } else {
        const s = saint();
        model.add(s.group); wings = s.wings; spinners = s.spinners; top = 5.4; baseRadius = 0.9;
      }
      const ring = new THREE.Mesh(ringGeo, threatRing);
      ring.position.y = 0.04;
      root.add(ring);
      const mods = modifierMarkers();
      model.add(mods.haste, mods.armored, mods.volatile);
      const bar = createHealthBar(barFillGeo, barBackGeo, barBack, barFill);
      root.add(bar.group);
      root.visible = false;
      return { root, key, stamp: 0, model, bar, top, baseRadius, wings, wheels, spinners, bat: batGroup, teddy: teddyGroup, mods, ring };
    },
  };
}

// ---------------------------------------------------------------- track objects and telegraphs

interface ObjectView extends View {
  model: THREE.Group;
  pillars: THREE.Object3D[];
  arch: THREE.Object3D | null;
  portal: THREE.Object3D | null;
  veil: THREE.Object3D | null;
  sill: THREE.Object3D | null;
  flame: THREE.Sprite | null;
  bar: HealthBar;
  lastHealth: number;
  wobble: number;
}

interface ObjectLib {
  build(key: string): ObjectView;
  animate(clock: number, reduced: boolean): void;
}

function createObjectLib(kit: Kit): ObjectLib {
  const { own } = kit;
  const HP = Math.PI / 2;
  const stone = kit.toon('#2d2250');
  const silver = kit.toon('#d3dbf0', { emissive: new THREE.Color('#a8b6dc'), emissiveIntensity: 0.25 });
  const barFill = kit.basic('#9be8ff');
  const barBack = kit.basic('#1a0e26', { transparent: true, opacity: 0.8 });
  const barFillGeo = own.geo(quad(1, 0.1).translate(0.5, 0, 0));
  const barBackGeo = own.geo(quad(1.06, 0.16).translate(0.5, 0, 0));
  const pillarGeo = mergeParts(own, [
    { g: cyl(0.16, 0.22, 2.4, 10), p: [0, 1.2, 0] }, { g: box(0.62, 0.26, 0.62), p: [0, 0.13, 0] }, { g: cone(0.22, 0.55, 8), p: [0, 2.65, 0] },
    { g: tor(0.2, 0.03, TAU, 14, 5), p: [0, 2.35, 0], r: [HP, 0, 0] }, { g: tor(0.2, 0.03, TAU, 14, 5), p: [0, 0.5, 0], r: [HP, 0, 0] },
  ]);
  const archGeo = own.geo(tor(1, 0.08, Math.PI, 28, 6));
  const archInner = own.geo(tor(0.86, 0.035, Math.PI, 28, 4));
  const portalGeo = own.geo(new THREE.CircleGeometry(1, 32, 0, Math.PI));
  const veilGeo = own.geo(quad(1, 1).translate(0, 0.5, 0));
  const sillGeo = own.geo(flat(new THREE.PlaneGeometry(1, 0.22)));
  const mats = {
    good: { rim: kit.basic('#9ff7ff'), portal: kit.additive('#4fe6ff', 0.24, { side: THREE.DoubleSide }), veil: kit.additive('#4fe6ff', 0.14, { side: THREE.DoubleSide }), sill: kit.additive('#9ff7ff', 0.7, { side: THREE.DoubleSide }) },
    bad: { rim: kit.basic('#ff7088'), portal: kit.additive('#ff2d55', 0.24, { side: THREE.DoubleSide }), veil: kit.additive('#ff2d55', 0.14, { side: THREE.DoubleSide }), sill: kit.additive('#ff7088', 0.7, { side: THREE.DoubleSide }) },
  };
  const cabinet = kit.toon('#2a1b3d');
  const runes = kit.basic('#ff3b6b');
  const cap = kit.basic('#c79bff');
  const flameMat = kit.glow('#b078ff', 0.9);
  const cabinetGeo = mergeParts(own, [
    { g: box(0.9, 1.0, 0.7), p: [0, 0.55, 0] }, { g: box(0.2, 0.08, 0.2), p: [-0.35, 0.04, 0.2] }, { g: box(0.2, 0.08, 0.2), p: [0.35, 0.04, 0.2] },
    { g: cyl(0.26, 0.09, 0.12, 14), p: [0, 0.45, 0.33], r: [HP, 0, 0] }, { g: cyl(0.11, 0.05, 0.08, 10), p: [0.22, 0.88, 0.34], r: [HP, 0, 0] },
  ]);
  const trimGeo = mergeParts(own, [
    { g: tor(0.3, 0.04, TAU, 18, 6), p: [0, 0.45, 0.36] }, { g: tor(0.12, 0.02, TAU, 12, 5), p: [0.22, 0.88, 0.36] },
    { g: box(0.08, 0.08, 0.08), p: [-0.45, 1.05, 0.35] }, { g: box(0.08, 0.08, 0.08), p: [0.45, 1.05, 0.35] }, { g: box(0.08, 0.08, 0.08), p: [-0.45, 0.05, 0.35] }, { g: box(0.08, 0.08, 0.08), p: [0.45, 0.05, 0.35] },
    { g: tor(0.18, 0.025, Math.PI, 10, 4), p: [0, 1.1, 0], r: [0, 0, 0] },
  ]);
  const runeGeo = mergeParts(own, [
    { g: box(0.56, 0.035, 0.02), p: [0, 0.98, 0.355] }, { g: box(0.035, 0.18, 0.02), p: [-0.38, 0.55, 0.355] }, { g: box(0.035, 0.18, 0.02), p: [0.38, 0.55, 0.355] },
    { g: box(0.2, 0.025, 0.02), p: [-0.15, 0.17, 0.355], r: [0, 0, 0.5] }, { g: box(0.2, 0.025, 0.02), p: [0.15, 0.17, 0.355], r: [0, 0, -0.5] },
  ]);
  const capGeo = mergeParts(own, [{ g: sph(0.07, 8, 6), p: [0, 0.45, 0.4] }, { g: sph(0.04, 8, 6), p: [0.22, 0.88, 0.4] }]);

  return {
    build(key) {
      const root = new THREE.Group();
      const model = new THREE.Group();
      root.add(model);
      const bar = createHealthBar(barFillGeo, barBackGeo, barBack, barFill);
      bar.group.position.y = key === 'crate' ? 1.7 : 3.8;
      root.add(bar.group);
      const view: ObjectView = { root, key, stamp: 0, model, pillars: [], arch: null, portal: null, veil: null, sill: null, flame: null, bar, lastHealth: Infinity, wobble: 0 };
      if (key === 'crate') {
        model.add(new THREE.Mesh(cabinetGeo, cabinet), new THREE.Mesh(trimGeo, silver), new THREE.Mesh(runeGeo, runes), new THREE.Mesh(capGeo, cap));
        const flame = new THREE.Sprite(flameMat);
        flame.scale.set(1.5, 1.5, 1);
        flame.position.set(0, 1.3, 0);
        model.add(flame);
        view.flame = flame;
      } else {
        const set = key === 'gate-bad' ? mats.bad : mats.good;
        for (let i = 0; i < 2; i++) { const p = new THREE.Mesh(pillarGeo, stone); model.add(p); view.pillars.push(p); }
        const arch = new THREE.Group();
        arch.add(new THREE.Mesh(archGeo, set.rim), new THREE.Mesh(archInner, set.rim));
        arch.position.y = 2.3;
        const portal = new THREE.Mesh(portalGeo, set.portal);
        portal.position.y = 2.3;
        const veil = new THREE.Mesh(veilGeo, set.veil);
        const sill = new THREE.Mesh(sillGeo, set.sill);
        sill.position.y = 0.04;
        model.add(arch, portal, veil, sill);
        view.arch = arch; view.portal = portal; view.veil = veil; view.sill = sill;
      }
      root.visible = false;
      return view;
    },
    animate(clock, reduced) {
      const pulse = reduced ? 0 : Math.sin(clock * 3);
      mats.good.portal.opacity = 0.24 + 0.06 * pulse; mats.bad.portal.opacity = 0.24 + 0.06 * pulse;
      mats.good.sill.opacity = 0.7 + 0.2 * pulse; mats.bad.sill.opacity = 0.7 + 0.2 * pulse;
      flameMat.opacity = reduced ? 0.9 : 0.78 + 0.16 * Math.sin(clock * 9);
    },
  };
}

interface TelegraphView extends View {
  fill: THREE.Mesh;
  progress: THREE.Mesh;
  edges: THREE.Mesh[];
  blast: THREE.Mesh;
}

function createTelegraphLib(kit: Kit): { build(key: string): TelegraphView; edge: THREE.MeshBasicMaterial } {
  const { own } = kit;
  const fillGeo = own.geo(flat(new THREE.PlaneGeometry(1, 1)));
  const progressGeo = own.geo(flat(new THREE.PlaneGeometry(1, 1)).translate(0, 0, 0.5));
  const diamond = own.geo(flat(new THREE.PlaneGeometry(1, 1)).rotateY(Math.PI / 4));
  const layer = (color: string, opacity: number, offset: number): THREE.MeshBasicMaterial => kit.basic(color, {
    transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -offset, polygonOffsetUnits: -offset,
  });
  const fillMat = layer('#ff2d55', 0.18, 1);
  const progressMat = layer('#ff4b6b', 0.34, 2);
  const edgeMat = layer('#ff7a92', 0.95, 3);
  const blastMat = layer('#ffb0c0', 0.4, 4);
  return {
    edge: edgeMat,
    build(key) {
      const root = new THREE.Group();
      const fill = new THREE.Mesh(fillGeo, fillMat); fill.name = 'telegraph-fill';
      const progress = new THREE.Mesh(progressGeo, progressMat); progress.name = 'telegraph-progress'; progress.position.y = 0.004;
      const edges = [0, 1, 2, 3].map(() => { const e = new THREE.Mesh(fillGeo, edgeMat); e.name = 'telegraph-edge'; e.position.y = 0.008; return e; });
      const blast = new THREE.Mesh(diamond, blastMat); blast.name = 'telegraph-blast'; blast.position.y = 0.012;
      for (const m of [fill, progress, blast, ...edges]) m.renderOrder = 2;
      root.add(fill, progress, ...edges, blast);
      root.visible = false;
      return { root, key, stamp: 0, fill, progress, edges, blast };
    },
  };
}

// ---------------------------------------------------------------- world

interface Pool<V extends View> {
  live: Map<number, V>;
  free: Map<string, V[]>;
  acquire(id: number, key: string): V;
  sweep(stamp: number): void;
}

function createPool<V extends View>(build: (key: string) => V, parent: THREE.Object3D): Pool<V> {
  const live = new Map<number, V>();
  const free = new Map<string, V[]>();
  return {
    live, free,
    acquire(id, key) {
      let v = live.get(id);
      if (v) return v;
      const list = free.get(key);
      v = list?.pop() ?? build(key);
      if (v.root.parent !== parent) parent.add(v.root);
      v.root.visible = true;
      live.set(id, v);
      return v;
    },
    sweep(stamp) {
      for (const [id, v] of live) {
        if (v.stamp === stamp) continue;
        v.root.visible = false;
        live.delete(id);
        const list = free.get(v.key);
        if (list) list.push(v); else free.set(v.key, [v]);
      }
    },
  };
}

function reconcile<T extends { id: number }, V extends View>(pool: Pool<V>, items: readonly T[], limit: number, frame: number, keyOf: (item: T) => string, apply: (view: V, item: T) => void): number {
  const n = Math.min(items.length, limit);
  for (let i = 0; i < n; i++) {
    const v = pool.live.get(items[i].id);
    if (v && v.key === keyOf(items[i])) v.stamp = frame;
  }
  pool.sweep(frame);
  for (let i = 0; i < n; i++) {
    const v = pool.acquire(items[i].id, keyOf(items[i]));
    v.stamp = frame;
    apply(v, items[i]);
  }
  return n;
}

function assertSkin(hero: HeroId, skin: SkinId): Readonly<Palette> {
  const definition = getSkin(skin);
  if (definition.hero !== hero) throw new RangeError(`Outfit ${skin} does not belong to ${hero}.`);
  return definition.palette;
}

export const createWorld: CreateWorld = (scene, options) => {
  const initial = assertSkin(options.hero, options.skin);
  const reduced = options.reducedMotion;
  const own = createOwned();
  const kit = createKit(own);
  const root = new THREE.Group();
  root.name = 'gravewave-world';
  const counts: WorldCounts = { enemies: 0, pooledEnemies: 0, projectiles: 0, objects: 0, telegraphs: 0, ghosts: 0, particles: 0, rings: 0 };

  const env = buildEnvironment(kit, scene, reduced);
  root.add(env.group);


  const hero = buildHero(kit, initial);
  const heroGroup = hero.group;
  root.add(heroGroup);
  const ghosts = buildGhosts(kit, hero.materials);
  const ghostsGroup = new THREE.Group();
  ghostsGroup.name = 'ghosts';
  for (const g of ghosts) ghostsGroup.add(g.group);
  root.add(ghostsGroup);

  const enemiesGroup = new THREE.Group(); enemiesGroup.name = 'enemies';
  const objectsGroup = new THREE.Group(); objectsGroup.name = 'objects';
  const telegraphsGroup = new THREE.Group(); telegraphsGroup.name = 'telegraphs';
  const effectsGroup = new THREE.Group(); effectsGroup.name = 'effects';
  root.add(telegraphsGroup, objectsGroup, enemiesGroup, effectsGroup);

  const enemyLib = createEnemyLib(kit);
  const objectLib = createObjectLib(kit);
  const telegraphLib = createTelegraphLib(kit);
  const enemyPool = createPool<EnemyView>(key => enemyLib.build(key), enemiesGroup);
  const objectPool = createPool<ObjectView>(key => objectLib.build(key), objectsGroup);
  const telegraphPool = createPool<TelegraphView>(key => telegraphLib.build(key), telegraphsGroup);

  // Instanced projectiles.
  const dummy = new THREE.Object3D();
  const makeInstanced = (g: THREE.BufferGeometry, m: THREE.Material, count: number, name: string): THREE.InstancedMesh => {
    const mesh = own.inst(new THREE.InstancedMesh(g, m, count));
    mesh.name = name;
    mesh.frustumCulled = false;
    mesh.count = 0;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.setColorAt(0, new THREE.Color(0xffffff));
    effectsGroup.add(mesh);
    return mesh;
  };
  const boltGeo = own.geo(new THREE.CapsuleGeometry(0.1, 0.5, 4, 8).rotateX(Math.PI / 2));
  const orbGeo = own.geo(new THREE.IcosahedronGeometry(0.3, 0));
  const playerCore = makeInstanced(boltGeo, kit.basic(0xffffff), LIMITS.projectiles, 'projectiles-player');
  const playerHalo = makeInstanced(boltGeo, kit.additive(0xffffff, 0.4), LIMITS.projectiles, 'projectile-halo-player');
  const enemyCore = makeInstanced(orbGeo, kit.basic(0xffffff), LIMITS.projectiles, 'projectiles-enemy');
  const enemyHalo = makeInstanced(own.geo(new THREE.SphereGeometry(0.55, 10, 8)), kit.additive(0xffffff, 0.3), LIMITS.projectiles, 'projectile-halo-enemy');

  // Particles and rings.
  const P = LIMITS.particles;
  const particleMesh = makeInstanced(own.geo(new THREE.OctahedronGeometry(1, 0)), kit.additive(0xffffff, 1), P, 'particles');
  const pPos = new Float32Array(P * 3); const pVel = new Float32Array(P * 3); const pCol = new Float32Array(P * 3);
  const pLife = new Float32Array(P); const pMax = new Float32Array(P); const pSize = new Float32Array(P); const pGrav = new Float32Array(P);
  let particleCount = 0;
  const rings: { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; age: number; life: number; r0: number; r1: number; active: boolean }[] = [];
  const ringGeo = own.geo(flat(new THREE.RingGeometry(0.9, 1, 48)));
  for (let i = 0; i < RING_POOL; i++) {
    const mat = kit.additive(0xffffff, 0.9, { side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(ringGeo, mat);
    mesh.visible = false; mesh.position.y = 0.06; mesh.renderOrder = 3;
    effectsGroup.add(mesh);
    rings.push({ mesh, mat, age: 0, life: 1, r0: 1, r1: 2, active: false });
  }

  // State.
  let palette: Readonly<Palette> = initial;
  let heroId: HeroId = options.hero;
  let clock = 0;
  let frame = 0;
  let runId: string | null = null;
  let lastEventId = 0;
  let sectorIndex = -1;
  let shake = 0;
  let prevX = 0;
  let lean = 0;
  let disposed = false;
  const tmpColor = new THREE.Color();
  const tmpColor2 = new THREE.Color();

  const showHeroParts = (): void => {
    for (const id of ['mira', 'rin', 'sera'] as const) {
      hero.weapons[id].visible = id === heroId;
      hero.accessories[id].visible = id === heroId;
    }
  };
  applyPalette(hero.materials, palette);
  showHeroParts();
  env.applySector(SECTORS[0], 0);
  sectorIndex = 0;
  enemyLib.setAccent(new THREE.Color(SECTORS[0].accent));

  const spawnParticle = (x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, size: number, color: THREE.Color, gravity = 0): void => {
    if (particleCount >= P) return;
    const i = particleCount++;
    pPos[i * 3] = x; pPos[i * 3 + 1] = y; pPos[i * 3 + 2] = z;
    const v = reduced ? 0.3 : 1;
    pVel[i * 3] = vx * v; pVel[i * 3 + 1] = vy * v; pVel[i * 3 + 2] = vz * v;
    pCol[i * 3] = color.r; pCol[i * 3 + 1] = color.g; pCol[i * 3 + 2] = color.b;
    pLife[i] = life; pMax[i] = life; pSize[i] = size; pGrav[i] = gravity;
  };
  const burst = (x: number, y: number, z: number, count: number, speed: number, life: number, size: number, colors: readonly THREE.Color[], gravity = 0, lift = 0): void => {
    const n = reduced ? Math.ceil(count / 2) : count;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU + i * 0.7;
      const s = speed * (0.6 + 0.4 * ((i * 37) % 10) / 10);
      spawnParticle(x, y, z, Math.cos(a) * s, lift + (((i * 13) % 7) / 7) * speed * 0.5, Math.sin(a) * s, life, size, colors[i % colors.length], gravity);
    }
  };
  const spawnRing = (x: number, z: number, r0: number, r1: number, life: number, color: THREE.ColorRepresentation, low = false): void => {
    let active = 0;
    for (const r of rings) if (r.active) active++;
    if (low && active >= 5) return;
    let slot = rings.findIndex(r => !r.active);
    if (slot < 0) {
      slot = 0;
      for (let i = 1; i < rings.length; i++) if (rings[i].age / rings[i].life > rings[slot].age / rings[slot].life) slot = i;
    }
    const r = rings[slot];
    r.active = true; r.age = 0; r.life = life; r.r0 = r0; r.r1 = reduced ? r0 + (r1 - r0) * 0.6 : r1;
    r.mat.color.set(color);
    r.mesh.position.x = x; r.mesh.position.z = z;
    r.mesh.visible = true;
  };

  const C = {
    white: new THREE.Color('#ffffff'), pink: new THREE.Color('#ff8fc2'), crimson: new THREE.Color('#ff3b5c'), violet: new THREE.Color('#b48cff'),
    gold: new THREE.Color('#ffd36a'), cyan: new THREE.Color('#72e9f3'), ember: new THREE.Color('#7a4a8a'),
  };
  const confetti = [new THREE.Color('#ff4d8d'), new THREE.Color('#ffd24d'), new THREE.Color('#2de2e6'), new THREE.Color('#9d5cff'), new THREE.Color('#ffffff')];

  const playEvent = (e: GameEvent, playerX: number): void => {
    const wx = Number.isFinite(e.x) ? e.x : 0;
    const wz = -(Number.isFinite(e.z) ? e.z : 0);
    switch (e.kind) {
      case 'shot': {
        const mine = Math.abs(e.z - WORLD.playerZ) < 1.5;
        tmpColor.set(mine ? palette.projectile : '#ff5a74');
        const mz = mine ? -WORLD.playerZ - 0.9 : wz + 0.6;
        const mx = mine ? (Math.abs(e.x - playerX) < 1.5 ? e.x : playerX) : wx;
        spawnParticle(mx, 1.2, mz, 0, 0, mine ? -2 : 2, 0.09, 0.3, tmpColor);
        burst(mx, 1.2, mz, 3, 2.4, 0.14, 0.09, [tmpColor, C.white]);
        break;
      }
      case 'hit': burst(wx, 1.0, wz, 4, 2.2, 0.26, 0.1, [C.white, C.violet, C.pink]); break;
      case 'kill':
        burst(wx, 0.9, wz, 10, 4.2, 0.5, 0.15, [C.pink, C.white, C.crimson, C.violet], 3);
        spawnRing(wx, wz, 0.3, 1.5, 0.35, '#ff7aa6', true);
        break;
      case 'recruit':
        burst(wx, 0.8, wz, 8, 1.4, 0.85, 0.12, [C.cyan, C.white], -0.6, 1.8);
        spawnRing(wx, wz, 0.4, 2.2, 0.5, '#72e9f3', true);
        break;
      case 'crate':
        burst(wx, 0.8, wz, 8, 3.6, 0.55, 0.14, [C.violet, C.gold, C.white], 3);
        spawnRing(wx, wz, 0.3, 1.8, 0.4, '#d6a8ff', true);
        break;
      case 'damage':
        burst(playerX, 1.2, -WORLD.playerZ, 6, 3.4, 0.4, 0.12, [C.crimson, C.white], 2);
        spawnRing(playerX, -WORLD.playerZ, 0.5, 2.4, 0.4, '#ff3b5c');
        shake = Math.min(1, shake + 0.35);
        break;
      case 'boss':
        spawnRing(wx, wz, 1, 7, 0.9, '#ff3b5c');
        burst(wx, 1.2, wz, 10, 3, 0.6, 0.18, [C.crimson, C.violet], 1);
        shake = Math.min(1, shake + 0.45);
        break;
      case 'burst':
        spawnRing(playerX, -WORLD.playerZ, 0.6, WORLD.halfWidth * 1.7, 0.7, palette.projectile);
        spawnRing(playerX, -WORLD.playerZ, 0.3, WORLD.halfWidth * 1.1, 0.5, '#ffffff');
        tmpColor2.set(palette.projectile);
        burst(playerX, 1.2, -WORLD.playerZ, 14, 6, 0.55, 0.14, [tmpColor2, C.white]);
        shake = Math.min(1, shake + 0.3);
        break;
      case 'synergy':
        spawnRing(playerX, -WORLD.playerZ, 0.5, 2.6, 0.6, '#ffd36a');
        burst(playerX, 1.0, -WORLD.playerZ, 10, 1.6, 0.9, 0.12, [C.gold, C.white], -0.5, 2);
        break;
      case 'reward': burst(wx, 1.0, wz, 6, 1.3, 0.8, 0.12, [C.gold, C.white], -0.4, 1.8); break;
      case 'victory':
        burst(playerX, 1.5, -WORLD.playerZ - 1, 24, 4.5, 1.6, 0.14, confetti, 3.4, 5);
        spawnRing(playerX, -WORLD.playerZ, 0.6, 4.5, 0.9, '#ffd36a');
        break;
      case 'defeat':
        burst(playerX, 1.0, -WORLD.playerZ, 12, 1.4, 1.2, 0.18, [C.ember, C.crimson], -0.6, 1.2);
        spawnRing(playerX, -WORLD.playerZ, 0.6, 3, 0.9, '#ff3b5c');
        break;
      default: break;
    }
  };

  const updateEffects = (dt: number): void => {
    for (let i = particleCount - 1; i >= 0; i--) {
      pLife[i] -= dt;
      if (pLife[i] <= 0) {
        const last = --particleCount;
        if (i !== last) {
          pPos.copyWithin(i * 3, last * 3, last * 3 + 3); pVel.copyWithin(i * 3, last * 3, last * 3 + 3); pCol.copyWithin(i * 3, last * 3, last * 3 + 3);
          pLife[i] = pLife[last]; pMax[i] = pMax[last]; pSize[i] = pSize[last]; pGrav[i] = pGrav[last];
        }
        continue;
      }
      const drag = Math.max(0, 1 - 2.2 * dt);
      pVel[i * 3] *= drag; pVel[i * 3 + 2] *= drag; pVel[i * 3 + 1] = pVel[i * 3 + 1] * drag - pGrav[i] * dt;
      pPos[i * 3] += pVel[i * 3] * dt; pPos[i * 3 + 1] = Math.max(0.05, pPos[i * 3 + 1] + pVel[i * 3 + 1] * dt); pPos[i * 3 + 2] += pVel[i * 3 + 2] * dt;
    }
    particleMesh.count = particleCount;
    for (let i = 0; i < particleCount; i++) {
      const f = pLife[i] / pMax[i];
      dummy.position.set(pPos[i * 3], pPos[i * 3 + 1], pPos[i * 3 + 2]);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.setScalar(pSize[i] * (0.35 + 0.65 * f));
      dummy.updateMatrix();
      particleMesh.setMatrixAt(i, dummy.matrix);
      const k = Math.pow(f, 0.7);
      tmpColor.setRGB(pCol[i * 3] * k, pCol[i * 3 + 1] * k, pCol[i * 3 + 2] * k);
      particleMesh.setColorAt(i, tmpColor);
    }
    particleMesh.instanceMatrix.needsUpdate = true;
    if (particleMesh.instanceColor) particleMesh.instanceColor.needsUpdate = true;
    let active = 0;
    for (const r of rings) {
      if (!r.active) continue;
      r.age += dt;
      if (r.age >= r.life) { r.active = false; r.mesh.visible = false; continue; }
      const t = r.age / r.life;
      const e = 1 - Math.pow(1 - t, 3);
      r.mesh.scale.setScalar(lerp(r.r0, r.r1, e));
      r.mat.opacity = 0.9 * Math.pow(1 - t, 1.5);
      active++;
    }
    counts.particles = particleCount;
    counts.rings = active;
  };

  const resetRun = (): void => {
    particleCount = 0;
    for (const r of rings) { r.active = false; r.mesh.visible = false; }
    shake = 0;
    root.position.set(0, 0, 0);
    counts.particles = 0; counts.rings = 0;
  };

  const writeProjectiles = (state: Readonly<GameState>): void => {
    let pc = 0; let ec = 0;
    const n = Math.min(state.projectiles.length, LIMITS.projectiles);
    for (let i = 0; i < n; i++) {
      const p = state.projectiles[i];
      const mine = p.owner === 'player';
      const core = mine ? playerCore : enemyCore;
      const halo = mine ? playerHalo : enemyHalo;
      const index = mine ? pc++ : ec++;
      dummy.position.set(p.x, mine ? 0.95 : 0.75, -p.z);
      dummy.rotation.set(0, Math.atan2(p.vx, -p.vz), 0);
      const s = clamp(p.radius / 0.15, 0.7, 2.4);
      dummy.scale.set(s, s, mine ? s * 1.4 : s);
      dummy.updateMatrix();
      core.setMatrixAt(index, dummy.matrix);
      dummy.scale.multiplyScalar(2.2);
      dummy.updateMatrix();
      halo.setMatrixAt(index, dummy.matrix);
      if (mine) {
        tmpColor.set(palette.projectile);
        if ((p.chain || p.split) && HEX.test(p.tint)) tmpColor.lerp(tmpColor2.set(p.tint), 0.5);
      } else tmpColor.set('#ff3b5c');
      core.setColorAt(index, tmpColor);
      halo.setColorAt(index, tmpColor);
    }
    for (const [mesh, count] of [[playerCore, pc], [playerHalo, pc], [enemyCore, ec], [enemyHalo, ec]] as const) {
      mesh.count = count;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    counts.projectiles = pc + ec;
  };

  const updateHero = (state: Readonly<GameState>, dt: number): number => {
    const x = Number.isFinite(state.player.x) ? state.player.x : 0;
    const motion = reduced ? 0 : 1;
    const vx = dt > 0 ? (x - prevX) / dt : 0;
    prevX = x;
    lean = damp(lean, clamp(vx * -0.025, -0.28, 0.28) * motion, 12, dt);
    heroGroup.position.set(x, 0.0 + 0.06 * Math.sin(clock * 4) * motion, -WORLD.playerZ);
    heroGroup.rotation.z = lean;
    hero.head.rotation.y = HEAD_YAW + 0.12 * Math.sin(clock * 1.3) * motion;
    hero.head.rotation.z = 0.06 * Math.sin(clock * 2.1) * motion;
    hero.tails[0].rotation.z = (0.12 + 0.1 * Math.sin(clock * 3)) * motion - lean * 1.5;
    hero.tails[1].rotation.z = (-0.12 - 0.1 * Math.sin(clock * 3 + 1)) * motion - lean * 1.5;
    hero.cape.rotation.x = (0.1 + 0.08 * Math.sin(clock * 2.6)) * motion;
    hero.skirt.scale.set(1 + 0.025 * Math.sin(clock * 4 + 1) * motion, 1, 1 + 0.025 * Math.sin(clock * 4 + 1) * motion);
    const weapon = hero.weapons[heroId];
    if (heroId === 'sera') weapon.position.y = 0.18 + 0.05 * Math.sin(clock * 2.4) * motion;
    else weapon.position.y = 0;
    hero.shield.visible = state.player.shield > 0;
    if (hero.shield.visible) (hero.shield.material as THREE.MeshBasicMaterial).opacity = 0.14 + 0.05 * Math.sin(clock * 4) * motion;
    heroGroup.visible = !(state.player.invulnerableFor > 0 && !reduced && Math.floor(clock * 18) % 2 === 0);
    hero.aura.scale.setScalar(1 + 0.06 * Math.sin(clock * 3) * motion);
    return x;
  };

  const ghostSlots: V3[] = [];
  for (const [count, dz] of [[2, 1.1], [3, 1.9], [4, 2.7], [5, 3.5], [4, 4.3]] as const) {
    for (let i = 0; i < count; i++) ghostSlots.push([(i - (count - 1) / 2) * 0.95, 0, dz]);
  }
  const updateGhosts = (squad: number, x: number, dt: number): void => {
    const shown = clamp(Math.floor(Number.isFinite(squad) ? squad : 0), 0, LIMITS.visibleGhosts);
    const motion = reduced ? 0 : 1;
    for (let i = 0; i < ghosts.length; i++) {
      const ghost = ghosts[i];
      const group = ghost.group;
      if (i >= shown) { group.visible = false; ghost.shown = false; ghost.appear = 0; continue; }
      const [dx, , dz] = ghostSlots[i];
      const tx = x + dx;
      const tz = -WORLD.playerZ + dz;
      if (!ghost.shown) { ghost.shown = true; ghost.appear = reduced ? 1 : 0; group.position.set(x, GHOST_BASE_Y, -WORLD.playerZ); group.visible = true; }
      ghost.appear = damp(ghost.appear, 1, 8, dt);
      if (ghost.appear > 0.995) ghost.appear = 1;
      group.position.x = reduced ? tx : damp(group.position.x, tx, 9, dt);
      group.position.z = reduced ? tz : damp(group.position.z, tz, 9, dt);
      group.position.y = GHOST_BASE_Y + 0.12 * Math.sin(clock * 3 + ghost.phase) * motion;
      group.rotation.y = 0.15 * Math.sin(clock * 1.5 + ghost.phase) * motion;
      group.scale.setScalar(Math.max(0.01, ghost.appear));
    }
    counts.ghosts = shown;
  };

  const syncEnemies = (state: Readonly<GameState>): void => {
    const motion = reduced ? 0.25 : 1;
    counts.enemies = reconcile(enemyPool, state.enemies, LIMITS.enemies, frame,
      e => (e.kind === 'boss' ? `boss-${sectorSlot(state.sector)}` : e.kind),
      (v, e) => {
        const scale = clamp(e.radius / v.baseRadius, 0.4, 4);
        v.root.position.set(e.x, 0, -e.z);
        v.model.scale.setScalar(scale);
        v.ring.scale.setScalar(Math.max(0.4, e.radius) * 1.15);
        const phase = e.id * 0.83;
        const attack = e.kind === 'boss' && e.attackTimer < 0.5 && e.attackTimer >= 0 ? 1 + 0.06 * (1 - e.attackTimer * 2) : 1;
        v.model.scale.multiplyScalar(attack);
        const bob = (v.key === 'wraith' ? 0.3 : v.key === 'plush' ? 0.2 : 0.04) * motion;
        v.model.position.y = bob * (1 + Math.sin(clock * 3 + phase)) + (v.key === 'plush' ? 0.1 : 0);
        v.model.rotation.z = 0.06 * Math.sin(clock * 2.2 + phase) * motion;
        if (v.bat && v.teddy) { const isBat = e.id % 2 === 0; v.bat.visible = isBat; v.teddy.visible = !isBat; }
        for (let i = 0; i < v.wings.length; i++) {
          const flap = (v.key === 'boss-2' ? 0.12 : 0.55) * Math.sin(clock * (v.key === 'boss-2' ? 2 : 9) + phase) * motion;
          v.wings[i].rotation.z = (i === 0 ? 1 : -1) * flap * (v.key === 'boss-2' ? 1 : 1);
          if (v.key === 'boss-2') v.wings[i].rotation.y = (i === 0 ? -0.25 : 0.25);
        }
        for (const w of v.wheels) w.rotation.x = -((clock * Math.max(1, e.speed) * 2.2 * motion + phase) % TAU);
        for (const s of v.spinners) { if (v.key === 'boss-2') s.rotation.z = clock * 0.9 * motion; else s.rotation.y = Math.sin(clock * 2 + phase) * 0.4 * motion; }
        v.mods.haste.visible = e.modifier === 'haste';
        v.mods.armored.visible = e.modifier === 'armored';
        v.mods.volatile.visible = e.modifier === 'volatile';
        const missing = e.maxHealth > 0 ? clamp(e.health / e.maxHealth, 0, 1) : 1;
        v.bar.group.visible = missing < 0.999 || e.kind === 'boss';
        v.bar.fill.scale.x = Math.max(0.001, missing);
        const barScale = clamp(scale, 0.9, 2.4);
        v.bar.group.scale.setScalar(barScale);
        v.bar.group.position.set(-0.5 * barScale, v.top * scale + 0.45, 0);
      });
    let pooled = 0;
    for (const list of enemyPool.free.values()) pooled += list.length;
    counts.pooledEnemies = pooled;
  };

  const syncObjects = (state: Readonly<GameState>, dt: number): void => {
    counts.objects = reconcile(objectPool, state.objects, LIMITS.objects, frame,
      o => (o.kind === 'crate' ? 'crate' : o.value < 0 ? 'gate-bad' : 'gate-good'),
      (v, o) => {
        v.root.position.set(o.x, 0, -o.z);
        if (v.key === 'crate') {
          const s = clamp(o.radius / 0.5, 0.6, 1.8);
          v.model.scale.setScalar(s);
          if (o.health < v.lastHealth && Number.isFinite(v.lastHealth)) v.wobble = 0.28;
          v.wobble = Math.max(0, v.wobble - dt);
          v.model.rotation.z = reduced ? 0 : Math.sin(clock * 46) * 0.12 * (v.wobble / 0.28);
          if (v.flame) v.flame.position.y = 1.3 * s;
          const missing = o.maxHealth > 0 ? clamp(o.health / o.maxHealth, 0, 1) : 1;
          v.bar.group.visible = missing < 0.999;
          v.bar.fill.scale.x = Math.max(0.001, missing);
          v.bar.group.scale.setScalar(s);
          v.bar.group.position.set(-0.5 * s, 1.6 * s, 0);
        } else {
          const half = Math.max(0.5, o.width / 2);
          v.pillars[0].position.set(-half, 0, 0); v.pillars[1].position.set(half, 0, 0);
          v.arch?.scale.set(half, 1.0, 1);
          v.portal?.scale.set(half, 1.0, 1);
          v.veil?.scale.set(half * 2, 2.3, 1);
          v.sill?.scale.set(half * 2, 1, 1);
          v.root.rotation.y = 0;
        }
        v.lastHealth = o.health;
      });
  };

  const syncTelegraphs = (state: Readonly<GameState>): void => {
    counts.telegraphs = reconcile(telegraphPool, state.telegraphs, LIMITS.telegraphs, frame, () => 'telegraph', (v, t) => {
      const w = Math.max(0.01, t.width); const d = Math.max(0.01, t.depth);
      v.root.position.set(t.x, 0.03, -t.z);
      v.fill.scale.set(w, 1, d);
      const p = t.duration > 0 ? clamp(1 - t.remaining / t.duration, 0, 1) : 1;
      v.progress.visible = p > 0;
      v.progress.scale.set(w, 1, d * p);
      v.progress.position.z = -d / 2;
      const th = clamp(Math.min(w, d) * 0.25, 0.04, 0.12);
      const [top, bottom, left, right] = v.edges;
      top.scale.set(w, 1, th); top.position.z = -d / 2 + th / 2;
      bottom.scale.set(w, 1, th); bottom.position.z = d / 2 - th / 2;
      left.scale.set(th, 1, d - 2 * th); left.position.x = -w / 2 + th / 2; left.position.z = 0;
      right.scale.set(th, 1, d - 2 * th); right.position.x = w / 2 - th / 2; right.position.z = 0;
      v.blast.visible = t.kind === 'blast';
      const pulse = reduced ? 0.5 : 0.35 + 0.15 * Math.sin(clock * 8);
      v.blast.scale.set(Math.min(w, d) * pulse * 1.4, 1, Math.min(w, d) * pulse * 1.4);
    });
    telegraphLib.edge.opacity = reduced ? 0.95 : 0.8 + 0.15 * Math.sin(clock * 14);
  };

  const world: World = {
    root,
    counts,
    find(kind, id) {
      switch (kind) {
        case 'player': return id === 0 ? heroGroup : undefined;
        case 'enemy': return enemyPool.live.get(id)?.root;
        case 'object': return objectPool.live.get(id)?.root;
        case 'telegraph': return telegraphPool.live.get(id)?.root;
        default: return undefined;
      }
    },
    sync(state, rawDt) {
      if (disposed) throw new Error('Gravewave world was disposed.');
      const dt = Number.isFinite(rawDt) ? clamp(rawDt, 0, MAX_DT) : 0;
      clock += dt;
      frame++;
      let fresh = false;
      if (state.runId !== runId) {
        runId = state.runId;
        resetRun();
        fresh = true;
      }
      const slot = sectorSlot(state.sector);
      if (slot !== sectorIndex) {
        sectorIndex = slot;
        env.applySector(SECTORS[slot], slot);
        enemyLib.setAccent(tmpColor.set(SECTORS[slot].accent));
      }
      env.update(clock, state.elapsed);
      objectLib.animate(clock, reduced);
      const x = updateHero(state, dt);
      updateGhosts(state.player.squad, x, dt);
      syncTelegraphs(state);
      syncObjects(state, dt);
      syncEnemies(state);
      writeProjectiles(state);

      // Events: baseline on first sight of a run, then play each monotonic id once.
      const events = state.events;
      const n = Math.min(events.length, LIMITS.events);
      if (fresh) {
        lastEventId = 0;
        for (let i = 0; i < n; i++) if (events[i].id > lastEventId) lastEventId = events[i].id;
      } else {
        const from = lastEventId;
        for (let i = 0; i < n; i++) {
          const e = events[i];
          if (e.id <= from) continue;
          playEvent(e, x);
          if (e.id > lastEventId) lastEventId = e.id;
        }
      }
      updateEffects(dt);
      shake *= Math.exp(-7 * dt);
      if (reduced || shake < 0.004) { shake = shake < 0.004 ? 0 : shake; }
      if (reduced || shake === 0) root.position.set(0, 0, 0);
      else root.position.set(shake * 0.3 * Math.sin(clock * 61 + 1), shake * 0.2 * Math.sin(clock * 47), 0);
    },
    setAppearance(hero_, skin) {
      const next = assertSkin(hero_, skin);
      palette = next;
      heroId = hero_;
      applyPalette(hero.materials, next);
      showHeroParts();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      scene.remove(root);
      env.release();
      own.disposeAll();
    },
  };
  scene.add(root);
  return world;
};
