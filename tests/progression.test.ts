import test from 'node:test';
import assert from 'node:assert/strict';
import { ECONOMY, HEROES, SKINS } from '../src/game/catalog.ts';
import {
  SAVE_KEY,
  decodeProfile,
  defaultProfile,
  equipSkin,
  loadProfile,
  purchase,
  saveProfile,
  selectHero,
  settleRun,
} from '../src/game/progression.ts';
import type { Profile, ProfileResult, RunSummary, StorageLike } from '../src/game/types.ts';

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function snapshot(profile: Profile): string {
  return JSON.stringify(profile);
}

function withEchoes(echoes: number): Profile {
  return { ...defaultProfile(), echoes };
}

function memoryStorage(initial: string | null = null) {
  const store = { value: initial, writes: 0, reads: 0 };
  const api: StorageLike = {
    getItem(key) {
      assert.equal(key, SAVE_KEY);
      store.reads += 1;
      return store.value;
    },
    setItem(key, value) {
      assert.equal(key, SAVE_KEY);
      store.writes += 1;
      store.value = value;
    },
  };
  return { api, store };
}

let runCounter = 0;
function summary(overrides: Partial<RunSummary> = {}): RunSummary {
  runCounter += 1;
  return {
    runId: `run-${runCounter}`,
    seed: 1234,
    hero: 'mira',
    mode: 'campaign',
    phase: 'defeat',
    score: 1000,
    kills: 40,
    echoes: 60,
    sector: 0,
    elapsed: 55.5,
    ...overrides,
  };
}

function expectRejected(result: ProfileResult, original: Profile, reason: string): void {
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, reason);
  assert.equal(result.profile, original, 'rejection returns the caller profile unchanged');
  assert.ok(result.message.length > 0);
}

test('a new profile starts with Mira, three default outfits, 300 Echoes and separate mode bests', () => {
  const profile = defaultProfile();
  assert.equal(SAVE_KEY, 'gravewave.profile.v1');
  assert.deepEqual(profile, {
    version: 1,
    echoes: ECONOMY.starterEchoes,
    ownedHeroes: ['mira'],
    ownedSkins: ['mira-default', 'rin-default', 'sera-default'],
    selectedHero: 'mira',
    equippedSkins: { mira: 'mira-default', rin: 'rin-default', sera: 'sera-default' },
    bestScores: { campaign: 0, survival: 0 },
    completedRuns: 0,
    clearedCampaign: false,
    settledRuns: [],
    settings: { sound: true, reducedMotion: false },
    storySeen: [],
  });
  const other = defaultProfile();
  other.ownedHeroes.push('rin');
  assert.deepEqual(defaultProfile().ownedHeroes, ['mira'], 'defaults are never shared between calls');
});

test('buying a heroine debits the exact catalog price and returns a new profile without touching the old one', () => {
  const before = deepFreeze(withEchoes(1000));
  const result = purchase(before, 'hero', 'rin');
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.notEqual(result.profile, before);
  assert.equal(result.profile.echoes, 1000 - ECONOMY.heroinePrice);
  assert.deepEqual(result.profile.ownedHeroes, ['mira', 'rin']);
  assert.equal(result.profile.selectedHero, 'mira', 'purchase does not auto-select');
  assert.equal(before.echoes, 1000);
  assert.deepEqual(before.ownedHeroes, ['mira']);
});

test('buying an outfit debits the exact price and grants only cosmetics', () => {
  const before = deepFreeze(withEchoes(1000));
  const nocturne = purchase(before, 'skin', 'mira-nocturne');
  assert.equal(nocturne.ok, true);
  if (!nocturne.ok) return;
  assert.equal(nocturne.profile.echoes, 1000 - ECONOMY.nocturnePrice);
  assert.ok(nocturne.profile.ownedSkins.includes('mira-nocturne'));
  const festival = purchase(nocturne.profile, 'skin', 'mira-festival');
  assert.equal(festival.ok, true);
  if (!festival.ok) return;
  assert.equal(festival.profile.echoes, 1000 - ECONOMY.nocturnePrice - ECONOMY.festivalPrice);
  assert.deepEqual(festival.profile.ownedHeroes, ['mira']);
  assert.deepEqual(festival.profile.equippedSkins, before.equippedSkins, 'buying never equips');
});

