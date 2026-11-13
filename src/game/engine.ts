// Deterministic Gravewave simulation. Pure TypeScript: no DOM, storage, clock or Math.random.
//
// Coordinates: x in [-WORLD.halfWidth, WORLD.halfWidth], z grows ahead of the heroine, who stands at z = 0.
// Everything hostile moves toward z = 0. Rendering and UI read the state; they never write to it.
//
// State conventions the renderer and tests may rely on:
//  - events carry ids starting at 1; the array keeps the newest LIMITS.events entries; consumers remember the
//    last id they handled.
//  - choicesTaken counts the choice points already resolved in the current sector (0..2).
//  - spawnTimer, objectTimer, regenTimer and player.fireCooldown count down in seconds.
//  - echoes is the run's earned currency; settlement belongs to progression.
import { ECONOMY, LIMITS, SECTORS, UPGRADES, WORLD, getHero, getSector, getSkin } from './catalog.ts';
import type {
  ActiveSynergies, BossPattern, ChooseRoute, ChooseUpgrade, CreateRun, EnemyState, EventKind, GameState, HeroId, Input,
  ProjectileState, RouteId, SynergyId, Telegraph, Tick, UpgradeId,
} from './types.ts';

const MAX_FRAME = 0.1;
const SUBSTEP = 1 / 60;
const LANES: readonly number[] = [-3.6, -1.8, 0, 1.8, 3.6];
const PLAYER_RADIUS = 0.4;
const INVULNERABLE_SECONDS = 0.9;
const TARGET_STEER_SPEED = 1.6;
const START_SQUAD = 2;
const MAX_SQUAD = 24;
const MAX_POWER = 12;
const REPAIR_PERIOD = 6;
const OBJECT_SPEED = 4.2;
const BOSS_SPAWN_Z = 32;
const BOSS_HOLD_Z = 15;
const FAN_CONVERGE_Z = 14;
const MIRROR_TINT = '#ff4f78';

const ENEMY_DEFS = {
  plush: { health: 24, speed: 4.4, radius: 0.55, damage: 10, charge: 3, score: 100 },
  carriage: { health: 110, speed: 2.8, radius: 0.95, damage: 18, charge: 6, score: 250 },
  wraith: { health: 16, speed: 2.6, radius: 0.5, damage: 8, charge: 4, score: 150 },
} as const;
type WaveEnemy = keyof typeof ENEMY_DEFS;

const SYNERGIES: ReadonlyArray<readonly [SynergyId, UpgradeId, UpgradeId]> = [
  ['thunder-rail', 'pierce', 'arc'],
  ['prism-barrage', 'scatter', 'ricochet'],
  ['guardian-choir', 'barrier', 'repair'],
];
const MODIFIERS = ['haste', 'armored', 'volatile'] as const;
const ROUTES: readonly RouteId[] = ['safe', 'redline', 'salvage'];

