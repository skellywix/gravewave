import { ECONOMY, HEROES, SKINS } from './catalog.ts';
import type {
  DecodeProfile,
  DefaultProfile,
  EquipSkin,
  HeroId,
  LoadProfile,
  LoadResult,
  Mode,
  Profile,
  ProfileResult,
  Purchase,
  RunSummary,
  SaveProfile,
  SelectHero,
  SettleRun,
  SkinId,
} from './types.ts';

// Progression is editable offline state: validation protects the game from corrupt or hand-edited
// storage, not from the device owner. Echoes are earned only; nothing here talks to a store or server.

export const SAVE_KEY: string = 'gravewave.profile.v1';

const STARTER_HERO: HeroId = 'mira';
const MODES: readonly Mode[] = ['campaign', 'survival'];
const HERO_IDS: readonly HeroId[] = HEROES.map(hero => hero.id);
const PROFILE_KEYS: readonly string[] = [
  'version', 'echoes', 'ownedHeroes', 'ownedSkins', 'selectedHero', 'equippedSkins',
  'bestScores', 'completedRuns', 'clearedCampaign', 'settledRuns', 'settings', 'storySeen',
];
const SETTINGS_KEYS: readonly string[] = ['sound', 'reducedMotion'];

// Storage bounds. A save larger than MAX_RAW_CHARS or listing more than MAX_DECODE_HISTORY run IDs
// is rejected as corrupt. A valid save holding more than ECONOMY.settlementHistory run IDs is
// accepted and trimmed to the most recent ones, since only those are ever used for deduplication.
const MAX_RAW_CHARS = 65_536;
const MAX_DECODE_HISTORY = 256;
const MAX_STORY_FLAGS = 64;
const MAX_ID_LENGTH = 96;
const MAX_SCORE = 1_000_000_000_000;
const MAX_KILLS = 1_000_000;
const MAX_SECTOR = 10_000;
const MAX_ELAPSED_SECONDS = 604_800;
const MAX_RUN_COUNT = 1_000_000_000;

// Printable text only; control characters never belong in an ID or flag.
const SAFE_TEXT = /^[^\u0000-\u001f\u007f]+$/u;

type Parsed = { ok: true; profile: Profile } | { ok: false; reason: string };
const fail = (reason: string): Parsed => ({ ok: false, reason });

function isHeroId(value: unknown): value is HeroId {
  return typeof value === 'string' && (HERO_IDS as readonly string[]).includes(value);
}

function findSkin(value: unknown) {
  return typeof value === 'string' ? SKINS.find(skin => skin.id === value) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(record);
  return own.length === keys.length && keys.every(key => Object.hasOwn(record, key));
}

function isCount(value: unknown, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max;
}

function isSafeText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH && SAFE_TEXT.test(value);
}

function readList<T extends string>(value: unknown, maxEntries: number, isValid: (item: unknown) => item is T): T[] | null {
  if (!Array.isArray(value) || value.length > maxEntries) return null;
  const items: T[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item: unknown = value[index];
    if (!isValid(item) || items.includes(item)) return null;
    items.push(item);
  }
  return items;
}

const isSkinId = (value: unknown): value is SkinId => findSkin(value) !== undefined;

function freeSkinIds(): SkinId[] {
  return SKINS.filter(skin => skin.price === 0).map(skin => skin.id);
}

export const defaultProfile: DefaultProfile = () => {
  const equippedSkins = {} as Record<HeroId, SkinId>;
  for (const hero of HERO_IDS) equippedSkins[hero] = `${hero}-default`;
  return {
    version: 1,
    echoes: ECONOMY.starterEchoes,
    ownedHeroes: [STARTER_HERO],
    ownedSkins: freeSkinIds(),
    selectedHero: STARTER_HERO,
    equippedSkins,
    bestScores: { campaign: 0, survival: 0 },
    completedRuns: 0,
    clearedCampaign: false,
    settledRuns: [],
    settings: { sound: true, reducedMotion: false },
    storySeen: [],
  };
};