test('rejected purchases return the original profile with a reason and spend nothing', () => {
  const rich = deepFreeze(withEchoes(5000));
  const poor = deepFreeze(defaultProfile());
  expectRejected(purchase(rich, 'hero', 'mira'), rich, 'owned');
  expectRejected(purchase(rich, 'skin', 'rin-default'), rich, 'owned');
  expectRejected(purchase(poor, 'hero', 'rin'), poor, 'insufficient');
  expectRejected(purchase(poor, 'skin', 'sera-festival'), poor, 'insufficient');
  expectRejected(purchase(rich, 'hero', 'nobody'), rich, 'invalid');
  expectRejected(purchase(rich, 'skin', 'mira-missing'), rich, 'invalid');
  expectRejected(purchase(rich, 'hero', 'mira-default'), rich, 'invalid');
  expectRejected(purchase(rich, 'skin', 'rin'), rich, 'invalid');
  expectRejected(purchase(rich, 'hero', '__proto__'), rich, 'invalid');
  expectRejected(purchase(rich, 'hero', 'constructor'), rich, 'invalid');
  expectRejected(purchase(rich, 'gem' as 'hero', 'rin'), rich, 'invalid');

  const bought = purchase(rich, 'hero', 'rin');
  assert.equal(bought.ok, true);
  if (!bought.ok) return;
  expectRejected(purchase(bought.profile, 'hero', 'rin'), bought.profile, 'owned');
});

test('an outfit for a locked heroine can be bought but not worn until she is unlocked and selected', () => {
  let profile = deepFreeze(withEchoes(2000));
  const gown = purchase(profile, 'skin', 'rin-nocturne');
  assert.equal(gown.ok, true);
  if (!gown.ok) return;
  profile = deepFreeze(gown.profile);

  expectRejected(equipSkin(profile, 'rin-nocturne'), profile, 'locked');
  expectRejected(selectHero(profile, 'rin'), profile, 'locked');

  const hired = purchase(profile, 'hero', 'rin');
  assert.equal(hired.ok, true);
  if (!hired.ok) return;
  profile = deepFreeze(hired.profile);
  expectRejected(equipSkin(profile, 'rin-nocturne'), profile, 'locked');

  const selected = selectHero(profile, 'rin');
  assert.equal(selected.ok, true);
  if (!selected.ok) return;
  assert.equal(selected.profile.selectedHero, 'rin');
  const worn = equipSkin(selected.profile, 'rin-nocturne');
  assert.equal(worn.ok, true);
  if (!worn.ok) return;
  assert.equal(worn.profile.equippedSkins.rin, 'rin-nocturne');
  assert.equal(worn.profile.equippedSkins.mira, 'mira-default');
  assert.equal(selected.profile.equippedSkins.rin, 'rin-default');
});

test('equip accepts only an owned outfit of the currently selected heroine', () => {
  const rich = deepFreeze(withEchoes(5000));
  expectRejected(equipSkin(rich, 'mira-nocturne'), rich, 'locked');
  expectRejected(equipSkin(rich, 'rin-default'), rich, 'locked');
  expectRejected(equipSkin(rich, 'nobody-default'), rich, 'invalid');
  expectRejected(equipSkin(rich, '__proto__'), rich, 'invalid');
  expectRejected(selectHero(rich, 'nobody'), rich, 'invalid');
  expectRejected(selectHero(rich, 'toString'), rich, 'invalid');

  const owned = purchase(rich, 'skin', 'mira-festival');
  assert.equal(owned.ok, true);
  if (!owned.ok) return;
  const worn = equipSkin(owned.profile, 'mira-festival');
  assert.equal(worn.ok, true);
  if (!worn.ok) return;
  assert.equal(worn.profile.equippedSkins.mira, 'mira-festival');
  const back = equipSkin(worn.profile, 'mira-default');
  assert.equal(back.ok, true);
  if (!back.ok) return;
  assert.equal(back.profile.equippedSkins.mira, 'mira-default');
});

