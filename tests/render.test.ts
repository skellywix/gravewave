import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { LIMITS, SECTORS, SKINS, WORLD, getSkin } from '../src/game/catalog.ts';
import type { EnemyState, GameEvent, GameState, HeroId, ProjectileState, SkinId, Telegraph, TrackObject } from '../src/game/types.ts';
import { LANDMARK_ANCHOR, createWorld, telegraphBounds } from '../src/render/models.ts';
import type { World } from '../src/render/models.ts';
import { clampPixelRatio, configureCamera, createScene, projectToViewport } from '../src/render/scene.ts';

function makeState(overrides: Partial<GameState> = {}): GameState {
  return {
    runId: 'run-a', seed: 7, rng: 1, mode: 'campaign', hero: 'mira', phase: 'combat', sector: 0,
    elapsed: 0, sectorTime: 0,
    player: { x: 0, health: 100, maxHealth: 100, shield: 0, squad: 3, power: 0, charge: 0, fireCooldown: 0, invulnerableFor: 0 },
    score: 0, kills: 0, echoes: 0,
    upgrades: { overdrive: 0, rapid: 0, scatter: 0, pierce: 0, arc: 0, critical: 0, battery: 0, ricochet: 0, barrier: 0, repair: 0, rally: 0, salvage: 0 },
    offers: [], enemies: [], projectiles: [], objects: [], telegraphs: [], events: [],
    nextEntityId: 1, nextEventId: 1, spawnTimer: 0, objectTimer: 0, regenTimer: 0, choicesTaken: 0,
    bossSpawned: false, rewardMultiplier: 1, enemyMultiplier: 1, announcedSynergies: [],
    ...overrides,
  };
}

function enemy(id: number, kind: EnemyState['kind'], x: number, z: number, extra: Partial<EnemyState> = {}): EnemyState {
  return { id, kind, x, z, health: 10, maxHealth: 10, speed: 3, radius: 0.6, damage: 5, attackTimer: 1, pattern: null, attackStep: 0, modifier: null, ...extra };
}

function bolt(id: number, owner: ProjectileState['owner'], x: number, z: number, extra: Partial<ProjectileState> = {}): ProjectileState {
  return { id, owner, x, z, vx: 0, vz: owner === 'player' ? 20 : -8, damage: 5, radius: 0.2, pierce: 0, life: 1, hitIds: [], tint: '#ffffff', chain: false, split: false, ...extra };
}

function telegraph(id: number, x: number, z: number, width: number, depth: number, remaining: number, duration = 2): Telegraph {
  return { id, x, z, width, depth, remaining, duration, damage: 20, kind: 'lane' };
}

function gate(id: number, x: number, z: number): TrackObject {
  return { id, kind: 'gate', x, z, health: 1, maxHealth: 1, value: 3, radius: 1, width: 2.2 };
}

function event(id: number, kind: GameEvent['kind'], x = 0, z = 0): GameEvent {
  return { id, kind, x, z, value: 1 };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function newWorld(options: { hero?: HeroId; skin?: SkinId; reducedMotion?: boolean } = {}): { scene: THREE.Scene; world: World } {
  const scene = new THREE.Scene();
  const world = createWorld(scene, { hero: options.hero ?? 'mira', skin: options.skin ?? 'mira-default', reducedMotion: options.reducedMotion ?? false });
  return { scene, world };
}

function hex(color: string): string {
  return new THREE.Color(color).getHexString();
}

function heroColors(world: World): Set<string> {
  const hero = world.find('player', 0);
  assert.ok(hero);
  const colors = new Set<string>();
  hero.traverse(node => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      const colored = material as THREE.MeshToonMaterial;
      if (colored.color) colors.add(colored.color.getHexString());
      if (colored.emissive) colors.add(colored.emissive.getHexString());
    }
  });
  return colors;
}