// Validates an untrusted value against every Profile invariant and returns a fresh, normalized copy.
// Only known fields are read; unknown or extra keys anywhere in the v1 shape are rejected.
function validateProfile(value: unknown): Parsed {
  if (!isRecord(value) || !hasExactKeys(value, PROFILE_KEYS)) return fail('the save has the wrong shape');
  if (value.version !== 1) return fail('the save version is not supported');
  if (!isCount(value.echoes, ECONOMY.walletCap)) return fail('the Echoes balance is out of range');

  const ownedHeroes = readList(value.ownedHeroes, HERO_IDS.length, isHeroId);
  if (!ownedHeroes) return fail('the unlocked heroine list is invalid');
  if (!ownedHeroes.includes(STARTER_HERO)) return fail('the starter heroine is missing');

  const ownedSkins = readList(value.ownedSkins, SKINS.length, isSkinId);
  if (!ownedSkins) return fail('the owned outfit list is invalid');
  if (!freeSkinIds().every(id => ownedSkins.includes(id))) return fail('a default outfit is missing');

  if (!isHeroId(value.selectedHero) || !ownedHeroes.includes(value.selectedHero)) return fail('the selected heroine is not unlocked');

  const equippedRaw = value.equippedSkins;
  if (!isRecord(equippedRaw) || !hasExactKeys(equippedRaw, HERO_IDS)) return fail('the equipped outfits are invalid');
  const equippedSkins = {} as Record<HeroId, SkinId>;
  for (const hero of HERO_IDS) {
    const id = equippedRaw[hero];
    const skin = findSkin(id);
    if (!skin || skin.hero !== hero || !ownedSkins.includes(skin.id)) return fail('an equipped outfit is not owned by its heroine');
    equippedSkins[hero] = skin.id;
  }

  const bestRaw = value.bestScores;
  if (!isRecord(bestRaw) || !hasExactKeys(bestRaw, MODES)) return fail('the best scores are invalid');
  const campaign = bestRaw.campaign;
  const survival = bestRaw.survival;
  if (!isCount(campaign, MAX_SCORE) || !isCount(survival, MAX_SCORE)) return fail('a best score is out of range');

  if (!isCount(value.completedRuns, MAX_RUN_COUNT)) return fail('the completed run count is out of range');
  if (typeof value.clearedCampaign !== 'boolean') return fail('the campaign clear flag is invalid');

  const history = readList(value.settledRuns, MAX_DECODE_HISTORY, isSafeText);
  if (!history) return fail('the settled run history is invalid');

  const settingsRaw = value.settings;
  if (!isRecord(settingsRaw) || !hasExactKeys(settingsRaw, SETTINGS_KEYS)) return fail('the settings are invalid');
  const { sound, reducedMotion } = settingsRaw;
  if (typeof sound !== 'boolean' || typeof reducedMotion !== 'boolean') return fail('a setting is invalid');

  const storySeen = readList(value.storySeen, MAX_STORY_FLAGS, isSafeText);
  if (!storySeen) return fail('the story progress is invalid');

  return {
    ok: true,
    profile: {
      version: 1,
      echoes: value.echoes,
      ownedHeroes,
      ownedSkins,
      selectedHero: value.selectedHero,
      equippedSkins,
      bestScores: { campaign, survival },
      completedRuns: value.completedRuns,
      clearedCampaign: value.clearedCampaign,
      settledRuns: history.slice(-ECONOMY.settlementHistory),
      settings: { sound, reducedMotion },
      storySeen,
    },
  };
}

function invalidLoad(raw: string | null, reason: string): LoadResult {
  return {
    status: 'invalid',
    profile: defaultProfile(),
    raw,
    message: `Saved progress could not be read (${reason}). It was left untouched and not overwritten.`,
  };
}

