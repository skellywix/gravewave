import test from 'node:test';
import assert from 'node:assert/strict';
import { activeSynergies, chooseRoute, chooseUpgrade, createRun, tick } from '../src/game/engine.ts';
import { ECONOMY, LIMITS, SECTORS, UPGRADES, WORLD, getHero } from '../src/game/catalog.ts';
import type { EnemyState, GameEvent, GameState, HeroId, Input, Mode, ProjectileState, TrackObject, UpgradeId } from '../src/game/types.ts';

const STEP = 1 / 60;
const IDLE: Readonly<Input> = Object.freeze({ move: 0, targetX: null, burst: false });

// ---------------------------------------------------------------------------
// Purpose-built unit fixtures. These isolate one mechanic by emptying the
// track and suppressing the encounter scheduler; they never prove browser play.
// ---------------------------------------------------------------------------
function run(seed = 7, hero: HeroId = 'mira', mode: Mode = 'campaign'): GameState {
  return createRun(seed, hero, mode, `unit-${seed}-${hero}-${mode}`);
}

function quiet(state: GameState, holdFire = true): GameState {
  state.enemies = [];
  state.projectiles = [];
  state.objects = [];
  state.telegraphs = [];
  state.spawnTimer = 1e9;
  state.objectTimer = 1e9;
  state.regenTimer = 1e9;
  if (holdFire) state.player.fireCooldown = 1e9;
  return state;
}

function advance(state: GameState, seconds: number, input: Readonly<Input> = IDLE): void {
  const steps = Math.round(seconds / STEP);
  for (let i = 0; i < steps; i++) tick(state, input, STEP);
}

function addEnemy(state: GameState, patch: Partial<EnemyState> = {}): EnemyState {
  const enemy: EnemyState = {
    id: state.nextEntityId++, kind: 'plush', x: 0, z: 10, health: 100, maxHealth: 100, speed: 0, radius: 0.55,
    damage: 10, attackTimer: 1e9, pattern: null, attackStep: 0, modifier: null, ...patch,
  };
  state.enemies.push(enemy);
  return enemy;
}

function addShot(state: GameState, patch: Partial<ProjectileState> = {}): ProjectileState {
  const shot: ProjectileState = {
    id: state.nextEntityId++, owner: 'player', x: 0, z: 9.5, vx: 0, vz: 25, damage: 15, radius: 0.22, pierce: 0, life: 2,
    hitIds: [], tint: '#ffffff', chain: false, split: false, ...patch,
  };
  state.projectiles.push(shot);
  return shot;
}

function addObject(state: GameState, patch: Partial<TrackObject> = {}): TrackObject {
  const object: TrackObject = {
    id: state.nextEntityId++, kind: 'gate', x: 0, z: 0.3, health: 1, maxHealth: 1, value: 2, radius: 0.8, width: 1.7, ...patch,
  };
  state.objects.push(object);
  return object;
}

function take(state: GameState, id: UpgradeId): void {
  state.phase = 'upgrade';
  state.offers = [id];
  assert.equal(chooseUpgrade(state, id), true, `${id} should be selectable`);
}

function since(state: GameState, mark: number): GameEvent[] {
  return state.events.filter(event => event.id >= mark);
}

function snapshot(state: GameState): string {
  return JSON.stringify(state);
}

function spawnBoss(seed: number, sector: number, mode: Mode = 'campaign', hero: HeroId = 'mira'): { state: GameState; boss: EnemyState } {
  const state = quiet(run(seed, hero, mode));
  state.sector = sector;
  state.choicesTaken = 2;
  state.sectorTime = WORLD.sectorSeconds - 0.01;
  tick(state, IDLE, 0.05);
  const boss = state.enemies.find(enemy => enemy.kind === 'boss');
  assert.ok(boss, 'boss spawns once the sector clock reaches 72 seconds');
  return { state, boss };
}

function killBoss(state: GameState, boss: EnemyState): void {
  boss.health = 1;
  state.player.fireCooldown = 0;
  state.player.x = boss.x;
  for (let i = 0; i < 300 && state.phase === 'combat'; i++) tick(state, { move: 0, targetX: boss.x, burst: false }, STEP);
}

function reachRoute(seed = 3, mode: Mode = 'campaign'): GameState {
  const { state, boss } = spawnBoss(seed, 0, mode);
  killBoss(state, boss);
  assert.equal(state.phase, 'route');
  return state;
}

// ---------------------------------------------------------------------------
// A human-shaped pilot: reads the same on-screen information (positions and
// telegraphs) and uses only the public Input. Used for end-to-end simulation.
// ---------------------------------------------------------------------------
function pilot(state: GameState): Input {
  // Each hazard is a span of the bridge and the time left before it resolves.
  const hazards: Array<{ lo: number; hi: number; left: number }> = [];
  for (const enemy of state.enemies) {
    if (enemy.kind === 'boss' || enemy.z > 11 || enemy.z < -1.5) continue;
    const reach = enemy.radius * 0.8 + 0.6;
    hazards.push({ lo: enemy.x - reach, hi: enemy.x + reach, left: Math.max(0, enemy.z - 0.5) / Math.max(enemy.speed, 0.1) });
  }
  for (const t of state.telegraphs) hazards.push({ lo: t.x - t.width / 2 - 0.5, hi: t.x + t.width / 2 + 0.5, left: t.remaining });
  for (const p of state.projectiles) {
    if (p.owner !== 'enemy' || p.vz >= 0 || p.z < 0) continue;
    const left = p.z / -p.vz;
    const landing = p.x + p.vx * left;
    hazards.push({ lo: landing - 0.95, hi: landing + 0.95, left });
  }
  const boss = state.enemies.find(enemy => enemy.kind === 'boss');
  const gate = state.objects.filter(o => o.kind === 'gate' && o.z > 1 && o.z < 16).sort((a, b) => a.z - b.z)[0];
  const crate = state.objects.filter(o => o.kind === 'crate' && o.z > 4 && o.z < 24).sort((a, b) => a.z - b.z)[0];
  const foe = state.enemies.filter(e => e.kind !== 'boss' && e.z > 1).sort((a, b) => a.z - b.z)[0];
  const desire = boss ? boss.x : gate ? gate.x : crate ? crate.x : foe ? foe.x : 0;
  const here = state.player.x;
  const speed = 12; // a finger glides at about this pace (targetX steering)
  let best = here;
  let bestCost = Infinity;
  for (let x = -WORLD.halfWidth; x <= WORLD.halfWidth + 1e-9; x += 0.15) {
    // Unsafe: ending inside a hazard, or passing through one while it resolves.
    const danger = hazards.some(h => {
      if (x >= h.lo && x <= h.hi) return true;
      if (here >= h.lo && here <= h.hi) return false;
      const near = x > here ? h.lo : h.hi;
      const far = x > here ? h.hi : h.lo;
      const crosses = x > here ? h.lo > here && h.hi < x : h.hi < here && h.lo > x;
      if (!crosses) return false;
      return h.left >= Math.abs(near - here) / speed - 0.05 && h.left <= Math.abs(far - here) / speed + 0.05;
    });
    const cost = Math.abs(x - desire) + 0.25 * Math.abs(x - here) + (danger ? 100 : 0);
    if (cost < bestCost) { bestCost = cost; best = x; }
  }
  const crowd = state.enemies.filter(e => e.z < 26).length;
  return { move: 0, targetX: best, burst: state.player.charge >= 100 && (boss !== undefined || crowd >= 3) };
}