test('selecting an owned heroine succeeds as a new profile and keeps her equipped outfit', () => {
  const start = deepFreeze(withEchoes(5000));
  const hired = purchase(start, 'hero', 'sera');
  assert.equal(hired.ok, true);
  if (!hired.ok) return;
  const picked = selectHero(deepFreeze(hired.profile), 'sera');
  assert.equal(picked.ok, true);
  if (!picked.ok) return;
  assert.equal(picked.profile.selectedHero, 'sera');
  assert.equal(picked.profile.equippedSkins.sera, 'sera-default');
  assert.equal(hired.profile.selectedHero, 'mira');
});

test('profiles round-trip through storage without loss and loading never writes', () => {
  let profile = withEchoes(4000);
  for (const [kind, id] of [['hero', 'rin'], ['skin', 'rin-festival'], ['skin', 'mira-nocturne']] as const) {
    const result = purchase(profile, kind, id);
    assert.equal(result.ok, true);
    if (result.ok) profile = result.profile;
  }
  const picked = selectHero(profile, 'rin');
  assert.equal(picked.ok, true);
  if (!picked.ok) return;
  const worn = equipSkin(picked.profile, 'rin-festival');
  assert.equal(worn.ok, true);
  if (!worn.ok) return;
  const finished = settleRun(worn.profile, summary({ mode: 'survival', score: 777 }));
  assert.equal(finished.ok, true);
  if (!finished.ok) return;
  const saved = { ...finished.profile, storySeen: ['intro'], settings: { sound: false, reducedMotion: true } };

  const { api, store } = memoryStorage();
  assert.deepEqual(saveProfile(api, saved), { ok: true, message: null });
  assert.equal(store.writes, 1);
  const loaded = loadProfile(api);
  assert.equal(loaded.status, 'ok');
  assert.equal(loaded.message, null);
  assert.equal(loaded.raw, store.value);
  assert.deepEqual(loaded.profile, saved);
  assert.equal(store.writes, 1);
  assert.deepEqual(decodeProfile(store.value ?? '').profile, saved);
});

test('an empty stored string is a clean new profile and is never written by load', () => {
  const { api, store } = memoryStorage('');
  const loaded = loadProfile(api);
  assert.equal(loaded.status, 'new');
  assert.equal(loaded.message, null);
  assert.deepEqual(loaded.profile, defaultProfile());
  assert.equal(store.writes, 0);
  assert.equal(decodeProfile('').status, 'invalid', 'decodeProfile still rejects an empty save text');
});

test('empty storage is a clean new profile and storage failures are explicit', () => {
  const { api, store } = memoryStorage(null);
  const fresh = loadProfile(api);
  assert.equal(fresh.status, 'new');
  assert.equal(fresh.raw, null);
  assert.equal(fresh.message, null);
  assert.deepEqual(fresh.profile, defaultProfile());
  assert.equal(store.writes, 0);

  const blockedRead: StorageLike = {
    getItem() { throw new Error('SecurityError: storage is blocked'); },
    setItem() { throw new Error('unreachable'); },
  };
  const blocked = loadProfile(blockedRead);
  assert.equal(blocked.status, 'unavailable');
  assert.equal(blocked.raw, null);
  assert.deepEqual(blocked.profile, defaultProfile());
  assert.ok(blocked.message && blocked.message.length > 0);
  assert.ok(!blocked.message.includes('SecurityError'), 'internal error text is not shown to players');

  const weirdRead = loadProfile({ getItem: () => 42 as unknown as string, setItem() { } });
  assert.equal(weirdRead.status, 'unavailable');

  const blockedWrite: StorageLike = {
    getItem: () => null,
    setItem() { throw new Error('QuotaExceededError'); },
  };
  const failed = saveProfile(blockedWrite, defaultProfile());
  assert.equal(failed.ok, false);
  assert.ok(failed.message && failed.message.length > 0);
  assert.ok(!failed.message.includes('QuotaExceededError'));
});