export const decodeProfile: DecodeProfile = raw => {
  if (typeof raw !== 'string') return invalidLoad(null, 'the stored value is not text');
  if (raw.length > MAX_RAW_CHARS) return invalidLoad(raw, 'the save is too large');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return invalidLoad(raw, 'it is not valid data');
  }
  const result = validateProfile(parsed);
  if (!result.ok) return invalidLoad(raw, result.reason);
  return { status: 'ok', profile: result.profile, raw, message: null };
};

// A null or empty-string read is a clean new profile: nothing is stored, so nothing can be lost.
// Any other unreadable string is invalid and preserved, so a fresh in-memory profile never
// authorizes overwriting content we could not interpret.
export const loadProfile: LoadProfile = storage => {
  let raw: unknown;
  try {
    raw = storage.getItem(SAVE_KEY);
  } catch {
    return {
      status: 'unavailable',
      profile: defaultProfile(),
      raw: null,
      message: 'Saved progress is unavailable because browser storage is blocked. Progress will not be saved.',
    };
  }
  if (raw === null || raw === '') return { status: 'new', profile: defaultProfile(), raw: null, message: null };
  if (typeof raw !== 'string') {
    return {
      status: 'unavailable',
      profile: defaultProfile(),
      raw: null,
      message: 'Saved progress is unavailable because browser storage returned unexpected data. Progress will not be saved.',
    };
  }
  return decodeProfile(raw);
};

export const saveProfile: SaveProfile = (storage, profile) => {
  const checked = validateProfile(profile);
  if (!checked.ok) return { ok: false, message: `Progress was not saved because the profile is invalid (${checked.reason}).` };
  try {
    storage.setItem(SAVE_KEY, JSON.stringify(checked.profile));
  } catch {
    return { ok: false, message: 'Progress could not be saved because browser storage is blocked or full.' };
  }
  return { ok: true, message: null };
};

function reject(profile: Profile, reason: 'insufficient' | 'owned' | 'locked' | 'invalid' | 'duplicate', message: string): ProfileResult {
  return { ok: false, profile, reason, message };
}

// Every transaction re-validates its input so a corrupted in-memory profile is rejected, not spread.
function begin(profile: Profile): { ok: true; copy: Profile } | { ok: false; result: ProfileResult } {
  const checked = validateProfile(profile);
  if (!checked.ok) return { ok: false, result: reject(profile, 'invalid', 'That profile could not be updated because it is not valid.') };
  return { ok: true, copy: checked.profile };
}

export const purchase: Purchase = (profile, kind, id) => {
  const start = begin(profile);
  if (!start.ok) return start.result;
  const next = start.copy;

  if (kind === 'hero') {
    const hero = HEROES.find(item => item.id === id);
    if (!hero) return reject(profile, 'invalid', 'That heroine is not in the catalog.');
    if (next.ownedHeroes.includes(hero.id)) return reject(profile, 'owned', `${hero.name} is already unlocked.`);
    if (next.echoes < hero.price) return reject(profile, 'insufficient', `${hero.name} costs ${hero.price} Echoes.`);
    next.echoes -= hero.price;
    next.ownedHeroes.push(hero.id);
    return { ok: true, profile: next, message: `${hero.name} joined the lineup for ${hero.price} Echoes.` };
  }
  if (kind === 'skin') {
    const skin = findSkin(id);
    if (!skin) return reject(profile, 'invalid', 'That outfit is not in the catalog.');
    if (next.ownedSkins.includes(skin.id)) return reject(profile, 'owned', `${skin.name} is already in your wardrobe.`);
    if (next.echoes < skin.price) return reject(profile, 'insufficient', `${skin.name} costs ${skin.price} Echoes.`);
    next.echoes -= skin.price;
    next.ownedSkins.push(skin.id);
    return { ok: true, profile: next, message: `${skin.name} added to your wardrobe for ${skin.price} Echoes.` };
  }
  return reject(profile, 'invalid', 'That item cannot be purchased.');
};

