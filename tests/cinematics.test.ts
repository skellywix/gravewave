import test from 'node:test';
import assert from 'node:assert/strict';
import { createCinematic, advanceCinematic, nextCinematicFrame, skipCinematic, cinematicForEvent } from '../src/cinematics.ts';
import type { CinematicKind } from '../src/cinematics.ts';
import { HEROES, SECTORS } from '../src/game/catalog.ts';

test('a cinematic advances through its real story and terminates without overrunning frames', () => {
  const scene = createCinematic('deploy', 'mira', 0);
  const first = scene.frames[0].line;
  advanceCinematic(scene, scene.frames[0].duration + 0.01);
  assert.equal(scene.index, 1);
  assert.notEqual(scene.frames[scene.index].line, first);
  advanceCinematic(scene, 100);
  assert.equal(scene.done, true);
  assert.ok(scene.index < scene.frames.length);
});

test('every story scene can be skipped immediately, while Encore never blocks steering', () => {
  const kinds: CinematicKind[] = ['deploy', 'sector', 'boss', 'burst', 'victory', 'defeat'];
  for (const kind of kinds) {
    const scene = createCinematic(kind, 'rin', 1);
    assert.equal(scene.blocking, kind !== 'burst');
    skipCinematic(scene);
    assert.equal(scene.done, true);
  }
});

test('manual continue reaches the ending and invalid frame times cannot corrupt a scene', () => {
  const scene = createCinematic('boss', 'sera', 2);
  for (const value of [0, -1, NaN, Infinity]) advanceCinematic(scene, value);
  assert.equal(scene.index, 0);
  assert.equal(scene.elapsed, 0);
  for (let index = 0; index < scene.frames.length; index++) nextCinematicFrame(scene);
  assert.equal(scene.done, true);
});

test('only a boss spawn opens its introduction, never an attack warning or defeat', () => {
  const event = { id: 1, kind: 'boss' as const, x: 0, z: 20, value: 1 };
  assert.equal(cinematicForEvent({ ...event, text: 'spawn' }, 'combat', false), 'boss');
  assert.equal(cinematicForEvent({ ...event, text: 'telegraph' }, 'combat', false), null);
  assert.equal(cinematicForEvent({ ...event, text: 'defeat' }, 'combat', false), null);
  assert.equal(cinematicForEvent({ ...event, text: 'spawn' }, 'defeat', false), null);
});

test('Encore cannot replace a blocking story or appear after combat ends', () => {
  const event = { id: 2, kind: 'burst' as const, x: 0, z: 0, value: 100 };
  assert.equal(cinematicForEvent(event, 'combat', false), 'burst');
  assert.equal(cinematicForEvent(event, 'combat', true), null);
  assert.equal(cinematicForEvent(event, 'victory', false), null);
});

test('every boss introduction names the heroine shown beside the boss she faces', () => {
  for (const hero of HEROES) {
    for (const sector of SECTORS) {
      const [introduction, taunt] = createCinematic('boss', hero.id, sector.id).frames;
      const context = `${hero.id} against ${sector.bossName}`;
      assert.equal(introduction.speaker, hero.name, `${context}: the speaker must be the pictured heroine`);
      assert.ok(introduction.title.includes(hero.name), `${context}: title must name the heroine`);
      assert.ok(introduction.title.includes(sector.bossName), `${context}: title must name the boss`);
      for (const other of HEROES.filter(item => item.id !== hero.id)) {
        assert.ok(!introduction.title.includes(other.name) && !introduction.speaker.includes(other.name), `${context}: must not name ${other.name}`);
      }
      assert.equal(taunt.speaker, hero.name);
    }
  }
});