test('saveProfile refuses an invalid profile and writes nothing', () => {
  const { api, store } = memoryStorage('{"keep":"me"}');
  const poisoned = { ...defaultProfile(), echoes: Number.NaN };
  const result = saveProfile(api, poisoned);
  assert.equal(result.ok, false);
  assert.ok(result.message);
  assert.equal(store.writes, 0);
  assert.equal(store.value, '{"keep":"me"}');
});

test('settling a run credits capped Echoes once and a reload cannot replay the same run', () => {
  const start = deepFreeze(defaultProfile());
  const run = summary({ echoes: 125 });
  const first = settleRun(start, run);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.profile.echoes, ECONOMY.starterEchoes + 125);
  assert.equal(first.profile.completedRuns, 1);
  assert.deepEqual(first.profile.settledRuns, [run.runId]);
  assert.equal(start.echoes, ECONOMY.starterEchoes);

  const again = settleRun(deepFreeze(first.profile), run);
  expectRejected(again, first.profile, 'duplicate');

  const { api } = memoryStorage();
  assert.equal(saveProfile(api, first.profile).ok, true);
  const reloaded = loadProfile(api);
  assert.equal(reloaded.status, 'ok');
  expectRejected(settleRun(reloaded.profile, { ...run }), reloaded.profile, 'duplicate');
});

test('two runs with the same seed but different IDs both pay out', () => {
  const a = settleRun(defaultProfile(), summary({ seed: 99, echoes: 40, runId: 'seed99-a' }));
  assert.equal(a.ok, true);
  if (!a.ok) return;
  const b = settleRun(a.profile, summary({ seed: 99, echoes: 40, runId: 'seed99-b' }));
  assert.equal(b.ok, true);
  if (!b.ok) return;
  assert.equal(b.profile.echoes, ECONOMY.starterEchoes + 80);
  assert.equal(b.profile.completedRuns, 2);
});

test('only the 32 most recent run IDs are remembered', () => {
  let profile = defaultProfile();
  const ids: string[] = [];
  for (let index = 0; index < ECONOMY.settlementHistory + 5; index += 1) {
    const run = summary({ runId: `h-${index}`, echoes: 1 });
    ids.push(run.runId);
    const result = settleRun(profile, run);
    assert.equal(result.ok, true);
    if (result.ok) profile = result.profile;
  }
  assert.deepEqual(profile.settledRuns, ids.slice(-ECONOMY.settlementHistory));
  for (const id of ids.slice(-ECONOMY.settlementHistory)) {
    expectRejected(settleRun(profile, summary({ runId: id })), profile, 'duplicate');
  }
});

test('the first sector clear pays enough for the cheapest outfit and the new gown can then be worn', () => {
  const run = summary({ phase: 'defeat', sector: 0, kills: 60, echoes: ECONOMY.sectorClear + 60 });
  const settled = settleRun(defaultProfile(), run);
  assert.equal(settled.ok, true);
  if (!settled.ok) return;
  const bought = purchase(settled.profile, 'skin', 'mira-nocturne');
  assert.equal(bought.ok, true);
  if (!bought.ok) return;
  assert.equal(bought.profile.echoes, ECONOMY.starterEchoes + ECONOMY.sectorClear + 60 - ECONOMY.nocturnePrice);
  const worn = equipSkin(bought.profile, 'mira-nocturne');
  assert.equal(worn.ok, true);
});

test('per-run credit and the wallet are capped, and fractional Echoes are floored', () => {
  const rich = settleRun(defaultProfile(), summary({ echoes: ECONOMY.settlementCap * 5 }));
  assert.equal(rich.ok, true);
  if (!rich.ok) return;
  assert.equal(rich.profile.echoes, ECONOMY.starterEchoes + ECONOMY.settlementCap);

  const nearCap = settleRun(withEchoes(ECONOMY.walletCap - 10), summary({ echoes: 500 }));
  assert.equal(nearCap.ok, true);
  if (!nearCap.ok) return;
  assert.equal(nearCap.profile.echoes, ECONOMY.walletCap);

  const full = settleRun(withEchoes(ECONOMY.walletCap), summary({ echoes: 500 }));
  assert.equal(full.ok, true);
  if (!full.ok) return;
  assert.equal(full.profile.echoes, ECONOMY.walletCap);
  assert.equal(full.profile.completedRuns, 1, 'a capped wallet still records the run');

  const fractional = settleRun(defaultProfile(), summary({ echoes: 10.9, score: 99.9 }));
  assert.equal(fractional.ok, true);
  if (!fractional.ok) return;
  assert.equal(fractional.profile.echoes, ECONOMY.starterEchoes + 10);
  assert.equal(fractional.profile.bestScores.campaign, 99);
});