function resourceSets(root: THREE.Object3D): { geometries: Set<THREE.BufferGeometry>; materials: Set<THREE.Material>; textures: Set<THREE.Texture> } {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  root.traverse(node => {
    const drawable = node as THREE.Mesh;
    if (drawable.isMesh || (node as THREE.Points).isPoints) geometries.add(drawable.geometry);
    const list = (drawable as THREE.Mesh).material;
    if (!list) return;
    for (const material of Array.isArray(list) ? list : [list]) {
      materials.add(material);
      for (const value of Object.values(material)) if (value && (value as THREE.Texture).isTexture) textures.add(value as THREE.Texture);
    }
  });
  return { geometries, materials, textures };
}

test('simulation +z maps to world -z and x stays screen-right for every entity class', () => {
  const { world } = newWorld();
  const state = makeState({
    player: { ...makeState().player, x: -2.5 },
    enemies: [enemy(11, 'plush', 1.5, 12), enemy(12, 'carriage', -3, 30), enemy(13, 'wraith', 0, 5)],
    projectiles: [bolt(21, 'player', 0.5, 7)],
    objects: [gate(31, 2, 18)],
    telegraphs: [telegraph(41, -1, 20, 2, 6, 1)],
  });
  world.sync(state, 1 / 60);
  assert.equal(world.find('player', 0)?.position.x, -2.5);
  assert.equal(world.find('player', 0)?.position.z, -WORLD.playerZ);
  const plush = world.find('enemy', 11);
  assert.ok(plush);
  assert.equal(plush.position.x, 1.5);
  assert.equal(plush.position.z, -12);
  assert.equal(world.find('enemy', 12)?.position.z, -30);
  assert.equal(world.find('object', 31)?.position.z, -18);
  assert.ok(world.find('enemy', 12)!.position.z < world.find('enemy', 11)!.position.z, 'larger simulation z is farther down the causeway');
});

test('render sync never mutates a frozen game state', () => {
  const { world } = newWorld();
  const state = makeState({
    enemies: [enemy(1, 'plush', 0, 10, { modifier: 'armored', health: 3 })],
    projectiles: [bolt(2, 'enemy', 1, 9)],
    telegraphs: [telegraph(3, 0, 12, 2, 8, 0.5)],
    events: [event(1, 'kill', 0, 10)],
  });
  const before = JSON.stringify(state);
  deepFreeze(state);
  world.sync(state, 1 / 60);
  world.sync(state, 1 / 60);
  assert.equal(JSON.stringify(state), before);
});

test('setAppearance recolors heroine, squad and projectile accents without touching state', () => {
  const { world } = newWorld({ hero: 'mira', skin: 'mira-default' });
  const state = makeState({ projectiles: [bolt(5, 'player', 0, 6)], player: { ...makeState().player, squad: 6 } });
  const before = JSON.stringify(state);
  world.sync(state, 1 / 60);
  const first = getSkin('mira-default').palette;
  const colors = heroColors(world);
  for (const key of ['body', 'trim', 'hair'] as const) assert.ok(colors.has(hex(first[key])), `default ${key}`);

  const player = world.root.getObjectByName('projectiles-player') as THREE.InstancedMesh;
  const read = (): string => { const c = new THREE.Color(); player.getColorAt(0, c); return c.getHexString(); };
  const defaultProjectile = read();
  const ghost = world.root.getObjectByName('ghost-0') as THREE.Object3D;
  const ghostColors = (): string => { const found = new Set<string>(); ghost.traverse(n => { const m = (n as THREE.Mesh).material as THREE.MeshBasicMaterial | undefined; if (m?.color) found.add(m.color.getHexString()); }); return [...found].sort().join(); };
  const defaultGhost = ghostColors();

  world.setAppearance('rin', 'rin-festival');
  world.sync(state, 1 / 60);
  const next = getSkin('rin-festival').palette;
  const nextColors = heroColors(world);
  for (const key of ['body', 'trim', 'hair'] as const) assert.ok(nextColors.has(hex(next[key])), `festival ${key}`);
  assert.ok(!nextColors.has(hex(first.body)), 'old body color is gone');
  assert.notEqual(read(), defaultProjectile);
  assert.notEqual(ghostColors(), defaultGhost);
  assert.equal(JSON.stringify(state), before);
});

