import test from 'node:test';
import assert from 'node:assert/strict';
import { selectSoundCues } from '../src/audio.ts';
import type { GameEvent, EventKind } from '../src/game/types.ts';
const events = (kinds: EventKind[]): GameEvent[] => kinds.map((kind, id) => ({ id, kind, x: 0, z: 0, value: 1 }));

test('an Encore is audible over repetitive weapon fire without unbounded simultaneous voices', () => {
  const cues = selectSoundCues(events([...Array<EventKind>(100).fill('shot'), 'burst', 'damage', 'recruit']));
  assert.ok(cues.length <= 4);
  assert.ok(cues.some(cue => cue.kind === 'burst'));
  assert.equal(cues.filter(cue => cue.kind === 'shot').length, 1);
});

test('success and damage have distinct cues and idle frames create no sounds', () => {
  const cues = selectSoundCues(events(['victory', 'damage']));
  assert.notEqual(cues[0].frequency, cues[1].frequency);
  assert.deepEqual(selectSoundCues([]), []);
});