test('best scores are tracked per mode and only campaign victories clear the campaign', () => {
  let profile = defaultProfile();
  const apply = (overrides: Partial<RunSummary>): void => {
    const result = settleRun(profile, summary(overrides));
    assert.equal(result.ok, true);
    if (result.ok) profile = result.profile;
  };
  apply({ mode: 'campaign', phase: 'defeat', score: 500 });
  assert.deepEqual(profile.bestScores, { campaign: 500, survival: 0 });
  assert.equal(profile.clearedCampaign, false);
  apply({ mode: 'survival', phase: 'defeat', score: 900 });
  assert.deepEqual(profile.bestScores, { campaign: 500, survival: 900 });
  apply({ mode: 'campaign', phase: 'defeat', score: 300 });
  assert.deepEqual(profile.bestScores, { campaign: 500, survival: 900 });
  apply({ mode: 'survival', phase: 'victory', score: 100 });
  assert.equal(profile.clearedCampaign, false);
  apply({ mode: 'campaign', phase: 'victory', score: 800 });
  assert.deepEqual(profile.bestScores, { campaign: 800, survival: 900 });
  assert.equal(profile.clearedCampaign, true);
  apply({ mode: 'campaign', phase: 'defeat', score: 1 });
  assert.equal(profile.clearedCampaign, true, 'a later defeat does not undo the clear');
  assert.equal(profile.completedRuns, 6);
});

test('settlement rejects malformed summaries without crediting anything', () => {
  const profile = deepFreeze(defaultProfile());
  const cases: Array<[string, unknown]> = [
    ['NaN echoes', summary({ echoes: Number.NaN })],
    ['infinite echoes', summary({ echoes: Number.POSITIVE_INFINITY })],
    ['negative echoes', summary({ echoes: -5 })],
    ['unsafe echoes', summary({ echoes: Number.MAX_VALUE })],
    ['negative score', summary({ score: -1 })],
    ['infinite score', summary({ score: Number.POSITIVE_INFINITY })],
    ['absurd score', summary({ score: 1e300 })],
    ['negative kills', summary({ kills: -1 })],
    ['fractional kills', summary({ kills: 1.5 })],
    ['huge kills', summary({ kills: 1e9 })],
    ['negative sector', summary({ sector: -1 })],
    ['fractional sector', summary({ sector: 0.5 })],
    ['negative elapsed', summary({ elapsed: -1 })],
    ['NaN elapsed', summary({ elapsed: Number.NaN })],
    ['NaN seed', summary({ seed: Number.NaN })],
    ['unknown hero', summary({ hero: 'zed' as 'mira' })],
    ['prototype hero', summary({ hero: 'constructor' as 'mira' })],
    ['unknown mode', summary({ mode: 'endless' as 'campaign' })],
    ['non-terminal phase', summary({ phase: 'combat' as 'victory' })],
    ['empty run id', summary({ runId: '' })],
    ['oversized run id', summary({ runId: 'x'.repeat(200) })],
    ['control characters in run id', summary({ runId: 'a\nb' })],
    ['numeric run id', { ...summary(), runId: 7 }],
    ['string score', { ...summary(), score: '10' }],
    ['null summary', null],
    ['array summary', []],
  ];
  for (const [name, bad] of cases) {
    const result = settleRun(profile, bad as RunSummary);
    assert.equal(result.ok, false, name);
    if (!result.ok) {
      assert.equal(result.reason, 'invalid', name);
      assert.equal(result.profile, profile, name);
    }
  }
});