test('mismatched or unknown outfits are rejected instead of silently falling back', () => {
  const { world } = newWorld();
  assert.throws(() => world.setAppearance('rin', 'mira-nocturne'), RangeError);
  assert.throws(() => world.setAppearance('mira', 'mira-unknown' as SkinId), RangeError);
  assert.throws(() => createWorld(new THREE.Scene(), { hero: 'sera', skin: 'rin-default', reducedMotion: false }), RangeError);
  for (const skin of SKINS) world.setAppearance(skin.hero, skin.id);
});

test('each heroine carries a distinct weapon prop', () => {
  const { world } = newWorld();
  const seen = new Map<string, string>();
  for (const hero of ['mira', 'rin', 'sera'] as const) {
    world.setAppearance(hero, `${hero}-default` as SkinId);
    world.sync(makeState({ hero }), 1 / 60);
    const visible: string[] = [];
    world.find('player', 0)!.traverse(node => { if (node.name.startsWith('weapon-') && node.visible && node.parent?.visible !== false) visible.push(node.name); });
    assert.equal(visible.length, 1, `${hero} shows exactly one weapon`);
    seen.set(hero, visible[0]);
  }
  assert.equal(new Set(seen.values()).size, 3);
});

test('entity views are removed when state drops them and are reused by later entities', () => {
  const { world } = newWorld();
  world.sync(makeState({ enemies: [enemy(1, 'plush', 0, 10), enemy(2, 'plush', 1, 12), enemy(3, 'wraith', 2, 14)] }), 1 / 60);
  const second = world.find('enemy', 2)!;
  assert.equal(world.counts.enemies, 3);
  const childrenBefore = world.root.children.length;

  world.sync(makeState({ enemies: [enemy(1, 'plush', 0, 9.5), enemy(3, 'wraith', 2, 13.5)] }), 1 / 60);
  assert.equal(world.counts.enemies, 2);
  assert.equal(world.find('enemy', 2), undefined);
  assert.equal(second.visible, false, 'removed view is hidden, not left floating');

  world.sync(makeState({ enemies: [enemy(1, 'plush', 0, 9), enemy(3, 'wraith', 2, 13), enemy(9, 'plush', -2, 20)] }), 1 / 60);
  assert.equal(world.find('enemy', 9), second, 'a same-kind pooled view is reused');
  assert.equal(second.visible, true);
  assert.equal(second.position.z, -20);
  assert.equal(world.root.children.length, childrenBefore);
});

test('cycling many entities allocates no new geometries, materials or scene nodes', () => {
  const { world } = newWorld();
  const frame = (offset: number): GameState => makeState({
    enemies: Array.from({ length: 12 }, (_, i) => enemy(offset + i, (['plush', 'carriage', 'wraith'] as const)[i % 3], (i % 5) - 2, 10 + i)),
    projectiles: Array.from({ length: 30 }, (_, i) => bolt(offset + 100 + i, i % 2 ? 'player' : 'enemy', (i % 5) - 2, 3 + i * 0.5)),
    telegraphs: [telegraph(offset + 500, 0, 15, 2, 6, 1), telegraph(offset + 501, 2, 15, 2, 6, 1)],
    objects: [gate(offset + 600, 0, 20), { ...gate(offset + 601, 1, 24), kind: 'crate' }],
  });
  world.sync(frame(0), 1 / 60);
  const warm = resourceSets(world.root);
  const nodes = world.root.children.length;
  for (let round = 1; round <= 40; round++) world.sync(frame(round * 1000), 1 / 60);
  const after = resourceSets(world.root);
  assert.equal(after.geometries.size, warm.geometries.size);
  assert.equal(after.materials.size, warm.materials.size);
  assert.equal(after.textures.size, warm.textures.size);
  assert.equal(world.root.children.length, nodes);
});

