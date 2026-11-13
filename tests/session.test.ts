import test from 'node:test';
import assert from 'node:assert/strict';
import { createSession } from '../src/session.ts';
import { createRun } from '../src/game/engine.ts';
import { defaultProfile, SAVE_KEY } from '../src/game/progression.ts';
import type { StorageLike } from '../src/game/types.ts';

function memory(raw: string | null = null): StorageLike & { writes: number; raw: string | null } {
  return { raw, writes: 0, getItem() { return this.raw; }, setItem(_key, value) { this.raw = value; this.writes++; } };
}

test('an unreadable saved profile is preserved while temporary progress remains playable', () => {
  const store = memory('{broken');
  const session = createSession(store);
  assert.equal(session.persistence, 'protected');
  const run = createRun(123, 'mira', 'campaign', 'terminal-a'); run.phase = 'defeat'; run.echoes = 175;
  assert.equal(session.settle(run).ok, true);
  assert.equal(session.profile.echoes, 475);
  session.setSetting('sound', false);
  assert.equal(store.raw, '{broken');
  assert.equal(store.writes, 0);
  assert.ok(session.warning);
});

test('a completed run pays once, survives reload and buys an outfit at the catalog price', () => {
  const store = memory();
  const session = createSession(store);
  const run = createRun(123, 'mira', 'campaign', 'terminal-b'); run.phase = 'defeat'; run.echoes = 175;
  assert.equal(session.settle(run).ok, true);
  assert.equal(session.settle(run).ok, false);
  assert.equal(session.buy('skin', 'mira-nocturne').ok, true);
  assert.equal(session.profile.echoes, 75);
  assert.equal(session.wear('mira-nocturne').ok, true);
  const reloaded = createSession(store);
  assert.equal(reloaded.profile.equippedSkins.mira, 'mira-nocturne');
  assert.equal(reloaded.profile.echoes, 75);
  assert.equal(reloaded.settle(run).ok, false);
});

test('storage write failure keeps the earned in-memory state and exposes recovery', () => {
  const store: StorageLike = { getItem: () => null, setItem: () => { throw new Error('private internals'); } };
  const session = createSession(store);
  session.setSetting('sound', false);
  assert.equal(session.profile.settings.sound, false);
  assert.equal(session.persistence, 'unavailable');
  assert.ok(session.warning);
  assert.ok(!session.warning?.includes('private internals'));
});

test('locked selection and unfinished-run settlement never write or grant rewards', () => {
  const store = memory(); const session = createSession(store);
  assert.equal(session.chooseHero('rin').ok, false);
  const run = createRun(1, 'mira', 'campaign', 'not-finished');
  assert.equal(session.settle(run).ok, false);
  assert.equal(session.profile.echoes, 300);
  assert.equal(store.writes, 0);
});

test('story memory is persisted once and a purchased heroine can wear her owned outfit', () => {
  const initial = defaultProfile(); initial.echoes = 1500;
  const store = memory(JSON.stringify(initial)); const session = createSession(store);
  session.seeStory('deploy'); session.seeStory('deploy');
  assert.equal(store.writes, 1);
  assert.equal(session.buy('hero', 'rin').ok, true);
  assert.equal(session.chooseHero('rin').ok, true);
  assert.equal(session.buy('skin', 'rin-festival').ok, true);
  assert.equal(session.wear('rin-festival').ok, true);
  assert.equal(createSession(store).profile.selectedHero, 'rin');
  assert.ok(JSON.parse(store.getItem(SAVE_KEY)!).storySeen.includes('deploy'));
});

test('an unreadable storage device is never overwritten by a fresh temporary profile', () => {
  let writes = 0;
  const store: StorageLike = { getItem: () => { throw new Error('blocked'); }, setItem: () => { writes++; } };
  const session = createSession(store);
  session.setSetting('sound', false);
  session.retrySaving();
  assert.equal(writes, 0);
  assert.ok(session.warning);
});