test('transactions refuse a corrupted in-memory profile instead of spreading it', () => {
  const bad = { ...defaultProfile(), echoes: Number.NaN };
  expectRejected(purchase(bad, 'hero', 'rin'), bad, 'invalid');
  expectRejected(settleRun(bad, summary()), bad, 'invalid');
  expectRejected(selectHero(bad, 'mira'), bad, 'invalid');
  expectRejected(equipSkin(bad, 'mira-default'), bad, 'invalid');
});

function mutated(edit: (data: Record<string, any>) => void): string {
  const data = JSON.parse(JSON.stringify(defaultProfile()));
  edit(data);
  return JSON.stringify(data);
}

test('malformed saves are reported invalid with the original text preserved and the fresh profile unsaved', () => {
  const unsafeNumber = JSON.stringify(defaultProfile()).replace('"echoes":300', '"echoes":1e999');
  assert.ok(unsafeNumber.includes('1e999'));
  const cases: Array<[string, string]> = [
    ['whitespace only', '  '],
    ['truncated JSON', '{"version":1,'],
    ['not JSON', 'garbage'],
    ['number root', '42'],
    ['null root', 'null'],
    ['array root', '[]'],
    ['string root', '"profile"'],
    ['future version', mutated(d => { d.version = 2; })],
    ['string version', mutated(d => { d.version = '1'; })],
    ['missing version', mutated(d => { delete d.version; })],
    ['unknown top-level key', mutated(d => { d.gems = 99; })],
    ['null echoes', mutated(d => { d.echoes = null; })],
    ['string echoes', mutated(d => { d.echoes = '300'; })],
    ['negative echoes', mutated(d => { d.echoes = -1; })],
    ['fractional echoes', mutated(d => { d.echoes = 1.5; })],
    ['echoes beyond wallet', mutated(d => { d.echoes = ECONOMY.walletCap + 1; })],
    ['infinite echoes', unsafeNumber],
    ['hero list missing Mira', mutated(d => { d.ownedHeroes = []; })],
    ['unknown owned hero', mutated(d => { d.ownedHeroes = ['mira', 'zed']; })],
    ['duplicate owned hero', mutated(d => { d.ownedHeroes = ['mira', 'mira']; })],
    ['numeric owned hero', mutated(d => { d.ownedHeroes = ['mira', 0]; })],
    ['prototype-named owned hero', mutated(d => { d.ownedHeroes = ['mira', '__proto__']; })],
    ['owned heroes not an array', mutated(d => { d.ownedHeroes = 'mira'; })],
    ['missing a default outfit', mutated(d => { d.ownedSkins = ['mira-default', 'rin-default']; })],
    ['unknown owned outfit', mutated(d => { d.ownedSkins.push('mira-hidden'); })],
    ['duplicate owned outfit', mutated(d => { d.ownedSkins.push('mira-default'); })],
    ['selected hero not owned', mutated(d => { d.selectedHero = 'rin'; })],
    ['selected hero unknown', mutated(d => { d.selectedHero = 'zed'; })],
    ['equipped outfit belongs to another hero', mutated(d => { d.equippedSkins.mira = 'rin-default'; })],
    ['equipped outfit not owned', mutated(d => { d.equippedSkins.mira = 'mira-nocturne'; })],
    ['equipped heroine missing', mutated(d => { delete d.equippedSkins.sera; })],
    ['equipped heroine unknown', mutated(d => { d.equippedSkins.zed = 'zed-default'; })],
    ['equipped record is an array', mutated(d => { d.equippedSkins = []; })],
    ['negative best score', mutated(d => { d.bestScores.campaign = -1; })],
    ['absurd best score', mutated(d => { d.bestScores.survival = 1e300; })],
    ['fractional best score', mutated(d => { d.bestScores.survival = 0.5; })],
    ['missing survival best', mutated(d => { delete d.bestScores.survival; })],
    ['unknown mode best', mutated(d => { d.bestScores.endless = 5; })],
    ['negative completed runs', mutated(d => { d.completedRuns = -1; })],
    ['fractional completed runs', mutated(d => { d.completedRuns = 0.5; })],
    ['huge completed runs', mutated(d => { d.completedRuns = 1e15; })],
    ['string cleared flag', mutated(d => { d.clearedCampaign = 'yes'; })],
    ['duplicate settled run', mutated(d => { d.settledRuns = ['a', 'a']; })],
    ['numeric settled run', mutated(d => { d.settledRuns = [1]; })],
    ['empty settled run', mutated(d => { d.settledRuns = ['']; })],
    ['control character settled run', mutated(d => { d.settledRuns = ['a\u0000b']; })],
    ['oversized settled run id', mutated(d => { d.settledRuns = ['x'.repeat(200)]; })],
    ['settled runs not an array', mutated(d => { d.settledRuns = {}; })],
    ['absurdly long history', mutated(d => { d.settledRuns = Array.from({ length: 5000 }, (_, i) => `r${i}`); })],
    ['string sound flag', mutated(d => { d.settings.sound = 'true'; })],
    ['missing reduced motion', mutated(d => { delete d.settings.reducedMotion; })],
    ['unknown setting', mutated(d => { d.settings.volume = 11; })],
    ['settings null', mutated(d => { d.settings = null; })],
    ['duplicate story flag', mutated(d => { d.storySeen = ['intro', 'intro']; })],
    ['non-string story flag', mutated(d => { d.storySeen = [5]; })],
    ['oversized story flag', mutated(d => { d.storySeen = ['y'.repeat(100)]; })],
    ['too many story flags', mutated(d => { d.storySeen = Array.from({ length: 500 }, (_, i) => `s${i}`); })],
    ['own __proto__ key at root', '{"__proto__":{"echoes":999999},' + JSON.stringify(defaultProfile()).slice(1)],
    ['own __proto__ key in equipped skins', mutated(d => { Object.defineProperty(d.equippedSkins, '__proto__', { value: 'mira-default', enumerable: true }); })],
    ['oversized raw text', ' '.repeat(200_000) + JSON.stringify(defaultProfile())],
  ];
  for (const [name, raw] of cases) {
    const decoded = decodeProfile(raw);
    assert.equal(decoded.status, 'invalid', name);
    assert.equal(decoded.raw, raw, name);
    assert.deepEqual(decoded.profile, defaultProfile(), name);
    assert.ok(decoded.message && decoded.message.length > 0, name);

    const { api, store } = memoryStorage(raw);
    const loaded = loadProfile(api);
    assert.equal(loaded.status, 'invalid', name);
    assert.equal(loaded.raw, raw, name);
    assert.equal(store.value, raw, `${name}: storage untouched`);
    assert.equal(store.writes, 0, name);
  }
  assert.equal(({} as Record<string, unknown>).echoes, undefined, 'Object.prototype was never polluted');
});

