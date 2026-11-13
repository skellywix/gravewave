import { getHero, getSector } from './game/catalog.ts';
import type { GameEvent, HeroId, Phase } from './game/types.ts';

export type CinematicKind = 'deploy' | 'sector' | 'boss' | 'burst' | 'victory' | 'defeat';
export interface CinematicFrame { speaker: string; title: string; line: string; duration: number }
export interface Cinematic {
  kind: CinematicKind;
  hero: HeroId;
  frames: CinematicFrame[];
  index: number;
  elapsed: number;
  done: boolean;
  blocking: boolean;
}

export function cinematicForEvent(event: GameEvent, phase: Phase, blocking: boolean): 'boss' | 'burst' | null {
  if (phase !== 'combat') return null;
  if (event.kind === 'boss' && event.text === 'spawn') return 'boss';
  if (event.kind === 'burst' && !blocking) return 'burst';
  return null;
}

const OPENERS: Record<HeroId, string> = {
  mira: 'The invitation said midnight. It did not mention the army of haunted plushies.',
  rin: 'A cursed carnival? Finally. A crowd that can handle my volume.',
  sera: 'Please be nice to the ghosts. They bought the good tickets.',
};
const TAUNTS: Record<HeroId, string> = {
  mira: 'That is a terribly dramatic entrance. I approve.',
  rin: 'You call that a headline act? Watch this.',
  sera: 'Oh, darling. We are going to exorcise that attitude.',
};

export function createCinematic(kind: CinematicKind, heroId: HeroId, sectorIndex: number): Cinematic {
  const hero = getHero(heroId);
  const sector = getSector(sectorIndex);
  let frames: CinematicFrame[];
  switch (kind) {
    case 'deploy':
      frames = [
        { speaker: 'Midnight, somewhere beyond the living', title: 'The parade begins', line: 'The carnival stole the moon. Three girls brought the noise.', duration: 2.9 },
        { speaker: hero.name, title: sector.name, line: OPENERS[heroId], duration: 3.4 },
      ];
      break;
    case 'sector':
      frames = [
        { speaker: `Act ${sectorIndex + 1}`, title: sector.name, line: sector.subtitle, duration: 2.3 },
        { speaker: hero.name, title: 'The show goes on', line: hero.tagline, duration: 2.4 },
      ];
      break;
    case 'boss':
      frames = [
        { speaker: hero.name, title: `${hero.name} faces ${sector.bossName}`, line: sector.bossTitle, duration: 2.3 },
        { speaker: hero.name, title: 'Your move', line: TAUNTS[heroId], duration: 2.2 },
      ];
      break;
    case 'burst':
      frames = [{ speaker: `${hero.name} · Encore`, title: hero.burstName, line: hero.tagline, duration: 1.05 }];
      break;
    case 'victory':
      frames = [
        { speaker: 'The curse breaks. The crowd does not leave.', title: 'One last encore', line: 'The moon returns to the sea. Every lost soul finds a song to take home.', duration: 3.2 },
        { speaker: hero.name, title: 'See you after midnight', line: heroId === 'rin' ? 'Same time tomorrow? I have a louder guitar.' : heroId === 'sera' ? 'We should do this again. The ghosts made matching outfits.' : 'A flawless show. Let us never discuss the property damage.', duration: 3.2 },
      ];
      break;
    case 'defeat':
      frames = [{ speaker: hero.name, title: 'That was rehearsal', line: 'The Echoes you earned are yours. Change the set list. Start another parade.', duration: 2.7 }];
      break;
  }
  return { kind, hero: heroId, frames, index: 0, elapsed: 0, done: false, blocking: kind !== 'burst' };
}

export function nextCinematicFrame(scene: Cinematic): void {
  if (scene.done) return;
  if (scene.index + 1 >= scene.frames.length) scene.done = true;
  else { scene.index++; scene.elapsed = 0; }
}

export function advanceCinematic(scene: Cinematic, dt: number): void {
  if (scene.done || !Number.isFinite(dt) || dt <= 0) return;
  scene.elapsed += dt;
  while (!scene.done && scene.elapsed >= scene.frames[scene.index].duration) {
    const remainder = scene.elapsed - scene.frames[scene.index].duration;
    nextCinematicFrame(scene);
    scene.elapsed = remainder;
  }
}

export function skipCinematic(scene: Cinematic): void { scene.done = true; }