interface Playthrough {
  state: GameState;
  kinds: Set<string>;
  objectKinds: Set<string>;
  sideCrate: boolean;
  enemyFire: boolean;
  maxEnemies: number;
  maxProjectiles: number;
  maxObjects: number;
  maxTelegraphs: number;
  maxEvents: number;
  routeEchoes: number | null;
  eventsMonotonic: boolean;
  sectorsCleared: number;
  seconds: number;
}

function playthrough(seed: number, hero: HeroId, mode: Mode, until: (s: GameState) => boolean, maxSeconds = 900): Playthrough {
  const state = createRun(seed, hero, mode, `e2e-${seed}-${hero}-${mode}`);
  const out: Playthrough = {
    state, kinds: new Set(), objectKinds: new Set(), sideCrate: false, enemyFire: false, maxEnemies: 0, maxProjectiles: 0, maxObjects: 0,
    maxTelegraphs: 0, maxEvents: 0, routeEchoes: null, eventsMonotonic: true, sectorsCleared: 0, seconds: 0,
  };
  let lastEventId = 0;
  for (let i = 0; i < maxSeconds * 60; i++) {
    if (state.phase === 'upgrade') { assert.ok(chooseUpgrade(state, state.offers[0])); continue; }
    if (state.phase === 'route') {
      if (out.routeEchoes === null) out.routeEchoes = state.echoes;
      out.sectorsCleared++;
      assert.ok(chooseRoute(state, 'safe'));
      continue;
    }
    if (state.phase !== 'combat' || until(state)) break;
    tick(state, pilot(state), STEP);
    for (const e of state.enemies) out.kinds.add(e.kind);
    for (const o of state.objects) { out.objectKinds.add(o.kind); if (o.kind === 'crate' && Math.abs(o.x) > 3) out.sideCrate = true; }
    if (state.projectiles.some(p => p.owner === 'enemy')) out.enemyFire = true;
    out.maxEnemies = Math.max(out.maxEnemies, state.enemies.length);
    out.maxProjectiles = Math.max(out.maxProjectiles, state.projectiles.length);
    out.maxObjects = Math.max(out.maxObjects, state.objects.length);
    out.maxTelegraphs = Math.max(out.maxTelegraphs, state.telegraphs.length);
    out.maxEvents = Math.max(out.maxEvents, state.events.length);
    const newest = state.events.at(-1);
    if (newest) {
      if (newest.id < lastEventId) out.eventsMonotonic = false;
      lastEventId = Math.max(lastEventId, newest.id);
    }
    out.seconds = state.elapsed;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Run creation and determinism
// ---------------------------------------------------------------------------
test('every heroine starts a fresh combat run from her catalog stats', () => {
  for (const id of ['mira', 'rin', 'sera'] as const) {
    const state = createRun(5, id, 'campaign', `start-${id}`);
    const hero = getHero(id);
    assert.equal(state.phase, 'combat');
    assert.equal(state.sector, 0);
    assert.equal(state.hero, id);
    assert.equal(state.player.health, hero.stats.health);
    assert.equal(state.player.maxHealth, hero.stats.health);
    assert.equal(state.player.x, 0);
    assert.equal(state.player.charge, 0);
    assert.ok(state.player.squad >= 1, 'a new run starts with a few ghost fans');
    assert.deepEqual(state.offers, []);
    assert.deepEqual(state.enemies, []);
    for (const upgrade of UPGRADES) assert.equal(state.upgrades[upgrade.id], 0);
  }
});

test('copies of one seed keep their own run IDs and otherwise play identically', () => {
  const a = createRun(99, 'rin', 'survival', 'alpha');
  const b = createRun(99, 'rin', 'survival', 'beta');
  assert.equal(a.runId, 'alpha');
  assert.equal(b.runId, 'beta');
  b.runId = a.runId;
  assert.deepEqual(a, b);
});

test('createRun rejects an unknown heroine, mode or empty run ID instead of inventing one', () => {
  assert.throws(() => createRun(1, 'nobody' as HeroId, 'campaign', 'x'), RangeError);
  assert.throws(() => createRun(1, 'mira', 'arcade' as Mode, 'x'), RangeError);
  assert.throws(() => createRun(1, 'mira', 'campaign', ''), RangeError);
});

test('the same seed and inputs always produce the same run, and runs never share hidden state', () => {
  const script = (i: number): Input => ({ move: Math.sin(i / 17), targetX: i % 400 < 100 ? 2 : null, burst: i % 500 === 499 });
  const a = run(21);
  const b = run(21);
  const lone = run(21);
  for (let i = 0; i < 1500; i++) { tick(a, script(i), STEP); tick(lone, script(i), STEP); }
  for (let i = 0; i < 1500; i++) { tick(b, script(i), STEP); tick(run(5), IDLE, STEP); }
  assert.equal(snapshot(a), snapshot(b));
  assert.equal(snapshot(a), snapshot(lone));
});

test('different seeds produce genuinely different encounters', () => {
  const signature = (seed: number): string => {
    const state = run(seed);
    advance(state, 10);
    assert.ok(state.enemies.length > 0, 'the first ten seconds already contain enemies');
    return JSON.stringify(state.enemies.map(e => [e.kind, Math.round(e.x * 100), Math.round(e.z * 10)]));
  };
  const signatures = new Set([1, 2, 3, 4, 5, 6].map(signature));
  assert.equal(signatures.size, 6);
});

// ---------------------------------------------------------------------------
// Steering and frame-delta safety
// ---------------------------------------------------------------------------
test('keyboard movement moves at hero speed, clamps to the bridge and ignores out-of-range input', () => {
  const state = quiet(run());
  advance(state, 0.5, { move: 1, targetX: null, burst: false });
  assert.ok(Math.abs(state.player.x - getHero('mira').stats.moveSpeed * 0.5) < 1e-9);
  advance(state, 3, { move: 5, targetX: null, burst: false });
  assert.equal(state.player.x, WORLD.halfWidth);
  advance(state, 3, { move: -999, targetX: null, burst: false });
  assert.equal(state.player.x, -WORLD.halfWidth);
  const x = state.player.x;
  advance(state, 0.5, { move: Number.NaN, targetX: Number.POSITIVE_INFINITY, burst: false });
  assert.equal(state.player.x, x);
});

test('touch targetX glides to the finger without overshooting and clamps off-screen drags', () => {
  const state = quiet(run());
  tick(state, { move: 0, targetX: 3, burst: false }, 0.05);
  assert.ok(state.player.x > 0 && state.player.x < 3);
  advance(state, 1, { move: 0, targetX: 3, burst: false });
  assert.ok(Math.abs(state.player.x - 3) < 1e-9);
  advance(state, 2, { move: 0, targetX: -50, burst: false });
  assert.equal(state.player.x, -WORLD.halfWidth);
});

test('invalid frame deltas are ignored and huge ones are bounded', () => {
  const state = run();
  for (const dt of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const before = snapshot(state);
    tick(state, { move: 1, targetX: null, burst: false }, dt);
    assert.equal(snapshot(state), before, `dt=${dt} changes nothing`);
  }
  tick(state, IDLE, 30);
  assert.ok(state.elapsed > 0 && state.elapsed <= 0.1 + 1e-9, `elapsed ${state.elapsed}`);
});

// ---------------------------------------------------------------------------
// Firing, projectile intersection and damage
// ---------------------------------------------------------------------------
test('each heroine fires her own volley shape from the first frame', () => {
  const volley = (hero: HeroId): ProjectileState[] => {
    const state = quiet(run(7, hero), false);
    state.player.fireCooldown = 0;
    tick(state, IDLE, STEP);
    const base = getHero(hero).stats.damage;
    return state.projectiles.filter(p => p.owner === 'player' && Math.abs(p.damage - base) < 1e-9);
  };
  const mira = volley('mira');
  const rin = volley('rin');
  const sera = volley('sera');
  assert.equal(mira.length, 1);
  assert.equal(rin.length, 3);
  assert.equal(sera.length, 1);
  assert.ok(mira[0].pierce >= 1, 'the parasol railgun pierces by default');
  assert.equal(rin[0].pierce, 0);
  assert.ok(sera[0].chain, 'grimoire bolts arc to a second foe by default');
  assert.ok(Math.abs(rin[0].vx + rin[2].vx) < 1e-9 && rin[0].vx < 0 && rin[1].vx === 0, 'scatter fans symmetrically');
  assert.ok(mira[0].vz > 0);
});

test('a shot damages the first enemy it overlaps, is consumed and misses neighbours', () => {
  const state = quiet(run());
  const hit = addEnemy(state, { x: 0, z: 10 });
  const behind = addEnemy(state, { x: 0, z: 13 });
  const aside = addEnemy(state, { x: 1.6, z: 10 });
  addShot(state);
  advance(state, 0.6);
  assert.equal(hit.health, 85);
  assert.equal(behind.health, 100);
  assert.equal(aside.health, 100);
  assert.equal(state.projectiles.length, 0);
  assert.ok(since(state, 1).some(e => e.kind === 'hit' && e.value === 15));
});

test('pierce lets one shot pass through exactly its allowance and hit each enemy once', () => {
  const state = quiet(run());
  const a = addEnemy(state, { z: 10 });
  const b = addEnemy(state, { z: 12 });
  const c = addEnemy(state, { z: 14 });
  addShot(state, { pierce: 1 });
  advance(state, 1);
  assert.equal(a.health, 85);
  assert.equal(b.health, 85);
  assert.equal(c.health, 100);
});

test('an enemy killed by overlapping shots pays out exactly once', () => {
  const state = quiet(run());
  addEnemy(state, { z: 10, health: 10, maxHealth: 10 });
  addShot(state, { z: 9.6, damage: 15 });
  addShot(state, { z: 9.7, damage: 15 });
  addShot(state, { z: 9.8, damage: 15 });
  advance(state, 0.5);
  assert.equal(state.kills, 1);
  assert.equal(state.echoes, ECONOMY.kill);
  assert.equal(since(state, 1).filter(e => e.kind === 'kill').length, 1);
  assert.equal(state.enemies.length, 0);
});

test('recruited ghost fans add real damage to the volley and converge on the lane', () => {
  const dealt = (squad: number): number => {
    const state = quiet(run(), false);
    state.player.squad = squad;
    state.player.fireCooldown = 0;
    const target = addEnemy(state, { z: 14, health: 1e6, maxHealth: 1e6 });
    advance(state, 3);
    return 1e6 - target.health;
  };
  const few = dealt(2);
  const many = dealt(14);
  assert.ok(few > 0);
  assert.ok(many > few * 1.5, `${many} should clearly beat ${few}`);
});

test('firing never exceeds the projectile cap even with every upgrade and a full squad', () => {
  const state = quiet(run(3, 'rin'), false);
  state.player.fireCooldown = 0;
  state.player.squad = 40;
  for (const upgrade of UPGRADES) state.upgrades[upgrade.id] = 3;
  addEnemy(state, { z: 40, health: 1e9, maxHealth: 1e9, radius: 0.1 });
  advance(state, 6);
  assert.ok(state.projectiles.length <= LIMITS.projectiles);
});

// ---------------------------------------------------------------------------
// Damage to the player, telegraphs and invulnerability
// ---------------------------------------------------------------------------
test('enemy fire hurts once, grants brief invulnerability and then hurts again', () => {
  const state = quiet(run());
  const orb = (): void => { addShot(state, { owner: 'enemy', x: 0, z: 0.8, vz: -9, damage: 8 }); };
  orb();
  orb();
  advance(state, 0.3);
  assert.equal(state.player.health, 100 - 8);
  assert.ok(state.player.invulnerableFor > 0 && state.player.invulnerableFor <= 1);
  assert.equal(state.projectiles.length, 0);
  advance(state, 1.1);
  orb();
  advance(state, 0.3);
  assert.equal(state.player.health, 100 - 16);
});

test('enemy fire that passes beside the heroine does no damage', () => {
  const state = quiet(run());
  addShot(state, { owner: 'enemy', x: 1.5, z: 3, vz: -9, damage: 8 });
  advance(state, 1);
  assert.equal(state.player.health, 100);
});

test('contact with a possessed enemy hurts once and consumes it', () => {
  const state = quiet(run());
  const plush = addEnemy(state, { z: 0.6, damage: 11 });
  advance(state, 0.3);
  assert.equal(state.player.health, 89);
  assert.ok(!state.enemies.includes(plush));
  assert.equal(since(state, 1).filter(e => e.kind === 'damage').length, 1);
});

test('shield absorbs damage before health', () => {
  const state = quiet(run(1, 'sera'));
  state.player.shield = 6;
  addShot(state, { owner: 'enemy', x: 0, z: 0.8, vz: -9, damage: 10 });
  advance(state, 0.2);
  assert.equal(state.player.shield, 0);
  assert.equal(state.player.health, getHero('sera').stats.health - 4);
});

test('a lane telegraph hurts only a player still inside it when the countdown ends, and only once', () => {
  for (const [x, expected] of [[0, 84], [2.6, 100]] as const) {
    const state = quiet(run());
    state.player.x = x;
    state.telegraphs.push({ id: state.nextEntityId++, x: 0, z: 7, width: 1.6, depth: 16, remaining: 0.5, duration: 1.5, damage: 16, kind: 'lane' });
    advance(state, 0.4);
    assert.equal(state.player.health, 100, 'no damage before the countdown ends');
    advance(state, 2.5, { move: 0, targetX: x, burst: false });
    assert.equal(state.player.health, expected);
    assert.equal(state.telegraphs.length, 0);
  }
});

test('zero health ends the run immediately and freezes all combat', () => {
  const state = quiet(run());
  state.player.health = 5;
  addShot(state, { owner: 'enemy', x: 0, z: 0.8, vz: -9, damage: 8 });
  advance(state, 0.2);
  assert.equal(state.phase, 'defeat');
  assert.equal(state.player.health, 0);
  assert.equal(since(state, 1).filter(e => e.kind === 'defeat').length, 1);
  addEnemy(state, { z: 0.5 });
  state.player.fireCooldown = 0;
  state.player.charge = 100;
  const frozen = snapshot(state);
  for (let i = 0; i < 120; i++) tick(state, { move: 1, targetX: 2, burst: true }, STEP);
  assert.equal(snapshot(state), frozen);
});

// ---------------------------------------------------------------------------
// Gates and amplifier crates
// ---------------------------------------------------------------------------
test('a ghost-fan gate recruits exactly once when the heroine runs through it', () => {
  const state = quiet(run());
  const before = state.player.squad;
  const gate = addObject(state, { kind: 'gate', x: 0, z: 0.3, value: 2 });
  advance(state, 0.5);
  assert.equal(state.player.squad, before + 2);
  assert.ok(!state.objects.includes(gate));
  assert.equal(since(state, 1).filter(e => e.kind === 'recruit').length, 1);
  advance(state, 2);
  assert.equal(state.player.squad, before + 2);
});

test('a gate in another lane drifts past without recruiting and is removed', () => {
  const state = quiet(run());
  const before = state.player.squad;
  addObject(state, { kind: 'gate', x: 3.4, z: 1 });
  advance(state, 3);
  assert.equal(state.player.squad, before);
  assert.equal(state.objects.length, 0);
});

test('a shot amplifier crate pays out power, echoes, charge and an event exactly once', () => {
  const state = quiet(run(), false);
  state.player.fireCooldown = 0;
  const crate = addObject(state, { kind: 'crate', x: 0, z: 12, health: 30, maxHealth: 30, value: 1, radius: 0.7, width: 0 });
  advance(state, 3);
  assert.ok(!state.objects.includes(crate));
  assert.equal(state.player.power, 1);
  assert.equal(state.echoes, ECONOMY.crate);
  assert.ok(state.player.charge > 0);
  assert.equal(since(state, 1).filter(e => e.kind === 'crate').length, 1);
  advance(state, 2);
  assert.equal(state.echoes, ECONOMY.crate);
});

test('weapon power from crates raises later shot damage', () => {
  const damage = (power: number): number => {
    const state = quiet(run(), false);
    state.player.power = power;
    state.player.fireCooldown = 0;
    tick(state, IDLE, STEP);
    return Math.max(...state.projectiles.filter(p => p.owner === 'player').map(p => p.damage));
  };
  assert.ok(damage(4) > damage(0));
});

// ---------------------------------------------------------------------------
// Encore: three heroine styles and the charge gate
// ---------------------------------------------------------------------------
test('Encore needs a full charge and spends it', () => {
  const state = quiet(run());
  state.player.charge = 99;
  tick(state, { move: 0, targetX: null, burst: true }, STEP);
  assert.ok(state.player.charge >= 99);
  assert.equal(since(state, 1).filter(e => e.kind === 'burst').length, 0);
  state.player.charge = 100;
  tick(state, { move: 0, targetX: null, burst: true }, STEP);
  assert.ok(state.player.charge < 5);
  assert.equal(since(state, 1).filter(e => e.kind === 'burst').length, 1);
  tick(state, { move: 0, targetX: null, burst: true }, STEP);
  assert.equal(since(state, 1).filter(e => e.kind === 'burst').length, 1, 'holding the button does not re-fire');
});

test('Mira’s Moonbreaker cuts a piercing column straight down her lane', () => {
  const state = quiet(run(1, 'mira'));
  const inLane = [10, 18, 26].map(z => addEnemy(state, { z, x: 0.3 }));
  const outside = addEnemy(state, { z: 12, x: 3.2 });
  state.player.charge = 100;
  tick(state, { move: 0, targetX: null, burst: true }, STEP);
  advance(state, 1);
  for (const enemy of inLane) assert.ok(enemy.health < 100, 'every enemy in the column is hit');
  assert.equal(outside.health, 100);
});

test('Rin’s Heartbreaker detonates across the lanes ahead of her', () => {
  const state = quiet(run(1, 'rin'));
  const near = addEnemy(state, { z: 8, x: -3 });
  const near2 = addEnemy(state, { z: 12, x: 3 });
  const far = addEnemy(state, { z: 44, x: 0 });
  state.player.charge = 100;
  tick(state, { move: 0, targetX: null, burst: true }, STEP);
  assert.ok(near.health < 100 && near2.health < 100, 'off-lane enemies are caught in the blast');
  assert.equal(far.health, 100);
});

test('Sera’s Velvet Requiem restores her shield and sweeps enemies back', () => {
  const state = quiet(run(1, 'sera'));
  state.player.shield = 0;
  const foe = addEnemy(state, { z: 6, x: 1 });
  state.player.charge = 100;
  tick(state, { move: 0, targetX: null, burst: true }, STEP);
  assert.ok(state.player.shield >= 30, `shield ${state.player.shield}`);
  assert.ok(foe.z >= 12, `swept back to ${foe.z}`);
  assert.ok(foe.health < 100);
});

test('battery raises Encore charge gain by exactly 25% per rank', () => {
  const gain = (rank: number): number => {
    const state = quiet(run());
    state.upgrades.battery = rank;
    addEnemy(state, { z: 10, health: 1e6, maxHealth: 1e6 });
    addShot(state);
    state.player.charge = 0;
    advance(state, 0.5);
    return state.player.charge;
  };
  const base = gain(0);
  assert.ok(base > 0);
  assert.ok(Math.abs(gain(2) / base - 1.5) < 1e-9);
});

test('Encore charge rises under fire and never drops except by spending it', () => {
  const state = quiet(run(), false);
  state.player.fireCooldown = 0;
  addEnemy(state, { z: 12, health: 1e9, maxHealth: 1e9 });
  let last = 0;
  for (let i = 0; i < 600; i++) {
    tick(state, IDLE, STEP);
    assert.ok(state.player.charge >= last);
    assert.ok(state.player.charge <= 100);
    last = state.player.charge;
  }
  assert.ok(last > 10);
});

// ---------------------------------------------------------------------------
// Upgrades: exact displayed numbers
// ---------------------------------------------------------------------------
function firstVolley(state: GameState): ProjectileState[] {
  state.player.fireCooldown = 0;
  tick(state, IDLE, STEP);
  return state.projectiles.filter(p => p.owner === 'player');
}

test('Heavy Reverb adds 20% weapon damage per rank', () => {
  const state = quiet(run(), false);
  take(state, 'overdrive');
  take(state, 'overdrive');
  const top = Math.max(...firstVolley(state).map(p => p.damage));
  assert.ok(Math.abs(top - 15 * 1.4) < 1e-9, `${top}`);
});

test('Double Time adds 15% fire rate per rank', () => {
  const volleys = (rank: number): number => {
    const state = quiet(run(), false);
    state.upgrades.rapid = rank;
    state.player.fireCooldown = 0;
    const mark = state.nextEventId;
    advance(state, 5);
    return since(state, mark).filter(e => e.kind === 'shot').length;
  };
  const base = volleys(0);
  const rapid = volleys(3);
  assert.ok(base >= 24 && base <= 25, `${base}`);
  assert.ok(Math.abs(rapid - 4.8 * 1.45 * 5) <= 1.5, `${rapid}`);
});

test('Crowd Pleaser adds one projectile per volley per rank', () => {
  const count = (rank: number): number => {
    const state = quiet(run(7, 'rin'), false);
    state.upgrades.scatter = rank;
    return firstVolley(state).filter(p => Math.abs(p.damage - getHero('rin').stats.damage) < 1e-9).length;
  };
  assert.equal(count(0), 3);
  assert.equal(count(2), 5);
});

test('Silver Needle pierces one more enemy per rank', () => {
  const pierce = (rank: number): number => {
    const state = quiet(run(), false);
    state.upgrades.pierce = rank;
    return Math.max(...firstVolley(state).map(p => p.pierce));
  };
  assert.equal(pierce(2) - pierce(0), 2);
});

test('Static Kiss chains one extra foe per rank for 35% of shot damage', () => {
  const state = quiet(run());
  state.upgrades.arc = 2;
  const target = addEnemy(state, { x: 0, z: 10 });
  const c1 = addEnemy(state, { x: 2.2, z: 10 });
  const c2 = addEnemy(state, { x: -2.2, z: 11 });
  const c3 = addEnemy(state, { x: 3.9, z: 12 });
  addShot(state, { chain: true });
  advance(state, 0.4);
  assert.equal(target.health, 85);
  assert.ok(Math.abs((100 - c1.health) - 15 * 0.35) < 1e-9);
  assert.ok(Math.abs((100 - c2.health) - 15 * 0.35) < 1e-9);
  assert.equal(c3.health, 100, 'only two chained foes at rank two');
});

test('Killer Chorus doubles about 10% of hits per rank', () => {
  const state = quiet(run());
  state.upgrades.critical = 3;
  const target = addEnemy(state, { health: 1e9, maxHealth: 1e9 });
  let crits = 0;
  const trials = 600;
  for (let i = 0; i < trials; i++) {
    const mark = state.nextEventId;
    addShot(state, { z: 9.8 });
    tick(state, IDLE, STEP);
    const hit = since(state, mark).find(e => e.kind === 'hit' && e.x === target.x);
    assert.ok(hit);
    if (hit.value === 30) crits++;
    else assert.equal(hit.value, 15);
  }
  assert.ok(crits / trials > 0.22 && crits / trials < 0.38, `crit rate ${crits / trials}`);
});

test('Broken Record releases one returning shard per rank from a kill', () => {
  const bystanderDamage = (rank: number): number => {
    const state = quiet(run());
    state.upgrades.ricochet = rank;
    addEnemy(state, { z: 10, health: 5, maxHealth: 5 });
    const bystander = addEnemy(state, { x: 3, z: 14 });
    addShot(state);
    advance(state, 1.5);
    return 100 - bystander.health;
  };
  assert.equal(bystanderDamage(0), 0);
  const one = bystanderDamage(1);
  assert.ok(one > 0, 'the shard seeks another foe');
  assert.ok(bystanderDamage(3) > one);
});

test('Lace Aegis adds 15 shield capacity and 15 shield per rank', () => {
  const state = quiet(run());
  take(state, 'barrier');
  assert.equal(state.player.shield, 15);
  take(state, 'barrier');
  assert.equal(state.player.shield, 30);
  addShot(state, { owner: 'enemy', x: 0, z: 0.8, vz: -9, damage: 20 });
  advance(state, 0.2);
  assert.equal(state.player.shield, 10);
  assert.equal(state.player.health, 100);
});

test('Sweet Requiem heals 3 health per rank every 6 seconds', () => {
  const state = quiet(run());
  state.regenTimer = 6;
  state.upgrades.repair = 2;
  state.player.health = 50;
  advance(state, 5.9);
  assert.equal(state.player.health, 50);
  advance(state, 0.2);
  assert.equal(state.player.health, 56);
  advance(state, 6);
  assert.equal(state.player.health, 62);
});

test('Ghost Fan Club recruits two fans now and one more per rank at gates', () => {
  const state = quiet(run());
  const before = state.player.squad;
  take(state, 'rally');
  assert.equal(state.player.squad, before + 2);
  addObject(state, { kind: 'gate', x: 0, z: 0.3, value: 2 });
  advance(state, 0.3);
  assert.equal(state.player.squad, before + 2 + 2 + 1);
});

test('Tip the Band raises kill Echoes by exactly 25% per rank without losing any', () => {
  const earned = (rank: number): number => {
    const state = quiet(run());
    state.upgrades.salvage = rank;
    for (let i = 0; i < 200; i++) {
      state.enemies = [];
      state.projectiles = [];
      addEnemy(state, { z: 10, health: 1, maxHealth: 1 });
      addShot(state);
      tick(state, IDLE, STEP);
    }
    assert.equal(state.kills, 200);
    return state.echoes;
  };
  assert.equal(earned(0), 200);
  assert.equal(earned(1), 250);
  assert.equal(earned(3), 350);
});

test('Tip the Band also raises amplifier crate Echoes', () => {
  const state = quiet(run(), false);
  state.upgrades.salvage = 2;
  state.player.fireCooldown = 0;
  addObject(state, { kind: 'crate', x: 0, z: 12, health: 30, maxHealth: 30, value: 1, radius: 0.7, width: 0 });
  advance(state, 3);
  assert.equal(state.echoes, Math.round(ECONOMY.crate * 1.5));
});

// ---------------------------------------------------------------------------
// Synergies
// ---------------------------------------------------------------------------
test('synergies activate only when both halves are owned and are announced once', () => {
  const state = quiet(run());
  assert.deepEqual(activeSynergies(state), []);
  take(state, 'pierce');
  assert.deepEqual(activeSynergies(state), []);
  const mark = state.nextEventId;
  take(state, 'arc');
  take(state, 'arc');
  assert.deepEqual(activeSynergies(state), ['thunder-rail']);
  take(state, 'scatter');
  take(state, 'ricochet');
  take(state, 'barrier');
  take(state, 'repair');
  assert.deepEqual(activeSynergies(state), ['thunder-rail', 'prism-barrage', 'guardian-choir']);
  assert.deepEqual(state.announcedSynergies, ['thunder-rail', 'prism-barrage', 'guardian-choir']);
  assert.equal(since(state, mark).filter(e => e.kind === 'synergy').length, 3);
});

test('Thunder Rail chains harder and to one more foe than Static Kiss alone', () => {
  const chained = (withPierce: boolean): number[] => {
    const state = quiet(run());
    state.upgrades.arc = 1;
    state.upgrades.pierce = withPierce ? 1 : 0;
    addEnemy(state, { x: 0, z: 10 });
    const side = [addEnemy(state, { x: 2.2, z: 10 }), addEnemy(state, { x: -2.4, z: 11 })];
    addShot(state, { chain: true });
    advance(state, 0.4);
    return side.map(e => 100 - e.health);
  };
  const alone = chained(false);
  const rail = chained(true);
  assert.ok(Math.abs(alone[0] - 15 * 0.35) < 1e-9);
  assert.equal(alone[1], 0);
  assert.ok(rail[0] > alone[0] + 2);
  assert.ok(rail[1] > 0, 'Thunder Rail reaches an extra foe');
});

test('Prism Barrage splits a hit into returning shards that damage other enemies', () => {
  const state = quiet(run(), false);
  state.upgrades.scatter = 1;
  state.upgrades.ricochet = 1;
  assert.ok(firstVolley(state).some(p => p.split), 'shots carry prisms once the synergy is active');
  const plain = quiet(run(), false);
  plain.upgrades.scatter = 1;
  assert.ok(!firstVolley(plain).some(p => p.split));

  const lab = quiet(run());
  lab.upgrades.scatter = 1;
  lab.upgrades.ricochet = 1;
  addEnemy(lab, { x: 0, z: 10, health: 1e6, maxHealth: 1e6 });
  const witness = addEnemy(lab, { x: 1.3, z: 12.5, health: 100, maxHealth: 100 });
  addShot(lab, { split: true });
  tick(lab, IDLE, STEP);
  const shards = lab.projectiles.filter(p => p.owner === 'player' && !p.split && p.damage < 15);
  assert.equal(shards.length, 2);
  assert.ok(shards[0].vx * shards[1].vx < 0, 'shards fly apart');
  advance(lab, 1);
  assert.ok(witness.health < 100);
});

test('Guardian Choir turns each repair pulse into shield for the squad', () => {
  const pulse = (barrier: number): { shield: number; health: number } => {
    const state = quiet(run());
    state.upgrades.repair = 2;
    state.upgrades.barrier = barrier;
    state.player.health = 50;
    state.regenTimer = 0.01;
    advance(state, 0.1);
    return { shield: state.player.shield, health: state.player.health };
  };
  const choir = pulse(1);
  assert.equal(choir.health, 56);
  assert.ok(choir.shield > 0 && choir.shield <= 15);
  assert.equal(pulse(0).shield, 0);
});

// ---------------------------------------------------------------------------
// Offers and choice points
// ---------------------------------------------------------------------------
test('upgrade offers appear at 24 and 48 seconds with three distinct eligible choices and pause combat', () => {
  const state = quiet(run(11));
  state.spawnTimer = 1e9;
  state.sectorTime = WORLD.choiceTimes[0] - 0.02;
  tick(state, IDLE, 0.05);
  assert.equal(state.phase, 'upgrade');
  assert.equal(state.offers.length, 3);
  assert.equal(new Set(state.offers).size, 3);
  const frozen = snapshot(state);
  tick(state, { move: 1, targetX: null, burst: true }, 0.05);
  assert.equal(snapshot(state), frozen, 'combat is paused while choosing');
  const pick = state.offers[1];
  assert.equal(chooseUpgrade(state, pick), true);
  assert.equal(state.upgrades[pick], 1);
  assert.equal(state.phase, 'combat');
  assert.deepEqual(state.offers, []);
  assert.equal(state.choicesTaken, 1);
  advance(state, 1);
  assert.equal(state.phase, 'combat', 'no second offer until the next choice time');
  state.sectorTime = WORLD.choiceTimes[1] - 0.02;
  tick(state, IDLE, 0.05);
  assert.equal(state.phase, 'upgrade');
});

test('offers skip capped upgrades and shrink to the remaining one or two', () => {
  for (const remaining of [2, 1]) {
    const state = quiet(run(11));
    UPGRADES.forEach((upgrade, index) => { state.upgrades[upgrade.id] = index < remaining ? upgrade.maxLevel - 1 : upgrade.maxLevel; });
    state.sectorTime = WORLD.choiceTimes[0] - 0.02;
    tick(state, IDLE, 0.05);
    assert.equal(state.phase, 'upgrade');
    assert.deepEqual([...state.offers].sort(), UPGRADES.slice(0, remaining).map(u => u.id).sort());
  }
});

test('when every upgrade is maxed the choice resolves into a heal and Echoes with no empty overlay', () => {
  const state = quiet(run(11));
  for (const upgrade of UPGRADES) state.upgrades[upgrade.id] = upgrade.maxLevel;
  state.player.health = 50;
  state.sectorTime = WORLD.choiceTimes[0] - 0.02;
  const mark = state.nextEventId;
  tick(state, IDLE, 0.05);
  assert.equal(state.phase, 'combat');
  assert.deepEqual(state.offers, []);
  assert.equal(state.player.health, 50 + ECONOMY.exhaustionHeal);
  assert.equal(state.echoes, ECONOMY.exhaustionReward);
  assert.equal(state.choicesTaken, 1);
  assert.equal(since(state, mark).filter(e => e.kind === 'reward').length, 1);
  advance(state, 2);
  assert.equal(state.echoes, ECONOMY.exhaustionReward);
});

test('invalid upgrade or route choices return false and change nothing', () => {
  const state = quiet(run(11));
  const before = snapshot(state);
  assert.equal(chooseUpgrade(state, 'rapid'), false, 'not in upgrade phase');
  assert.equal(chooseRoute(state, 'safe'), false, 'not in route phase');
  assert.equal(snapshot(state), before);
  state.sectorTime = WORLD.choiceTimes[0] - 0.02;
  tick(state, IDLE, 0.05);
  const missing = UPGRADES.map(u => u.id).find(id => !state.offers.includes(id));
  assert.ok(missing);
  const offered = snapshot(state);
  assert.equal(chooseUpgrade(state, missing), false);
  assert.equal(chooseUpgrade(state, 'bogus' as UpgradeId), false);
  assert.equal(chooseRoute(state, 'safe'), false);
  assert.equal(snapshot(state), offered);
  const routed = reachRoute();
  const atRoute = snapshot(routed);
  assert.equal(chooseRoute(routed, 'warp' as never), false);
  assert.equal(chooseUpgrade(routed, 'rapid'), false);
  assert.equal(snapshot(routed), atRoute);
});

// ---------------------------------------------------------------------------
// Bosses
// ---------------------------------------------------------------------------
test('each sector has exactly one boss with its own signature and a seeded modifier', () => {
  const seen = new Set<string>();
  for (let sector = 0; sector < SECTORS.length; sector++) {
    for (let seed = 1; seed <= 12; seed++) {
      const { state, boss } = spawnBoss(seed, sector);
      assert.equal(boss.pattern, SECTORS[sector].bossPattern);
      assert.ok(boss.modifier === 'haste' || boss.modifier === 'armored' || boss.modifier === 'volatile');
      assert.ok(boss.maxHealth > 300);
      seen.add(boss.modifier);
      advance(state, 10);
      assert.equal(state.enemies.filter(e => e.kind === 'boss').length, 1);
      assert.equal(since(state, 1).filter(e => e.kind === 'boss' && e.text === 'spawn').length, 1);
    }
  }
  assert.equal(seen.size, 3);
});

test('boss signatures telegraph before they land and expose a safe lane', () => {
  for (let sector = 0; sector < 3; sector++) {
    for (let seed = 1; seed <= 6; seed++) {
      const { state, boss } = spawnBoss(seed, sector);
      boss.health = boss.maxHealth = 1e7;
      let sawTelegraph = false;
      for (let i = 0; i < 60 * 25; i++) {
        tick(state, pilotAvoiding(state), STEP);
        for (const t of state.telegraphs) {
          sawTelegraph = true;
          assert.ok(t.duration >= 0.9, `warning of ${t.duration}s is long enough to react`);
        }
        const lanesCovered = new Set(state.telegraphs.filter(t => t.damage > 0 && t.kind === 'lane').map(t => Math.round(t.x * 10)));
        assert.ok(lanesCovered.size <= 4, 'at least one lane is always free');
      }
      assert.ok(sawTelegraph, `sector ${sector} seed ${seed} telegraphs`);
      assert.equal(state.player.health, state.player.maxHealth, `sector ${sector} seed ${seed}: avoidable`);
    }
  }
});

function pilotAvoiding(state: GameState): Input {
  const input = pilot(state);
  return { move: 0, targetX: input.targetX, burst: false };
}

test('standing still in the boss’s line gets the heroine hurt', () => {
  for (let sector = 0; sector < 3; sector++) {
    let hurt = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const { state, boss } = spawnBoss(seed, sector);
      boss.health = boss.maxHealth = 1e7;
      state.player.health = state.player.maxHealth = 1e6;
      const mark = state.nextEventId;
      advance(state, 25);
      if (since(state, mark).some(e => e.kind === 'damage')) hurt++;
    }
    assert.ok(hurt >= 4, `sector ${sector}: standing still hurt in ${hurt}/6 runs`);
  }
});

test('boss and sector rewards pay once, then the run waits for a route', () => {
  const { state, boss } = spawnBoss(3, 0);
  killBoss(state, boss);
  assert.equal(state.phase, 'route');
  assert.equal(state.echoes, ECONOMY.sectorClear);
  assert.equal(state.enemies.length, 0);
  assert.equal(since(state, 1).filter(e => e.kind === 'boss' && e.text === 'defeat').length, 1);
  const frozen = snapshot(state);
  for (let i = 0; i < 120; i++) tick(state, { move: 1, targetX: null, burst: true }, STEP);
  assert.equal(snapshot(state), frozen);
});

test('armored bosses shrug off damage that a plain boss takes in full', () => {
  const damageTaken = (modifier: EnemyState['modifier']): number => {
    const { state, boss } = spawnBoss(3, 0);
    boss.modifier = modifier;
    boss.health = boss.maxHealth = 1e6;
    state.projectiles = [];
    state.telegraphs = [];
    addShot(state, { x: boss.x, z: boss.z - 0.5, damage: 20 });
    tick(state, IDLE, STEP);
    return 1e6 - boss.health;
  };
  assert.equal(damageTaken('haste'), 20);
  assert.ok(damageTaken('armored') < 20 && damageTaken('armored') > 10);
});

test('the final campaign boss ends the run in victory with the campaign bonus', () => {
  const { state, boss } = spawnBoss(3, 2);
  killBoss(state, boss);
  assert.equal(state.phase, 'victory');
  assert.equal(state.echoes, ECONOMY.sectorClear + ECONOMY.campaignWin);
  assert.equal(since(state, 1).filter(e => e.kind === 'victory').length, 1);
  assert.equal(chooseRoute(state, 'safe'), false);
  const frozen = snapshot(state);
  advance(state, 3, { move: 1, targetX: null, burst: true });
  assert.equal(snapshot(state), frozen);
});

test('an Encore that wins the final boss ends the substep: no further shots, spawns or rewards', () => {
  const { state, boss } = spawnBoss(3, 2, 'campaign', 'rin');
  boss.health = 1;
  boss.z = 8;
  boss.attackTimer = 1e9;
  state.player.charge = 100;
  state.player.fireCooldown = 0;
  state.objectTimer = 0;
  const mark = state.nextEventId;
  tick(state, { move: 1, targetX: null, burst: true }, STEP);
  assert.equal(state.phase, 'victory');
  assert.equal(state.echoes, ECONOMY.sectorClear + ECONOMY.campaignWin);
  assert.equal(state.player.x, 0, 'the heroine does not keep steering after the win');
  assert.equal(state.projectiles.length, 0);
  assert.equal(state.objects.length, 0);
  assert.equal(state.enemies.length, 0);
  const kinds = since(state, mark).map(e => e.kind);
  assert.ok(!kinds.includes('shot'), 'no volley fires after victory');
  assert.equal(kinds.filter(k => k === 'victory').length, 1);
});

test('a lethal telegraph ends the substep: a gate under the heroine is not collected after defeat', () => {
  const state = quiet(run(5));
  state.player.health = 1;
  state.player.squad = 2;
  state.telegraphs.push({ id: state.nextEntityId++, x: 0, z: 0, width: 2, depth: 2, remaining: 0.001, duration: 1, damage: 20, kind: 'lane' });
  addObject(state, { x: 0, z: 0.2 });
  const score = state.score;
  const mark = state.nextEventId;
  tick(state, IDLE, STEP);
  assert.equal(state.phase, 'defeat');
  assert.equal(state.player.squad, 2);
  assert.equal(state.objects.length, 1, 'the gate stays untouched');
  assert.equal(state.score, score);
  assert.ok(!since(state, mark).some(e => e.kind === 'recruit'));
});

test('a lethal first warning leaves later warnings exactly as they were', () => {
  const state = quiet(run(5));
  state.player.health = 1;
  const lane = (remaining: number) => ({ id: state.nextEntityId++, x: 0, z: 0, width: 2, depth: 2, remaining, duration: 1, damage: 20, kind: 'lane' as const });
  const first = lane(0.001);
  const second = lane(0.001);
  const third = lane(0.5);
  state.telegraphs.push(first, second, third);
  tick(state, IDLE, STEP);
  assert.equal(state.phase, 'defeat');
  assert.deepEqual(state.telegraphs.map(t => [t.id, t.remaining]), [[second.id, 0.001], [third.id, 0.5]], 'only the lethal warning resolved');
  assert.equal(since(state, 1).filter(e => e.kind === 'damage').length, 1);
});

test('a lethal first contact leaves other overlapping enemies where they are', () => {
  const state = quiet(run(5));
  state.player.health = 1;
  const a = addEnemy(state, { x: 0, z: 0.3, damage: 10 });
  const b = addEnemy(state, { x: 0.1, z: 0.3, damage: 10 });
  tick(state, IDLE, STEP);
  assert.equal(state.phase, 'defeat');
  assert.ok(!state.enemies.includes(a), 'the lethal contact is consumed');
  assert.deepEqual(state.enemies.map(e => e.id), [b.id], 'the second enemy is untouched');
  assert.equal(since(state, 1).filter(e => e.kind === 'damage').length, 1);
});

test('survival never ends at the third boss; it routes into harder cycled sectors', () => {
  const { state, boss } = spawnBoss(3, 2, 'survival');
  killBoss(state, boss);
  assert.equal(state.phase, 'route');
  assert.equal(chooseRoute(state, 'safe'), true);
  assert.equal(state.sector, 3);
  assert.equal(state.phase, 'combat');
  const next = spawnBoss(3, 3, 'survival').boss;
  const first = spawnBoss(3, 0, 'survival').boss;
  assert.equal(next.pattern, first.pattern, 'sector themes cycle');
  assert.ok(next.maxHealth > first.maxHealth, 'survival scales without a ceiling');
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
test('Safe Passage heals, Salvage Run pays Echoes, and both start the next sector clean', () => {
  const safe = reachRoute();
  safe.player.health = 50;
  assert.ok(chooseRoute(safe, 'safe'));
  assert.equal(safe.player.health, 50 + ECONOMY.safeHeal);
  const salvage = reachRoute();
  const before = salvage.echoes;
  assert.ok(chooseRoute(salvage, 'salvage'));
  assert.equal(salvage.echoes, before + ECONOMY.salvageRoute);
  for (const state of [safe, salvage]) {
    assert.equal(state.sector, 1);
    assert.equal(state.sectorTime, 0);
    assert.equal(state.phase, 'combat');
    assert.equal(state.bossSpawned, false);
    assert.equal(state.choicesTaken, 0);
    assert.equal(state.enemies.length + state.telegraphs.length + state.projectiles.length, 0);
    advance(state, 3);
    assert.ok(state.elapsed > 0 && state.sectorTime > 2.9);
    assert.ok(state.events.length <= LIMITS.events);
  }
});

test('Redline toughens the next sector’s enemies and multiplies its rewards', () => {
  const firstPlush = (route: 'safe' | 'redline'): { health: number; state: GameState } => {
    const state = reachRoute();
    chooseRoute(state, route);
    for (let i = 0; i < 60 * 10 && !state.enemies.some(e => e.kind === 'plush'); i++) tick(state, IDLE, STEP);
    const plush = state.enemies.find(e => e.kind === 'plush');
    assert.ok(plush);
    return { health: plush.maxHealth, state };
  };
  const safe = firstPlush('safe');
  const red = firstPlush('redline');
  assert.ok(Math.abs(red.health / safe.health - ECONOMY.redlineHealth) < 1e-9);
  assert.equal(red.state.rewardMultiplier, ECONOMY.redlineRewards);
  assert.equal(safe.state.rewardMultiplier, 1);

  const reward = (route: 'safe' | 'redline'): number => {
    const state = reachRoute();
    chooseRoute(state, route);
    state.choicesTaken = 2;
    state.sectorTime = WORLD.sectorSeconds - 0.01;
    quiet(state);
    tick(state, IDLE, 0.05);
    const boss = state.enemies.find(e => e.kind === 'boss') as EnemyState;
    const before = state.echoes;
    killBoss(state, boss);
    return state.echoes - before;
  };
  assert.equal(reward('safe'), ECONOMY.sectorClear);
  assert.equal(reward('redline'), ECONOMY.sectorClear * ECONOMY.redlineRewards);
});

// ---------------------------------------------------------------------------
// End-to-end simulation with the human-shaped pilot and real choices
// ---------------------------------------------------------------------------
test('a normal pilot with real upgrade choices clears the campaign and sees every encounter type', () => {
  const result = playthrough(1, 'mira', 'campaign', () => false);
  assert.equal(result.state.phase, 'victory', `ended ${result.state.phase} in sector ${result.state.sector} at ${result.state.elapsed.toFixed(1)}s`);
  assert.equal(result.sectorsCleared, 2, 'two route choices separate the three sectors');
  assert.ok((result.routeEchoes ?? 0) >= ECONOMY.sectorClear, 'the first sector pays at least the clear bonus');
  for (const kind of ['plush', 'carriage', 'wraith', 'boss']) assert.ok(result.kinds.has(kind), `saw ${kind}`);
  assert.ok(result.objectKinds.has('gate') && result.objectKinds.has('crate'));
  assert.ok(result.sideCrate, 'a crate sits in a risky side lane');
  assert.ok(result.enemyFire, 'wraiths fire');
  assert.equal(result.state.choicesTaken, 2);
  const total = result.state.elapsed;
  assert.ok(total > 3 * WORLD.sectorSeconds && total < 3 * (WORLD.sectorSeconds + 60), `campaign took ${total}s`);
});

test('every heroine can win a campaign with the same pilot on at least one seed', () => {
  for (const hero of ['mira', 'rin', 'sera'] as const) {
    const won = [2, 3, 4].some(seed => playthrough(seed, hero, 'campaign', () => false).state.phase === 'victory');
    assert.ok(won, `${hero} wins`);
  }
});

test('survival keeps advancing past the campaign length without ending or blocking', () => {
  const result = playthrough(2, 'mira', 'survival', s => s.sector >= 4 && s.sectorTime > 5);
  assert.equal(result.state.phase, 'combat');
  assert.ok(result.state.sector >= 4);
  assert.ok(result.sectorsCleared >= 4);
});

test('entity counts, telegraphs and the event log stay bounded and monotonic over long runs', () => {
  for (const [seed, mode] of [[2, 'survival'], [3, 'campaign']] as const) {
    const result = playthrough(seed, seed === 2 ? 'mira' : 'sera', mode, () => false, 500);
    assert.ok(result.state.elapsed > 100);
    assert.ok(result.maxEnemies <= LIMITS.enemies, `enemies ${result.maxEnemies}`);
    assert.ok(result.maxProjectiles <= LIMITS.projectiles, `projectiles ${result.maxProjectiles}`);
    assert.ok(result.maxObjects <= LIMITS.objects);
    assert.ok(result.maxTelegraphs <= LIMITS.telegraphs);
    assert.ok(result.maxEvents <= LIMITS.events);
    assert.ok(result.eventsMonotonic);
    const ids = result.state.events.map(e => e.id);
    assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
    assert.equal(new Set(ids).size, ids.length);
  }
});