test('entity classes stay inside the shared presentation caps', () => {
  const { world } = newWorld();
  world.sync(makeState({
    player: { ...makeState().player, squad: 999 },
    enemies: Array.from({ length: 200 }, (_, i) => enemy(i + 1, 'plush', (i % 9) - 4, 5 + i * 0.2)),
    projectiles: Array.from({ length: 400 }, (_, i) => bolt(i + 1000, 'player', (i % 9) - 4, 2 + i * 0.1)),
    objects: Array.from({ length: 60 }, (_, i) => gate(i + 2000, 0, 8 + i)),
    telegraphs: Array.from({ length: 50 }, (_, i) => telegraph(i + 3000, 0, 10 + i, 1, 2, 1)),
    events: Array.from({ length: 300 }, (_, i) => event(i + 1, 'kill', 0, 5)),
  }), 1 / 60);
  assert.equal(world.counts.enemies, LIMITS.enemies);
  assert.equal(world.counts.projectiles, LIMITS.projectiles);
  assert.equal(world.counts.objects, LIMITS.objects);
  assert.equal(world.counts.telegraphs, LIMITS.telegraphs);
  assert.equal(world.counts.ghosts, LIMITS.visibleGhosts);
  const instanced = world.root.getObjectByName('projectiles-player') as THREE.InstancedMesh;
  assert.ok(instanced.count <= LIMITS.projectiles);
});

test('ghost fans follow the squad count and cluster behind the heroine', () => {
  const { world } = newWorld();
  world.sync(makeState({ player: { ...makeState().player, x: 1, squad: 0 } }), 1 / 60);
  assert.equal(world.counts.ghosts, 0);
  for (let i = 0; i < 90; i++) world.sync(makeState({ player: { ...makeState().player, x: 1, squad: 7 } }), 1 / 60);
  assert.equal(world.counts.ghosts, 7);
  for (let i = 0; i < 7; i++) {
    const ghost = world.root.getObjectByName(`ghost-${i}`)!;
    assert.ok(ghost.visible);
    assert.ok(ghost.position.z > 0, 'recruits trail toward the camera');
    assert.ok(Math.abs(ghost.position.x - 1) < 3.5, 'recruits stay clustered around the heroine');
  }
});

test('telegraph geometry covers exactly the damage rectangle', () => {
  const { world } = newWorld();
  const cases = [telegraph(1, -2.1, 22, 2.1, 7.5, 1.6, 2), telegraph(2, 1.4, 14, 0.9, 3, 0.1, 2)];
  world.sync(makeState({ telegraphs: cases }), 1 / 60);
  for (const t of cases) {
    const group = world.find('telegraph', t.id)!;
    group.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(group);
    const rect = telegraphBounds(t);
    assert.ok(Math.abs(box.min.x - rect.minX) < 1e-6 && Math.abs(box.max.x - rect.maxX) < 1e-6, 'x extent');
    assert.ok(Math.abs(box.min.z + rect.maxZ) < 1e-6 && Math.abs(box.max.z + rect.minZ) < 1e-6, 'z extent (sim z negated)');
    assert.ok(box.max.y < 0.2, 'flat on the deck');
  }
  assert.deepEqual(telegraphBounds(cases[0]), { minX: -2.1 - 1.05, maxX: -2.1 + 1.05, minZ: 22 - 3.75, maxZ: 22 + 3.75 });
});

test('telegraph warm-up fills in as time remaining shrinks and leaves the rest of the lane readable', () => {
  const { world } = newWorld();
  const fillAt = (remaining: number): number => {
    world.sync(makeState({ telegraphs: [telegraph(1, 0, 20, 3, 8, remaining, 2)] }), 1 / 60);
    const group = world.find('telegraph', 1)!;
    const progress = group.getObjectByName('telegraph-progress') as THREE.Mesh;
    group.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(progress);
    return box.max.z - box.min.z;
  };
  const early = fillAt(1.8);
  const late = fillAt(0.4);
  const done = fillAt(0);
  assert.ok(early < late && late < done, 'progress strip grows');
  assert.ok(Math.abs(done - 8) < 1e-6, 'warm-up reaches the full damage depth');
  const group = world.find('telegraph', 1)!;
  group.traverse(node => {
    const material = (node as THREE.Mesh).material as THREE.MeshBasicMaterial | undefined;
    if (material && node.name === 'telegraph-fill') assert.ok(material.opacity <= 0.3, 'fill stays translucent so the floor stripes show through');
  });
});