test('a valid save with oversize settlement history keeps the 32 most recent run IDs in order', () => {
  const ids = Array.from({ length: 50 }, (_, index) => `old-${index}`);
  const decoded = decodeProfile(mutated(d => { d.settledRuns = ids; }));
  assert.equal(decoded.status, 'ok');
  assert.deepEqual(decoded.profile.settledRuns, ids.slice(-ECONOMY.settlementHistory));
});

test('a decoded profile is a fresh object that carries nothing beyond the known fields', () => {
  const raw = mutated(d => {
    d.ownedSkins.push('rin-nocturne');
    d.storySeen = ['intro'];
    d.completedRuns = 3;
    d.bestScores.survival = 12;
    d.echoes = ECONOMY.walletCap;
  });
  const decoded = decodeProfile(raw);
  assert.equal(decoded.status, 'ok');
  assert.deepEqual(Object.keys(decoded.profile).sort(), Object.keys(defaultProfile()).sort());
  assert.equal(decoded.profile.echoes, ECONOMY.walletCap);
  assert.ok(decoded.profile.ownedSkins.includes('rin-nocturne'));
  assert.deepEqual(decoded.profile.storySeen, ['intro']);
  assert.equal(decoded.profile.bestScores.survival, 12);
  assert.equal(HEROES.length, 3);
  assert.equal(SKINS.length, 9);
});
