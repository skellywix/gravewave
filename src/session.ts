import { equipSkin, loadProfile, purchase, saveProfile, selectHero, settleRun } from './game/progression.ts';
import type { GameState, Profile, ProfileResult, StorageLike } from './game/types.ts';

export interface Session {
  readonly profile: Profile;
  readonly persistence: 'ready' | 'protected' | 'unavailable';
  readonly warning: string | null;
  buy(kind: 'hero' | 'skin', id: string): ProfileResult;
  wear(id: string): ProfileResult;
  chooseHero(id: string): ProfileResult;
  settle(run: GameState): ProfileResult;
  setSetting(key: 'sound' | 'reducedMotion', value: boolean): void;
  seeStory(id: string): void;
  retrySaving(): boolean;
}

export function createSession(storage: StorageLike): Session {
  const loaded = loadProfile(storage);
  let profile = loaded.profile;
  let persistence: Session['persistence'] = loaded.status === 'invalid' || loaded.status === 'unavailable' ? 'protected' : 'ready';
  let warning = loaded.message;
  const persist = (): boolean => {
    if (persistence === 'protected') return false;
    const result = saveProfile(storage, profile);
    persistence = result.ok ? 'ready' : 'unavailable';
    warning = result.message;
    return result.ok;
  };
  const apply = (result: ProfileResult): ProfileResult => {
    if (result.ok) { profile = result.profile; persist(); }
    return result;
  };
  return {
    get profile(): Profile { return profile; },
    get persistence(): Session['persistence'] { return persistence; },
    get warning(): string | null { return warning; },
    buy: (kind, id): ProfileResult => apply(purchase(profile, kind, id)),
    wear: id => apply(equipSkin(profile, id)),
    chooseHero: id => apply(selectHero(profile, id)),
    settle(run): ProfileResult {
      if (run.phase !== 'victory' && run.phase !== 'defeat') return { ok: false, profile, reason: 'invalid', message: 'Finish the run before collecting Echoes.' };
      return apply(settleRun(profile, { runId: run.runId, seed: run.seed, hero: run.hero, mode: run.mode, phase: run.phase, score: run.score, kills: run.kills, echoes: run.echoes, sector: run.sector, elapsed: run.elapsed }));
    },
    setSetting(key, value): void {
      profile = { ...profile, settings: { ...profile.settings, [key]: value } };
      persist();
    },
    seeStory(id): void {
      if (profile.storySeen.includes(id)) return;
      profile = { ...profile, storySeen: [...profile.storySeen, id].slice(-64) };
      persist();
    },
    retrySaving: persist,
  };
}