test('events play exactly once by monotonic id and old buffers are not replayed', () => {
  const { world } = newWorld();
  const buffer: GameEvent[] = [event(1, 'kill', 0, 8), event(2, 'kill', 1, 9)];
  world.sync(makeState({ events: buffer }), 0);
  assert.equal(world.counts.particles, 0, 'events already in the buffer at first sight are history');

  buffer.push(event(3, 'kill', 0, 8));
  world.sync(makeState({ events: buffer }), 0);
  const afterThird = world.counts.particles;
  assert.ok(afterThird > 0);
  world.sync(makeState({ events: buffer }), 0);
  world.sync(makeState({ events: buffer }), 0);
  assert.equal(world.counts.particles, afterThird, 'the same buffered event does not retrigger');

  world.sync(makeState({ events: [event(1, 'kill', 0, 8), event(2, 'kill', 0, 8)] }), 0);
  assert.equal(world.counts.particles, afterThird, 'older ids are never replayed');

  buffer.push(event(4, 'burst', 0, 0));
  world.sync(makeState({ events: buffer }), 0);
  assert.ok(world.counts.rings >= 1, 'Encore draws a ring');
  assert.ok(world.counts.particles > afterThird);
});

test('a new run id restarts event tracking instead of dropping its events', () => {
  const { world } = newWorld();
  world.sync(makeState({ runId: 'one', events: [event(1, 'shot'), event(2, 'shot'), event(3, 'shot')] }), 0);
  world.sync(makeState({ runId: 'one', events: [event(1, 'shot'), event(2, 'shot'), event(3, 'shot'), event(4, 'hit')] }), 0);
  const first = world.counts.particles;
  assert.ok(first > 0);
  world.sync(makeState({ runId: 'two', events: [] }), 0);
  assert.equal(world.counts.particles, 0, 'a fresh run clears leftover particles');
  world.sync(makeState({ runId: 'two', events: [event(1, 'hit', 0, 5)] }), 0);
  assert.ok(world.counts.particles > 0, 'ids may restart at 1 in a new run');
});

test('particles and rings stay bounded under an event flood and expire with time', () => {
  const { world } = newWorld();
  world.sync(makeState(), 0);
  const flood = Array.from({ length: LIMITS.events }, (_, i) => event(i + 1, (['kill', 'burst', 'crate', 'recruit', 'victory'] as const)[i % 5], (i % 7) - 3, 6));
  world.sync(makeState({ events: flood }), 0);
  assert.ok(world.counts.particles > 0 && world.counts.particles <= LIMITS.particles);
  assert.ok(world.counts.rings > 0 && world.counts.rings <= 8);
  for (let i = 0; i < 40; i++) world.sync(makeState({ events: flood }), 0.1);
  assert.equal(world.counts.particles, 0);
  assert.equal(world.counts.rings, 0);
});

test('damage shake moves the world only when motion is allowed and always settles', () => {
  const shaken = newWorld({ reducedMotion: false }).world;
  const calm = newWorld({ reducedMotion: true }).world;
  for (const world of [shaken, calm]) world.sync(makeState(), 0);
  const hit = makeState({ events: [event(1, 'damage', 0, 0), event(2, 'boss', 0, 20)] });
  let peak = 0;
  let calmPeak = 0;
  shaken.sync(hit, 1 / 60);
  calm.sync(hit, 1 / 60);
  for (let i = 0; i < 6; i++) {
    shaken.sync(hit, 1 / 60);
    calm.sync(hit, 1 / 60);
    peak = Math.max(peak, shaken.root.position.length());
    calmPeak = Math.max(calmPeak, calm.root.position.length());
  }
  assert.ok(peak > 0 && peak < 0.5, `bounded visible shake (${peak})`);
  assert.equal(calmPeak, 0);
  for (let i = 0; i < 60; i++) shaken.sync(hit, 1 / 30);
  assert.equal(shaken.root.position.length(), 0);
});