// --------------------------------------------------------------------------------------------------------------
// Small helpers
// --------------------------------------------------------------------------------------------------------------
function rand(s: GameState): number {
  s.rng = (s.rng + 0x6d2b79f5) >>> 0;
  let t = s.rng;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function randInt(s: GameState, n: number): number {
  return Math.min(n - 1, Math.floor(rand(s) * n));
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

function removeItem<T>(list: T[], item: T): void {
  const index = list.indexOf(item);
  if (index >= 0) list.splice(index, 1);
}

function emit(s: GameState, kind: EventKind, x: number, z: number, value: number, text?: string): void {
  const event = text === undefined ? { id: s.nextEventId++, kind, x, z, value } : { id: s.nextEventId++, kind, x, z, value, text };
  s.events.push(event);
  if (s.events.length > LIMITS.events) s.events.splice(0, s.events.length - LIMITS.events);
}

function shuffled<T>(s: GameState, items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = randInt(s, i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function pickWeighted<T>(s: GameState, items: ReadonlyArray<readonly [T, number]>): T {
  let total = 0;
  for (const [, weight] of items) total += weight;
  let roll = rand(s) * total;
  for (const [item, weight] of items) {
    roll -= weight;
    if (roll < 0) return item;
  }
  return items[items.length - 1][0];
}

function healthScale(s: GameState): number {
  return (1 + 0.18 * s.sector) * s.enemyMultiplier;
}

function damageScale(s: GameState): number {
  return 1 + 0.05 * s.sector;
}

function shieldCapacity(s: GameState): number {
  return 15 * s.upgrades.barrier + (s.hero === 'sera' ? 30 : 0);
}

function echoMultiplier(s: GameState): number {
  return s.rewardMultiplier * (1 + 0.25 * s.upgrades.salvage);
}

function shotDamage(s: GameState): number {
  return getHero(s.hero).stats.damage * (1 + 0.2 * s.upgrades.overdrive) * (1 + 0.06 * s.player.power);
}

function playerTint(hero: HeroId): string {
  return getSkin(`${hero}-default`).palette.projectile;
}

function gainCharge(s: GameState, amount: number): void {
  s.player.charge = Math.min(100, s.player.charge + amount * (1 + 0.25 * s.upgrades.battery));
}

export const activeSynergies: ActiveSynergies = state => {
  const active: SynergyId[] = [];
  for (const [id, a, b] of SYNERGIES) if (state.upgrades[a] > 0 && state.upgrades[b] > 0) active.push(id);
  return active;
};

function hasSynergy(s: GameState, id: SynergyId): boolean {
  return activeSynergies(s).includes(id);
}

function addProjectile(s: GameState, shot: Omit<ProjectileState, 'id'>): ProjectileState | null {
  if (s.projectiles.length >= LIMITS.projectiles) return null;
  const projectile: ProjectileState = { id: s.nextEntityId++, ...shot };
  s.projectiles.push(projectile);
  return projectile;
}

function addTelegraph(s: GameState, telegraph: Omit<Telegraph, 'id' | 'remaining'>): void {
  if (s.telegraphs.length >= LIMITS.telegraphs) return;
  s.telegraphs.push({ id: s.nextEntityId++, remaining: telegraph.duration, ...telegraph });
}

function enemyOrb(s: GameState, x: number, z: number, vx: number, vz: number, damage: number, life: number): void {
  addProjectile(s, { owner: 'enemy', x, z, vx, vz, damage, radius: 0.3, pierce: 0, life, hitIds: [], tint: MIRROR_TINT, chain: false, split: false });
}

// --------------------------------------------------------------------------------------------------------------
// Player damage
// --------------------------------------------------------------------------------------------------------------
function damagePlayer(s: GameState, amount: number, x: number, z: number): void {
  const player = s.player;
  if (s.phase !== 'combat' || player.invulnerableFor > 0 || amount <= 0) return;
  player.invulnerableFor = INVULNERABLE_SECONDS;
  const absorbed = Math.min(player.shield, amount);
  player.shield -= absorbed;
  const through = amount - absorbed;
  player.health -= through;
  emit(s, 'damage', x, z, amount);
  if (player.health <= 0) {
    player.health = 0;
    s.phase = 'defeat';
    emit(s, 'defeat', player.x, 0, s.score);
  }
}

// --------------------------------------------------------------------------------------------------------------
// Run creation
// --------------------------------------------------------------------------------------------------------------
export const createRun: CreateRun = (seed, heroId, mode, runId) => {
  const hero = getHero(heroId);
  if (mode !== 'campaign' && mode !== 'survival') throw new RangeError(`Unknown mode: ${String(mode)}`);
  if (typeof runId !== 'string' || runId.length === 0) throw new RangeError('A run needs a nonempty run ID.');
  const normalized = Number.isFinite(seed) ? Math.trunc(seed) >>> 0 : 0;
  const upgrades = {} as Record<UpgradeId, number>;
  for (const upgrade of UPGRADES) upgrades[upgrade.id] = 0;
  return {
    runId,
    seed: normalized,
    rng: (normalized ^ 0x9e3779b9) >>> 0,
    mode,
    hero: hero.id,
    phase: 'combat',
    sector: 0,
    elapsed: 0,
    sectorTime: 0,
    player: {
      x: 0, health: hero.stats.health, maxHealth: hero.stats.health, shield: hero.id === 'sera' ? 15 : 0, squad: START_SQUAD,
      power: 0, charge: 0, fireCooldown: 0.3, invulnerableFor: 0,
    },
    score: 0,
    kills: 0,
    echoes: 0,
    upgrades,
    offers: [],
    enemies: [],
    projectiles: [],
    objects: [],
    telegraphs: [],
    events: [],
    nextEntityId: 1,
    nextEventId: 1,
    spawnTimer: 1.2,
    objectTimer: 3.5,
    regenTimer: REPAIR_PERIOD,
    choicesTaken: 0,
    bossSpawned: false,
    rewardMultiplier: 1,
    enemyMultiplier: 1,
    announcedSynergies: [],
  };
};

// --------------------------------------------------------------------------------------------------------------
// Encounters
// --------------------------------------------------------------------------------------------------------------
function spawnEnemy(s: GameState, kind: WaveEnemy, x: number, z: number): EnemyState | null {
  if (s.enemies.length >= LIMITS.enemies) return null;
  const def = ENEMY_DEFS[kind];
  const health = def.health * healthScale(s);
  const enemy: EnemyState = {
    id: s.nextEntityId++, kind, x: clamp(x, -WORLD.halfWidth, WORLD.halfWidth), z, health, maxHealth: health,
    speed: def.speed * (0.92 + rand(s) * 0.16), radius: def.radius, damage: def.damage * damageScale(s),
    attackTimer: kind === 'wraith' ? 2.5 + rand(s) * 2 : 1e9, pattern: null, attackStep: 0, modifier: null,
  };
  s.enemies.push(enemy);
  return enemy;
}

function spawnWave(s: GameState): void {
  const t = s.sectorTime;
  const options: Array<readonly [string, number]> = [['swarm', 4], ['column', 3]];
  if (t > 8) options.push(['pincer', 2]);
  if (t > 12) options.push(['wraith', 2]);
  if (t > 16) options.push(['carriage', 2]);
  const lanes = shuffled(s, LANES);
  const z = WORLD.spawnDistance;
  switch (pickWeighted(s, options)) {
    case 'swarm': {
      const count = 2 + (t > 30 || s.sector > 0 ? 1 : 0) + (rand(s) < 0.35 ? 1 : 0);
      for (let i = 0; i < Math.min(3, count); i++) spawnEnemy(s, 'plush', lanes[i] + (rand(s) - 0.5) * 0.3, z + rand(s) * 3);
      break;
    }
    case 'column': {
      const count = 3 + (t > 40 ? 1 : 0);
      for (let i = 0; i < count; i++) spawnEnemy(s, 'plush', lanes[0], z + i * 2.4);
      break;
    }
    case 'pincer':
      spawnEnemy(s, 'plush', -3.6, z);
      spawnEnemy(s, 'plush', 3.6, z);
      spawnEnemy(s, 'plush', rand(s) < 0.5 ? -1.8 : 1.8, z + 3);
      break;
    case 'wraith':
      spawnEnemy(s, 'wraith', lanes[0], z - 2);
      spawnEnemy(s, 'plush', lanes[1], z);
      spawnEnemy(s, 'plush', lanes[2], z + 2.5);
      break;
    default:
      spawnEnemy(s, 'carriage', lanes[0], z);
      if (t > 30) {
        spawnEnemy(s, 'plush', lanes[1], z + 3);
        spawnEnemy(s, 'plush', lanes[2], z + 4.5);
      }
      break;
  }
  const base = Math.max(1.0, 2.4 - 0.014 * t);
  s.spawnTimer = (base * (0.85 + 0.3 * rand(s))) / (1 + 0.04 * s.sector);
}

function spawnObject(s: GameState): void {
  s.objectTimer = 5 + rand(s) * 3;
  if (s.objects.length >= LIMITS.objects) return;
  if (rand(s) < 0.55) {
    const x = LANES[1 + randInt(s, 3)];
    s.objects.push({ id: s.nextEntityId++, kind: 'gate', x, z: WORLD.spawnDistance, health: 1, maxHealth: 1, value: 2, radius: 0.9, width: 1.7 });
    return;
  }
  const side = rand(s) < 0.6;
  const lane = side ? (rand(s) < 0.5 ? -3.6 : 3.6) : LANES[1 + randInt(s, 3)];
  const health = 26 + 6 * s.sector;
  s.objects.push({ id: s.nextEntityId++, kind: 'crate', x: lane, z: WORLD.spawnDistance, health, maxHealth: health, value: side ? 2 : 1, radius: 0.7, width: 0 });
  if (side && !s.bossSpawned) {
    spawnEnemy(s, 'plush', lane, WORLD.spawnDistance + 4);
    spawnEnemy(s, 'plush', lane, WORLD.spawnDistance + 6.4);
  }
}

function bossMaxHealth(s: GameState): number {
  return (520 + 130 * (s.sector % SECTORS.length)) * (1 + 0.22 * s.sector) * s.enemyMultiplier;
}

function spawnBoss(s: GameState): void {
  const sector = getSector(s.sector);
  const health = bossMaxHealth(s);
  const modifier = MODIFIERS[randInt(s, MODIFIERS.length)];
  const boss: EnemyState = {
    id: s.nextEntityId++, kind: 'boss', x: 0, z: BOSS_SPAWN_Z, health, maxHealth: health, speed: 6, radius: 1.6, damage: 0,
    attackTimer: 2.2, pattern: sector.bossPattern, attackStep: 0, modifier,
  };
  s.enemies.push(boss);
  s.bossSpawned = true;
  emit(s, 'boss', boss.x, boss.z, boss.id, 'spawn');
}

// --------------------------------------------------------------------------------------------------------------
// Boss signatures. Every attack is announced by telegraphs and always leaves a lane without danger.
// --------------------------------------------------------------------------------------------------------------
function bossInterval(pattern: BossPattern | null, boss: EnemyState): number {
  const base = pattern === 'sweep' ? 5.2 : pattern === 'crossfire' ? 4.6 : 4.2;
  return base * (boss.modifier === 'haste' ? 0.78 : 1) * (boss.health < boss.maxHealth * 0.5 ? 0.85 : 1);
}

function bossAttack(s: GameState, boss: EnemyState): void {
  const haste = boss.modifier === 'haste';
  const damage = 16 * damageScale(s);
  emit(s, 'boss', boss.x, boss.z, boss.attackStep, 'telegraph');
  if (boss.pattern === 'lanes') {
    const slams = boss.health < boss.maxHealth * 0.5 ? 3 : 2;
    for (const lane of shuffled(s, LANES).slice(0, slams)) {
      addTelegraph(s, { x: lane, z: 7, width: 1.6, depth: 16, duration: haste ? 1.15 : 1.5, damage, kind: 'lane' });
    }
  } else if (boss.pattern === 'sweep') {
    const forward = rand(s) < 0.5;
    const gap = randInt(s, LANES.length);
    const first = haste ? 1.15 : 1.5;
    const step = haste ? 0.24 : 0.3;
    for (let k = 0; k < LANES.length; k++) {
      const index = forward ? k : LANES.length - 1 - k;
      if (index === gap) continue;
      addTelegraph(s, { x: LANES[index], z: 7, width: 1.6, depth: 16, duration: first + k * step, damage, kind: 'lane' });
    }
  } else if (boss.pattern === 'crossfire') {
    const safe = randInt(s, LANES.length);
    const flight = haste ? 1.35 : 1.7;
    LANES.forEach((target, index) => {
      if (index === safe) return;
      const source = target > 0.5 ? -WORLD.halfWidth : target < -0.5 ? WORLD.halfWidth : rand(s) < 0.5 ? -WORLD.halfWidth : WORLD.halfWidth;
      enemyOrb(s, source, 15, (target - source) / flight, -15 / flight, 10 * damageScale(s), flight + 1.5);
      addTelegraph(s, { x: target, z: 3, width: 1.1, depth: 6, duration: flight, damage: 0, kind: 'lane' });
    });
  }
  if (boss.modifier === 'volatile') {
    addTelegraph(s, { x: s.player.x, z: 0, width: 1.8, depth: 2.4, duration: haste ? 1.1 : 1.3, damage: 12 * damageScale(s), kind: 'blast' });
  }
}

function updateBoss(s: GameState, boss: EnemyState, h: number): void {
  if (boss.z > BOSS_HOLD_Z) {
    boss.z = Math.max(BOSS_HOLD_Z, boss.z - boss.speed * h);
    return;
  }
  let target = s.player.x;
  if (boss.pattern === 'sweep') {
    let soonest: Telegraph | undefined;
    for (const t of s.telegraphs) if (t.kind === 'lane' && t.damage > 0 && (!soonest || t.remaining < soonest.remaining)) soonest = t;
    if (soonest) target = soonest.x;
  }
  const speed = (boss.pattern === 'sweep' ? 6 : 2.4) * (boss.modifier === 'haste' ? 1.3 : 1);
  boss.x += clamp(target - boss.x, -speed * h, speed * h);
  boss.attackTimer -= h;
  if (boss.attackTimer <= 0) {
    bossAttack(s, boss);
    boss.attackStep++;
    boss.attackTimer = bossInterval(boss.pattern, boss);
  }
}

function updateWraith(s: GameState, enemy: EnemyState, h: number): void {
  const hold = 12 + (enemy.id % 4);
  enemy.z -= (enemy.z > hold ? enemy.speed : 0.7) * h;
  enemy.attackTimer -= h;
  if (enemy.attackStep === 0 && enemy.attackTimer <= 0.7 && enemy.z < WORLD.spawnDistance - 4) {
    addTelegraph(s, { x: enemy.x, z: enemy.z / 2, width: 0.9, depth: enemy.z + 1, duration: 0.7, damage: 0, kind: 'lane' });
    enemy.attackStep = 1;
  } else if (enemy.attackStep === 1 && enemy.attackTimer <= 0) {
    enemyOrb(s, enemy.x, enemy.z, 0, -9.5, enemy.damage, 4);
    enemy.attackStep = 0;
    enemy.attackTimer = 3.4 + rand(s) * 1.8;
  }
}

// --------------------------------------------------------------------------------------------------------------
// Combat resolution
// --------------------------------------------------------------------------------------------------------------
function dealDamage(s: GameState, enemy: EnemyState, raw: number, text?: string): number {
  const dealt = enemy.kind === 'boss' && enemy.modifier === 'armored' ? raw * 0.75 : raw;
  enemy.health -= dealt;
  emit(s, 'hit', enemy.x, enemy.z, dealt, text);
  return dealt;
}

function chainFrom(s: GameState, shot: ProjectileState, from: EnemyState): void {
  const rail = hasSynergy(s, 'thunder-rail');
  const links = s.upgrades.arc + (s.hero === 'sera' ? 1 : 0) + (rail ? 1 : 0);
  if (links <= 0) return;
  const reach = rail ? 7 : 5.5;
  const ratio = rail ? 0.6 : 0.35;
  const candidates = s.enemies
    .filter(e => e.health > 0 && e.id !== from.id && !shot.hitIds.includes(e.id))
    .map(e => ({ e, d: Math.hypot(e.x - from.x, e.z - from.z) }))
    .filter(c => c.d <= reach)
    .sort((a, b) => a.d - b.d || a.e.id - b.e.id);
  for (const { e } of candidates.slice(0, links)) dealDamage(s, e, shot.damage * ratio);
}

function splitShot(s: GameState, shot: ProjectileState, at: EnemyState): void {
  const speed = Math.hypot(shot.vx, shot.vz) * 0.8 || 20;
  for (const side of [-1, 1]) {
    const angle = 0.45 * side;
    addProjectile(s, {
      owner: 'player', x: at.x, z: at.z, vx: Math.sin(angle) * speed, vz: Math.cos(angle) * speed, damage: shot.damage * 0.4, radius: 0.16, pierce: 0,
      life: 1.2, hitIds: [at.id], tint: shot.tint, chain: false, split: false,
    });
  }
}

function hitEnemy(s: GameState, shot: ProjectileState, enemy: EnemyState): void {
  const critChance = 0.1 * s.upgrades.critical;
  const crit = critChance > 0 && rand(s) < critChance;
  dealDamage(s, enemy, crit ? shot.damage * 2 : shot.damage, crit ? 'crit' : undefined);
  gainCharge(s, 0.25);
  if (shot.chain) chainFrom(s, shot, enemy);
  if (shot.split) {
    shot.split = false;
    splitShot(s, shot, enemy);
  }
}

function releaseShards(s: GameState, dead: EnemyState): void {
  const count = s.upgrades.ricochet;
  if (count <= 0) return;
  const prism = hasSynergy(s, 'prism-barrage');
  let nearest: EnemyState | null = null;
  let best = Infinity;
  for (const e of s.enemies) {
    if (e.health <= 0 || e.id === dead.id) continue;
    const d = Math.hypot(e.x - dead.x, e.z - dead.z);
    if (d < best) { best = d; nearest = e; }
  }
  const tx = nearest ? nearest.x : s.player.x;
  const tz = nearest ? nearest.z : 0;
  const length = Math.hypot(tx - dead.x, tz - dead.z) || 1;
  for (let i = 0; i < count; i++) {
    const spread = (i - (count - 1) / 2) * 0.12;
    const dx = (tx - dead.x) / length;
    const dz = (tz - dead.z) / length;
    const speed = 22;
    addProjectile(s, {
      owner: 'player', x: dead.x, z: dead.z, vx: (dx * Math.cos(spread) - dz * Math.sin(spread)) * speed,
      vz: (dz * Math.cos(spread) + dx * Math.sin(spread)) * speed, damage: shotDamage(s) * 0.5, radius: 0.2, pierce: 0, life: 1.6,
      hitIds: [dead.id], tint: playerTint(s.hero), chain: false, split: prism,
    });
  }
}

function clearArena(s: GameState, objects: boolean): void {
  s.enemies.length = 0;
  s.projectiles.length = 0;
  s.telegraphs.length = 0;
  if (objects) s.objects.length = 0;
}

function bossDefeated(s: GameState, boss: EnemyState): void {
  s.kills++;
  s.score += 2000;
  const reward = Math.round(ECONOMY.sectorClear * s.rewardMultiplier);
  s.echoes += reward;
  emit(s, 'boss', boss.x, boss.z, boss.id, 'defeat');
  emit(s, 'reward', boss.x, boss.z, reward, 'sector');
  clearArena(s, true);
  if (s.mode === 'campaign' && s.sector >= SECTORS.length - 1) {
    s.echoes += ECONOMY.campaignWin;
    s.phase = 'victory';
    emit(s, 'victory', s.player.x, 0, s.score);
  } else {
    s.phase = 'route';
  }
}

function killEnemy(s: GameState, enemy: EnemyState): void {
  if (enemy.kind === 'boss') {
    bossDefeated(s, enemy);
    return;
  }
  removeItem(s.enemies, enemy);
  s.kills++;
  const m = echoMultiplier(s);
  s.echoes += Math.floor(s.kills * m) - Math.floor((s.kills - 1) * m);
  const def = ENEMY_DEFS[enemy.kind];
  s.score += def.score;
  gainCharge(s, def.charge);
  emit(s, 'kill', enemy.x, enemy.z, 1);
  releaseShards(s, enemy);
}

function breakCrate(s: GameState, crate: GameState['objects'][number]): void {
  removeItem(s.objects, crate);
  s.player.power = Math.min(MAX_POWER, s.player.power + crate.value);
  s.echoes += Math.round(ECONOMY.crate * crate.value * echoMultiplier(s));
  s.score += 250;
  gainCharge(s, 10);
  emit(s, 'crate', crate.x, crate.z, crate.value);
}

function reap(s: GameState): void {
  for (const enemy of [...s.enemies]) {
    if (s.phase !== 'combat') return;
    if (enemy.health <= 0 && s.enemies.includes(enemy)) killEnemy(s, enemy);
  }
  if (s.phase !== 'combat') return;
  for (const crate of [...s.objects]) if (crate.health <= 0) breakCrate(s, crate);
}

// --------------------------------------------------------------------------------------------------------------
// Player actions
// --------------------------------------------------------------------------------------------------------------
function fire(s: GameState): void {
  const hero = getHero(s.hero);
  const stats = hero.stats;
  const tint = playerTint(s.hero);
  const damage = shotDamage(s);
  const count = stats.shotCount + s.upgrades.scatter;
  const spread = stats.spread > 0 ? stats.spread : 0.09;
  const pierce = (s.hero === 'mira' ? 1 : 0) + s.upgrades.pierce;
  const chain = s.upgrades.arc > 0 || s.hero === 'sera';
  const split = hasSynergy(s, 'prism-barrage');
  let made = 0;
  for (let i = 0; i < count; i++) {
    const angle = (i - (count - 1) / 2) * spread;
    const shot = addProjectile(s, {
      owner: 'player', x: s.player.x, z: 0.8, vx: Math.sin(angle) * stats.projectileSpeed, vz: Math.cos(angle) * stats.projectileSpeed, damage,
      radius: 0.22, pierce, life: 1.5, hitIds: [], tint, chain, split,
    });
    if (shot) made++;
  }
  const fans = Math.min(5, Math.ceil(s.player.squad / 3));
  for (let i = 0; i < fans; i++) {
    const offset = (i % 2 === 0 ? -1 : 1) * (0.55 + 0.3 * Math.floor(i / 2));
    const shot = addProjectile(s, {
      owner: 'player', x: clamp(s.player.x + offset, -WORLD.halfWidth, WORLD.halfWidth), z: 0.5, vx: (-offset * stats.projectileSpeed) / FAN_CONVERGE_Z,
      vz: stats.projectileSpeed, damage: damage * 0.4, radius: 0.16, pierce: 0, life: 1.5, hitIds: [], tint, chain: false, split: false,
    });
    if (shot) made++;
  }
  if (made > 0) emit(s, 'shot', s.player.x, 0.8, made);
}

function clearEnemyFire(s: GameState, keep: (p: ProjectileState) => boolean): void {
  for (let i = s.projectiles.length - 1; i >= 0; i--) {
    const p = s.projectiles[i];
    if (p.owner === 'enemy' && !keep(p)) s.projectiles.splice(i, 1);
  }
}

function castEncore(s: GameState): void {
  const hero = getHero(s.hero);
  const px = s.player.x;
  const base = shotDamage(s);
  s.player.charge = 0;
  emit(s, 'burst', px, 0, 1, hero.burstName);
  if (s.hero === 'mira') {
    addProjectile(s, {
      owner: 'player', x: px, z: 1.5, vx: 0, vz: 55, damage: base * 4, radius: 1.0, pierce: 99, life: 0.9, hitIds: [], tint: playerTint('mira'),
      chain: false, split: false,
    });
    clearEnemyFire(s, p => Math.abs(p.x - px) >= 1.4);
  } else if (s.hero === 'rin') {
    for (const enemy of s.enemies) if (Math.hypot(enemy.x - px, enemy.z - 7) < 9 + enemy.radius) dealDamage(s, enemy, base * 7);
    clearEnemyFire(s, p => Math.hypot(p.x - px, p.z - 7) >= 9);
    for (let i = 0; i < 9; i++) {
      const angle = (i - 4) * 0.2;
      addProjectile(s, {
        owner: 'player', x: px, z: 1, vx: Math.sin(angle) * 22, vz: Math.cos(angle) * 22, damage: base, radius: 0.22, pierce: 0, life: 1.2, hitIds: [],
        tint: playerTint('rin'), chain: false, split: false,
      });
    }
  } else {
    s.player.shield = Math.min(shieldCapacity(s), s.player.shield + 30);
    for (const enemy of s.enemies) {
      if (enemy.z >= 14) continue;
      dealDamage(s, enemy, base * 3);
      if (enemy.kind !== 'boss') enemy.z = Math.min(WORLD.spawnDistance + 3, enemy.z + 7);
    }
    clearEnemyFire(s, p => p.z >= 16);
  }
  reap(s);
}

// --------------------------------------------------------------------------------------------------------------
// Offers and choices
// --------------------------------------------------------------------------------------------------------------
function offerChoice(s: GameState): void {
  const eligible = UPGRADES.filter(u => s.upgrades[u.id] < u.maxLevel).map(u => u.id);
  if (eligible.length === 0) {
    s.choicesTaken++;
    s.player.health = Math.min(s.player.maxHealth, s.player.health + ECONOMY.exhaustionHeal);
    s.echoes += ECONOMY.exhaustionReward;
    emit(s, 'reward', s.player.x, 0, ECONOMY.exhaustionReward, 'exhausted');
    return;
  }
  const completes = (id: UpgradeId): boolean =>
    SYNERGIES.some(([, a, b]) => (id === a && s.upgrades[b] > 0 && s.upgrades[a] === 0) || (id === b && s.upgrades[a] > 0 && s.upgrades[b] === 0));
  const pool = [...eligible];
  const offers: UpgradeId[] = [];
  while (offers.length < 3 && pool.length > 0) {
    const pick = pickWeighted(s, pool.map(id => [id, completes(id) ? 3 : 1] as const));
    offers.push(pick);
    pool.splice(pool.indexOf(pick), 1);
  }
  s.offers = offers;
  s.phase = 'upgrade';
}

export const chooseUpgrade: ChooseUpgrade = (state, id) => {
  const definition = UPGRADES.find(u => u.id === id);
  if (state.phase !== 'upgrade' || !definition || !state.offers.includes(id) || state.upgrades[id] >= definition.maxLevel) return false;
  state.upgrades[id]++;
  if (id === 'barrier') state.player.shield = Math.min(shieldCapacity(state), state.player.shield + 15);
  if (id === 'rally') state.player.squad = Math.min(MAX_SQUAD, state.player.squad + 2);
  state.choicesTaken++;
  state.offers = [];
  state.phase = 'combat';
  for (const synergy of activeSynergies(state)) {
    if (state.announcedSynergies.includes(synergy)) continue;
    state.announcedSynergies.push(synergy);
    emit(state, 'synergy', state.player.x, 0, state.announcedSynergies.length, synergy);
  }
  return true;
};

export const chooseRoute: ChooseRoute = (state, route) => {
  if (state.phase !== 'route' || !ROUTES.includes(route)) return false;
  state.enemyMultiplier = 1;
  state.rewardMultiplier = 1;
  if (route === 'safe') state.player.health = Math.min(state.player.maxHealth, state.player.health + ECONOMY.safeHeal);
  else if (route === 'salvage') state.echoes += ECONOMY.salvageRoute;
  else {
    state.enemyMultiplier = ECONOMY.redlineHealth;
    state.rewardMultiplier = ECONOMY.redlineRewards;
  }
  emit(state, 'reward', state.player.x, 0, route === 'salvage' ? ECONOMY.salvageRoute : 0, route);
  state.sector++;
  state.sectorTime = 0;
  state.choicesTaken = 0;
  state.bossSpawned = false;
  state.spawnTimer = 1.5;
  state.objectTimer = 4;
  state.offers = [];
  clearArena(state, true);
  state.phase = 'combat';
  return true;
};

// --------------------------------------------------------------------------------------------------------------
// Simulation step
// --------------------------------------------------------------------------------------------------------------
function stepEnemies(s: GameState, h: number): void {
  for (const enemy of [...s.enemies]) {
    if (enemy.kind === 'boss') updateBoss(s, enemy, h);
    else if (enemy.kind === 'wraith') updateWraith(s, enemy, h);
    else enemy.z -= enemy.speed * h;
    if (enemy.kind !== 'boss' && enemy.z <= WORLD.vanishDistance) removeItem(s.enemies, enemy);
  }
}

function stepTelegraphs(s: GameState, h: number): void {
  for (const t of [...s.telegraphs]) {
    t.remaining -= h;
    if (t.remaining > 0) continue;
    removeItem(s.telegraphs, t);
    if (t.damage > 0 && Math.abs(s.player.x - t.x) <= t.width / 2 && Math.abs(t.z) <= t.depth / 2 + 0 && Math.abs(0 - t.z) <= t.depth / 2) {
      damagePlayer(s, t.damage, s.player.x, 0);
      if (s.phase !== 'combat') return;
    }
  }
}

function stepObjects(s: GameState, h: number): void {
  for (const object of [...s.objects]) {
    object.z -= OBJECT_SPEED * h;
    if (object.kind === 'gate' && object.z <= 0.6 && object.z >= -0.6 && Math.abs(object.x - s.player.x) <= object.width / 2 + 0.2) {
      removeItem(s.objects, object);
      const gained = object.value + s.upgrades.rally;
      s.player.squad = Math.min(MAX_SQUAD, s.player.squad + gained);
      s.score += 50;
      gainCharge(s, 2);
      emit(s, 'recruit', object.x, object.z, gained);
    } else if (object.z <= WORLD.vanishDistance) {
      removeItem(s.objects, object);
    }
  }
}

function stepProjectiles(s: GameState, h: number): void {
  const count = s.projectiles.length;
  const expired = new Set<number>();
  for (let i = 0; i < count; i++) {
    const p = s.projectiles[i];
    p.life -= h;
    p.x += p.vx * h;
    p.z += p.vz * h;
    if (p.life <= 0 || p.z > WORLD.spawnDistance + 4 || p.z < WORLD.vanishDistance - 2 || Math.abs(p.x) > WORLD.halfWidth + 3 || (p.owner === 'enemy' && p.z < -0.5)) {
      expired.add(p.id);
      continue;
    }
    if (p.owner === 'enemy') {
      if (Math.hypot(p.x - s.player.x, p.z) < p.radius + PLAYER_RADIUS) {
        expired.add(p.id);
        damagePlayer(s, p.damage, p.x, p.z);
        if (s.phase !== 'combat') break;
      }
      continue;
    }
    const targets: Array<{ enemy?: EnemyState; crate?: GameState['objects'][number]; z: number; id: number }> = [];
    for (const e of s.enemies) {
      if (e.health > 0 && !p.hitIds.includes(e.id) && Math.hypot(e.x - p.x, e.z - p.z) < e.radius + p.radius) targets.push({ enemy: e, z: e.z, id: e.id });
    }
    for (const o of s.objects) {
      if (o.kind === 'crate' && o.health > 0 && !p.hitIds.includes(o.id) && Math.hypot(o.x - p.x, o.z - p.z) < o.radius + p.radius) {
        targets.push({ crate: o, z: o.z, id: o.id });
      }
    }
    targets.sort((a, b) => a.z - b.z || a.id - b.id);
    for (const target of targets) {
      p.hitIds.push(target.id);
      if (target.enemy) hitEnemy(s, p, target.enemy);
      else if (target.crate) {
        target.crate.health -= p.damage;
        emit(s, 'hit', target.crate.x, target.crate.z, p.damage);
        gainCharge(s, 0.25);
      }
      if (p.pierce > 0) p.pierce--;
      else {
        expired.add(p.id);
        break;
      }
    }
  }
  if (expired.size > 0) {
    let write = 0;
    for (let read = 0; read < s.projectiles.length; read++) {
      const p = s.projectiles[read];
      if (!expired.has(p.id)) s.projectiles[write++] = p;
    }
    s.projectiles.length = write;
  }
}

function stepContacts(s: GameState): void {
  for (const enemy of [...s.enemies]) {
    if (enemy.kind === 'boss') continue;
    if (Math.hypot(enemy.x - s.player.x, enemy.z) < enemy.radius * 0.8 + PLAYER_RADIUS) {
      removeItem(s.enemies, enemy);
      damagePlayer(s, enemy.damage, enemy.x, enemy.z);
      if (s.phase !== 'combat') return;
    }
  }
}

function step(s: GameState, h: number, move: number, target: number | null, burst: boolean): void {
  const player = s.player;
  const stats = getHero(s.hero).stats;
  if (burst && player.charge >= 100) {
    castEncore(s);
    if (s.phase !== 'combat') return;
  }

  s.elapsed += h;
  s.sectorTime += h;

  if (move !== 0) player.x += move * stats.moveSpeed * h;
  else if (target !== null) {
    const reach = stats.moveSpeed * TARGET_STEER_SPEED * h;
    player.x += clamp(target - player.x, -reach, reach);
  }
  player.x = clamp(player.x, -WORLD.halfWidth, WORLD.halfWidth);

  player.invulnerableFor = Math.max(0, player.invulnerableFor - h);
  gainCharge(s, 0.6 * h);
  player.fireCooldown -= h;
  if (player.fireCooldown <= 0) {
    fire(s);
    player.fireCooldown += 1 / (stats.fireRate * (1 + 0.15 * s.upgrades.rapid));
  }
  if (s.upgrades.repair > 0) {
    s.regenTimer -= h;
    if (s.regenTimer <= 0) {
      s.regenTimer = REPAIR_PERIOD;
      player.health = Math.min(player.maxHealth, player.health + 3 * s.upgrades.repair);
      if (hasSynergy(s, 'guardian-choir')) player.shield = Math.min(shieldCapacity(s), player.shield + 5 * s.upgrades.repair);
    }
  }

  if (!s.bossSpawned) {
    s.spawnTimer -= h;
    if (s.spawnTimer <= 0 && s.sectorTime < WORLD.sectorSeconds - 6) spawnWave(s);
    else if (s.spawnTimer <= 0) s.spawnTimer = 1;
  }
  s.objectTimer -= h;
  if (s.objectTimer <= 0) spawnObject(s);
  if (!s.bossSpawned && s.sectorTime >= WORLD.sectorSeconds) spawnBoss(s);

  stepEnemies(s, h);
  stepTelegraphs(s, h);
  if (s.phase !== 'combat') return;
  stepObjects(s, h);
  stepProjectiles(s, h);
  reap(s);
  if (s.phase === 'combat') stepContacts(s);

  if (s.phase === 'combat' && !s.bossSpawned && s.choicesTaken < WORLD.choiceTimes.length && s.sectorTime >= WORLD.choiceTimes[s.choicesTaken]) {
    offerChoice(s);
  }
}

export const tick: Tick = (state, input: Readonly<Input>, dt) => {
  if (!Number.isFinite(dt) || dt <= 0 || state.phase !== 'combat') return;
  const move = Number.isFinite(input.move) ? clamp(input.move, -1, 1) : 0;
  const target = typeof input.targetX === 'number' && Number.isFinite(input.targetX) ? clamp(input.targetX, -WORLD.halfWidth, WORLD.halfWidth) : null;
  const burst = input.burst === true;
  const frame = Math.min(dt, MAX_FRAME);
  const steps = Math.max(1, Math.ceil(frame / SUBSTEP - 1e-6));
  const h = frame / steps;
  for (let i = 0; i < steps && state.phase === 'combat'; i++) step(state, h, move, target, burst && i === 0);
};