export const equipSkin: EquipSkin = (profile, skinId) => {
  const start = begin(profile);
  if (!start.ok) return start.result;
  const next = start.copy;
  const skin = findSkin(skinId);
  if (!skin) return reject(profile, 'invalid', 'That outfit is not in the catalog.');
  if (!next.ownedSkins.includes(skin.id)) return reject(profile, 'locked', `${skin.name} is not unlocked yet.`);
  if (skin.hero !== next.selectedHero) return reject(profile, 'locked', 'Select that heroine before changing her outfit.');
  next.equippedSkins[skin.hero] = skin.id;
  return { ok: true, profile: next, message: `${skin.name} equipped.` };
};

export const selectHero: SelectHero = (profile, heroId) => {
  const start = begin(profile);
  if (!start.ok) return start.result;
  const next = start.copy;
  const hero = HEROES.find(item => item.id === heroId);
  if (!hero) return reject(profile, 'invalid', 'That heroine is not in the catalog.');
  if (!next.ownedHeroes.includes(hero.id)) return reject(profile, 'locked', `${hero.name} is not unlocked yet.`);
  next.selectedHero = hero.id;
  return { ok: true, profile: next, message: `${hero.name} selected.` };
};

// Returns the validated summary's numbers, floored, or null when the summary is not a usable terminal run.
function readSummary(value: unknown): { runId: string; mode: Mode; victory: boolean; score: number; echoes: number } | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const run = value as Partial<Record<keyof RunSummary, unknown>>;
  const { runId, seed, hero, mode, phase, score, kills, echoes, sector, elapsed } = run;
  if (!isSafeText(runId)) return null;
  if (typeof seed !== 'number' || !Number.isFinite(seed)) return null;
  if (!isHeroId(hero)) return null;
  if (mode !== 'campaign' && mode !== 'survival') return null;
  if (phase !== 'victory' && phase !== 'defeat') return null;
  if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > MAX_SCORE) return null;
  if (!isCount(kills, MAX_KILLS) || !isCount(sector, MAX_SECTOR)) return null;
  if (typeof echoes !== 'number' || !Number.isFinite(echoes) || echoes < 0 || echoes > Number.MAX_SAFE_INTEGER) return null;
  if (typeof elapsed !== 'number' || !Number.isFinite(elapsed) || elapsed < 0 || elapsed > MAX_ELAPSED_SECONDS) return null;
  return { runId, mode, victory: phase === 'victory', score: Math.floor(score), echoes: Math.floor(echoes) };
}

// Dedupe is by run ID, kept for the last ECONOMY.settlementHistory settlements: an ID older than that
// window can be settled again (accepted limitation of an editable offline save).
export const settleRun: SettleRun = (profile, summary) => {
  const start = begin(profile);
  if (!start.ok) return start.result;
  const next = start.copy;
  const run = readSummary(summary);
  if (!run) return reject(profile, 'invalid', 'That run result could not be recorded because it is not valid.');
  if (next.settledRuns.includes(run.runId)) return reject(profile, 'duplicate', 'That run was already settled.');

  const earned = Math.min(run.echoes, ECONOMY.settlementCap);
  const credited = Math.min(earned, ECONOMY.walletCap - next.echoes);
  next.echoes += credited;
  next.bestScores[run.mode] = Math.max(next.bestScores[run.mode], run.score);
  next.completedRuns = Math.min(next.completedRuns + 1, MAX_RUN_COUNT);
  if (run.mode === 'campaign' && run.victory) next.clearedCampaign = true;
  next.settledRuns = [...next.settledRuns, run.runId].slice(-ECONOMY.settlementHistory);
  const note = credited < run.echoes ? ' (capped)' : '';
  return { ok: true, profile: next, message: `Run settled: +${credited} Echoes${note}.` };
};