test('reduced motion removes the heroine idle bob and slows the causeway scroll', () => {
  const sample = (reducedMotion: boolean): { bob: number; scroll: number } => {
    const { world } = newWorld({ reducedMotion });
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < 120; i++) {
      world.sync(makeState({ elapsed: i / 30 }), 1 / 30);
      const y = world.find('player', 0)!.position.y;
      lo = Math.min(lo, y);
      hi = Math.max(hi, y);
    }
    const deck = world.root.getObjectByName('deck') as THREE.Mesh;
    const map = (deck.material as THREE.MeshBasicMaterial).map!;
    return { bob: hi - lo, scroll: map.offset.y };
  };
  const full = sample(false);
  const reduced = sample(true);
  assert.ok(full.bob > 0.02);
  assert.ok(reduced.bob < 0.002);
  assert.ok(reduced.scroll < full.scroll);
});

test('each sector repaints sky, fog and shows only its own landmark', () => {
  const { scene, world } = newWorld();
  for (const sector of SECTORS) {
    world.sync(makeState({ sector: sector.id }), 1 / 60);
    assert.equal((scene.fog as THREE.Fog).color.getHexString(), hex(sector.fog));
    assert.equal((scene.background as THREE.Color).getHexString(), hex(sector.sky));
    for (const other of SECTORS) assert.equal(world.root.getObjectByName(`landmark-${other.id}`)!.visible, other.id === sector.id);
  }
  world.sync(makeState({ sector: 4 }), 1 / 60);
  assert.equal(world.root.getObjectByName('landmark-1')!.visible, true, 'survival sectors cycle the themed landmarks');
});

test('the three bosses and the common enemies are built from different art', () => {
  const { world } = newWorld();
  const signatures: string[] = [];
  const boxes: string[] = [];
  for (const sector of [0, 1, 2]) {
    world.sync(makeState({ sector, enemies: [enemy(1, 'boss', 0, 20, { radius: 1.6, maxHealth: 400, health: 400, pattern: 'lanes' })] }), 1 / 60);
    const boss = world.find('enemy', 1)!;
    const geometries = [...resourceSets(boss).geometries].map(g => g.uuid).sort();
    signatures.push(geometries.join());
    boss.updateMatrixWorld(true);
    const size = new THREE.Box3().setFromObject(boss).getSize(new THREE.Vector3());
    boxes.push(`${size.x.toFixed(1)}x${size.y.toFixed(1)}`);
    world.sync(makeState({ sector }), 1 / 60);
  }
  assert.equal(new Set(signatures).size, 3);
  assert.equal(new Set(boxes).size, 3, `bosses have distinct silhouettes ${boxes.join(' ')}`);
  world.sync(makeState({ enemies: [enemy(2, 'plush', 0, 10), enemy(3, 'carriage', 0, 12), enemy(4, 'wraith', 0, 14)] }), 1 / 60);
  const kinds = [2, 3, 4].map(id => [...resourceSets(world.find('enemy', id)!).geometries].map(g => g.uuid).sort().join());
  assert.equal(new Set(kinds).size, 3);
});

test('enemy health bars appear only after damage and track remaining health', () => {
  const { world } = newWorld();
  const width = (health: number): number | null => {
    world.sync(makeState({ enemies: [enemy(1, 'plush', 0, 10, { health, maxHealth: 10 })] }), 1 / 60);
    const bar = world.find('enemy', 1)!.getObjectByName('health-fill') as THREE.Object3D;
    return bar.parent!.visible ? bar.scale.x : null;
  };
  assert.equal(width(10), null);
  const half = width(5)!;
  const low = width(1)!;
  assert.ok(half > low && low > 0);
});

test('dispose releases every owned resource, detaches the world and spares foreign objects', () => {
  const scene = new THREE.Scene();
  const foreign = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
  scene.add(foreign);
  const world = createWorld(scene, { hero: 'mira', skin: 'mira-default', reducedMotion: false });
  world.sync(makeState({
    enemies: [enemy(1, 'plush', 0, 10, { modifier: 'volatile' }), enemy(2, 'boss', 0, 20)],
    projectiles: [bolt(3, 'player', 0, 5)], objects: [gate(4, 0, 12)], telegraphs: [telegraph(5, 0, 14, 2, 5, 1)],
  }), 1 / 60);
  const owned = resourceSets(world.root);
  assert.ok(owned.geometries.size > 20 && owned.materials.size > 10 && owned.textures.size > 2);
  const disposed = new Set<unknown>();
  for (const resource of [...owned.geometries, ...owned.materials, ...owned.textures]) resource.addEventListener('dispose', () => disposed.add(resource));
  const foreignDisposed: string[] = [];
  foreign.geometry.addEventListener('dispose', () => foreignDisposed.push('geometry'));
  (foreign.material as THREE.Material).addEventListener('dispose', () => foreignDisposed.push('material'));

  world.dispose();
  assert.equal(disposed.size, owned.geometries.size + owned.materials.size + owned.textures.size);
  assert.deepEqual(foreignDisposed, []);
  assert.deepEqual(scene.children, [foreign]);
  assert.equal(scene.fog, null);
  assert.equal(scene.background, null);
  world.dispose();
});

