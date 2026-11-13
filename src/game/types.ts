export type HeroId = 'mira' | 'rin' | 'sera';
export type SkinId = `${HeroId}-${'default' | 'nocturne' | 'festival'}`;
export type Mode = 'campaign' | 'survival';
export type Phase = 'combat' | 'upgrade' | 'route' | 'victory' | 'defeat';
export type RouteId = 'safe' | 'redline' | 'salvage';
export type UpgradeId = 'overdrive' | 'rapid' | 'scatter' | 'pierce' | 'arc' | 'critical' | 'battery' | 'ricochet' | 'barrier' | 'repair' | 'rally' | 'salvage';
export type SynergyId = 'thunder-rail' | 'prism-barrage' | 'guardian-choir';
export type BossPattern = 'lanes' | 'sweep' | 'crossfire';

export interface HeroStats {
  health: number;
  damage: number;
  fireRate: number;
  shotCount: number;
  spread: number;
  projectileSpeed: number;
  moveSpeed: number;
}
export interface HeroDefinition {
  id: HeroId;
  name: string;
  age: number;
  role: string;
  tagline: string;
  description: string;
  weapon: string;
  burstName: string;
  price: number;
  stats: Readonly<HeroStats>;
}
export interface Palette {
  body: string;
  trim: string;
  hair: string;
  projectile: string;
}
export interface SkinDefinition {
  id: SkinId;
  hero: HeroId;
  name: string;
  collection: string;
  description: string;
  price: number;
  palette: Readonly<Palette>;
  portrait: string;
}
export interface UpgradeDefinition {
  id: UpgradeId;
  name: string;
  description: string;
  detail: string;
  maxLevel: number;
  family: 'ballistics' | 'storm' | 'aegis';
}
export interface SectorDefinition {
  id: number;
  name: string;
  subtitle: string;
  bossName: string;
  bossTitle: string;
  bossPattern: BossPattern;
  color: string;
  fog: string;
  sky: string;
  accent: string;
}
export interface Input {
  move: number;
  targetX: number | null;
  burst: boolean;
}
export interface PlayerState {
  x: number;
  health: number;
  maxHealth: number;
  shield: number;
  squad: number;
  power: number;
  charge: number;
  fireCooldown: number;
  invulnerableFor: number;
}
export interface EnemyState {
  id: number;
  kind: 'plush' | 'carriage' | 'wraith' | 'boss';
  x: number;
  z: number;
  health: number;
  maxHealth: number;
  speed: number;
  radius: number;
  damage: number;
  attackTimer: number;
  pattern: BossPattern | null;
  attackStep: number;
  modifier: 'haste' | 'armored' | 'volatile' | null;
}
export interface ProjectileState {
  id: number;
  owner: 'player' | 'enemy';
  x: number;
  z: number;
  vx: number;
  vz: number;
  damage: number;
  radius: number;
  pierce: number;
  life: number;
  hitIds: number[];
  tint: string;
  chain: boolean;
  split: boolean;
}
export interface TrackObject {
  id: number;
  kind: 'gate' | 'crate';
  x: number;
  z: number;
  health: number;
  maxHealth: number;
  value: number;
  radius: number;
  width: number;
}
export interface Telegraph {
  id: number;
  x: number;
  z: number;
  width: number;
  depth: number;
  remaining: number;
  duration: number;
  damage: number;
  kind: 'lane' | 'blast';
}
export type EventKind = 'shot' | 'hit' | 'kill' | 'recruit' | 'crate' | 'damage' | 'boss' | 'burst' | 'synergy' | 'reward' | 'victory' | 'defeat';
export interface GameEvent {
  id: number;
  kind: EventKind;
  x: number;
  z: number;
  value: number;
  text?: string;
}
export interface GameState {
  runId: string;
  seed: number;
  rng: number;
  mode: Mode;
  hero: HeroId;
  phase: Phase;
  sector: number;
  elapsed: number;
  sectorTime: number;
  player: PlayerState;
  score: number;
  kills: number;
  echoes: number;
  upgrades: Record<UpgradeId, number>;
  offers: UpgradeId[];
  enemies: EnemyState[];
  projectiles: ProjectileState[];
  objects: TrackObject[];
  telegraphs: Telegraph[];
  events: GameEvent[];
  nextEntityId: number;
  nextEventId: number;
  spawnTimer: number;
  objectTimer: number;
  regenTimer: number;
  choicesTaken: number;
  bossSpawned: boolean;
  rewardMultiplier: number;
  enemyMultiplier: number;
  announcedSynergies: SynergyId[];
}
export interface RunSummary {
  runId: string;
  seed: number;
  hero: HeroId;
  mode: Mode;
  phase: 'victory' | 'defeat';
  score: number;
  kills: number;
  echoes: number;
  sector: number;
  elapsed: number;
}
export interface Profile {
  version: 1;
  echoes: number;
  ownedHeroes: HeroId[];
  ownedSkins: SkinId[];
  selectedHero: HeroId;
  equippedSkins: Record<HeroId, SkinId>;
  bestScores: Record<Mode, number>;
  completedRuns: number;
  clearedCampaign: boolean;
  settledRuns: string[];
  settings: { sound: boolean; reducedMotion: boolean };
  storySeen: string[];
}
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
export interface LoadResult {
  status: 'ok' | 'new' | 'invalid' | 'unavailable';
  profile: Profile;
  raw: string | null;
  message: string | null;
}
export interface SaveResult {
  ok: boolean;
  message: string | null;
}
export type ProfileResult =
  | { ok: true; profile: Profile; message: string }
  | { ok: false; profile: Profile; reason: 'insufficient' | 'owned' | 'locked' | 'invalid' | 'duplicate'; message: string };
export interface SceneOptions {
  hero: HeroId;
  skin: SkinId;
  reducedMotion: boolean;
  pixelRatio?: number;
}
export interface Projection {
  x: number;
  y: number;
  visible: boolean;
}
export interface SceneHandle {
  resize(width: number, height: number): void;
  render(state: GameState, dt: number): void;
  setAppearance(hero: HeroId, skin: SkinId): void;
  project(x: number, z: number): Projection;
  dispose(): void;
}

// Providers annotate their exported functions with these contracts.
export type CreateRun = (seed: number, hero: HeroId, mode: Mode, runId: string) => GameState;
// Mutates simulation in place; never mutates input. Invalid/nonpositive dt is ignored.
export type Tick = (state: GameState, input: Readonly<Input>, dt: number) => void;
// Invalid or unavailable choices return false without modifying state.
export type ChooseUpgrade = (state: GameState, id: UpgradeId) => boolean;
export type ChooseRoute = (state: GameState, route: RouteId) => boolean;
export type ActiveSynergies = (state: Readonly<GameState>) => SynergyId[];
export type DefaultProfile = () => Profile;
export type DecodeProfile = (raw: string) => LoadResult;
export type LoadProfile = (storage: StorageLike) => LoadResult;
export type SaveProfile = (storage: StorageLike, profile: Profile) => SaveResult;
// Profile transactions never mutate input, on success or rejection.
export type Purchase = (profile: Profile, kind: 'hero' | 'skin', id: string) => ProfileResult;
export type EquipSkin = (profile: Profile, skinId: string) => ProfileResult;
export type SelectHero = (profile: Profile, heroId: string) => ProfileResult;
export type SettleRun = (profile: Profile, summary: RunSummary) => ProfileResult;
export type CreateScene = (canvas: HTMLCanvasElement, options: SceneOptions) => SceneHandle;