test('dispose restores the scene fog and background it replaced, and leaves foreign replacements alone', () => {
  const options = { hero: 'mira', skin: 'mira-default', reducedMotion: false } as const;
  const originalFog = new THREE.Fog('#123456', 1, 2);
  const originalBackground = new THREE.Color('#654321');
  const restored = new THREE.Scene();
  restored.fog = originalFog;
  restored.background = originalBackground;
  const owner = createWorld(restored, options);
  assert.notEqual(restored.fog, originalFog);
  owner.dispose();
  assert.equal(restored.fog, originalFog);
  assert.equal(restored.background, originalBackground);

  const replaced = new THREE.Scene();
  const world = createWorld(replaced, options);
  const foreignFog = new THREE.FogExp2('#abcdef', 0.01);
  const foreignBackground = new THREE.Color('#fedcba');
  replaced.fog = foreignFog;
  replaced.background = foreignBackground;
  world.sync(makeState({ sector: 1 }), 1 / 60);
  assert.equal(foreignBackground.getHexString(), 'fedcba', 'world does not repaint a background it no longer owns');
  world.dispose();
  assert.equal(replaced.fog, foreignFog);
  assert.equal(replaced.background, foreignBackground);
});

test('heroine face and hair meshes follow the head transform', () => {
  for (const heroId of ['mira', 'rin', 'sera'] as const) {
    const skinId = SKINS.find(s => s.hero === heroId)!.id;
    const palette = getSkin(skinId).palette;
    const { world } = newWorld({ hero: heroId, skin: skinId });
    const hero = world.find('player', 0)!;
    const head = hero.getObjectByName('hero-head')!;
    assert.ok(head, 'the heroine exposes her head group');
    const features: Record<string, THREE.Mesh[]> = { eyes: [], iris: [], highlights: [], blush: [], hair: [] };
    hero.traverse(node => {
      const mesh = node as THREE.Mesh;
      if (!mesh.isMesh || (mesh.parent !== head && mesh.parent !== head.parent)) return;
      for (let p: THREE.Object3D | null = mesh; p && p !== hero; p = p.parent) if (p.name.startsWith('weapon-') || p.name.startsWith('accessory-')) return;
      const mat = mesh.material as THREE.MeshBasicMaterial & THREE.MeshToonMaterial;
      const color = mat.color.getHexString();
      if (mat.isMeshBasicMaterial && color === hex('#2a1240')) features.eyes.push(mesh);
      else if (mat.isMeshBasicMaterial && color === hex(palette.trim)) features.iris.push(mesh);
      else if (mat.isMeshBasicMaterial && color === hex('#ffffff')) features.highlights.push(mesh);
      else if (mat.isMeshBasicMaterial && color === hex('#ff8fb0')) features.blush.push(mesh);
      else if (mat.isMeshToonMaterial && color === hex(palette.hair)) features.hair.push(mesh);
    });
    const centers = (): Map<THREE.Mesh, THREE.Vector3> => {
      hero.updateMatrixWorld(true);
      return new Map(Object.values(features).flat().map(m => [m, new THREE.Box3().setFromObject(m).getCenter(new THREE.Vector3())]));
    };
    for (const [name, meshes] of Object.entries(features)) assert.ok(meshes.length > 0, `${heroId} has ${name} meshes`);

    const before = centers();
    const headBefore = head.getWorldPosition(new THREE.Vector3());
    head.rotation.y += 0.6;
    const after = centers();
    const headAfter = head.getWorldPosition(new THREE.Vector3());
    assert.ok(headBefore.distanceTo(headAfter) < 1e-6, 'turning the head does not move its pivot');
    for (const [name, meshes] of Object.entries(features)) {
      for (const mesh of meshes) {
        assert.ok(before.get(mesh)!.distanceTo(headBefore) < 0.6, `${heroId} ${name} sits around the head, not the body origin`);
        assert.ok(after.get(mesh)!.distanceTo(headAfter) < 0.6, `${heroId} ${name} stays around the head after it turns`);
      }
    }
    for (const name of ['eyes', 'iris', 'highlights', 'blush'] as const) {
      for (const mesh of features[name]) assert.ok(before.get(mesh)!.distanceTo(after.get(mesh)!) > 0.03, `${heroId} ${name} turn with the head`);
    }
  }
});

test('portrait camera frames the player low, the castle high, and the whole causeway', () => {
  for (const [width, height] of [[390, 844], [360, 640], [430, 932]] as const) {
    const camera = new THREE.PerspectiveCamera();
    configureCamera(camera, width / height);
    const player = projectToViewport(camera, 0, WORLD.playerZ, width, height);
    assert.ok(player.visible);
    assert.ok(player.y > height * 0.6 && player.y < height * 0.88, `player in lower third (${player.y}/${height})`);
    const left = projectToViewport(camera, -WORLD.halfWidth, WORLD.playerZ, width, height);
    const right = projectToViewport(camera, WORLD.halfWidth, WORLD.playerZ, width, height);
    assert.ok(left.visible && right.visible && left.x >= 0 && right.x <= width, 'both lane edges are on screen');
    assert.ok(left.x < player.x && player.x < right.x, '+x is screen-right');
    const near = projectToViewport(camera, 0, 4, width, height);
    const far = projectToViewport(camera, 0, 30, width, height);
    assert.ok(far.y < near.y && near.y < player.y, 'positive simulation z climbs the screen');
    const spawn = projectToViewport(camera, 0, WORLD.spawnDistance, width, height);
    assert.ok(spawn.visible && spawn.y < height * 0.5, 'enemies spawn in view, well above the player');
    const castle = projectToViewport(camera, LANDMARK_ANCHOR.x, -LANDMARK_ANCHOR.z, width, height, LANDMARK_ANCHOR.y);
    assert.ok(castle.visible && castle.y >= 0 && castle.y < height / 3, `castle in upper third (${castle.y}/${height})`);
  }
});

test('desktop aspect keeps the player and lanes framed', () => {
  const camera = new THREE.PerspectiveCamera();
  configureCamera(camera, 1.6);
  const player = projectToViewport(camera, 0, WORLD.playerZ, 1280, 800);
  assert.ok(player.visible && player.y > 800 * 0.55);
  assert.ok(projectToViewport(camera, WORLD.halfWidth, WORLD.playerZ, 1280, 800).visible);
});

test('points behind the camera and outside the viewport are reported hidden', () => {
  const camera = new THREE.PerspectiveCamera();
  configureCamera(camera, 390 / 844);
  assert.equal(projectToViewport(camera, 0, -40, 390, 844).visible, false);
  assert.equal(projectToViewport(camera, 60, 10, 390, 844).visible, false);
});

test('pixel ratio is capped at the shared limit and rejects nonsense', () => {
  assert.equal(clampPixelRatio(3), LIMITS.pixelRatio);
  assert.equal(clampPixelRatio(1.5), 1.5);
  assert.equal(clampPixelRatio(0), 1);
  assert.equal(clampPixelRatio(Number.NaN), 1);
  assert.equal(clampPixelRatio(undefined), 1);
});

test('WebGL initialization failure is surfaced with its cause, never faked', () => {
  const canvas = { getContext: () => null, addEventListener: () => undefined, removeEventListener: () => undefined, style: {} } as unknown as HTMLCanvasElement;
  assert.throws(
    () => createScene(canvas, { hero: 'mira', skin: 'mira-default', reducedMotion: false }),
    (error: unknown) => error instanceof Error && /WebGL/.test(error.message) && error.cause !== undefined,
  );
});
