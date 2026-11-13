import test from 'node:test';
import assert from 'node:assert/strict';
import { heroAction, skinAction, unseenEvents, escapeHtml, battleCallout } from '../src/ui.ts';
import * as ui from '../src/ui.ts';
import type { Profile, GameEvent } from '../src/game/types.ts';

function profile(): Profile {
  return { version: 1, echoes: 300, ownedHeroes: ['mira'], ownedSkins: ['mira-default', 'rin-default', 'sera-default'], selectedHero: 'mira', equippedSkins: { mira: 'mira-default', rin: 'rin-default', sera: 'sera-default' }, bestScores: { campaign: 0, survival: 0 }, completedRuns: 0, clearedCampaign: false, settledRuns: [], settings: { sound: true, reducedMotion: false }, storySeen: [] };
}

test('the shop differentiates unaffordable, purchasable, owned and equipped outfits', () => {
  const data = profile();
  assert.equal(skinAction(data, 'mira-nocturne').disabled, true);
  data.echoes = 450;
  assert.equal(skinAction(data, 'mira-nocturne').action, 'buy');
  assert.equal(skinAction(data, 'mira-nocturne').disabled, false);
  data.ownedSkins.push('mira-nocturne');
  assert.equal(skinAction(data, 'mira-nocturne').action, 'equip');
  data.equippedSkins.mira = 'mira-nocturne';
  assert.equal(skinAction(data, 'mira-nocturne').action, 'equipped');
  assert.equal(skinAction(data, 'mira-nocturne').disabled, true);
});

test('locked-hero cosmetics can be bought but cannot be equipped', () => {
  const data = profile(); data.echoes = 700;
  assert.equal(heroAction(data, 'rin').action, 'unlock');
  assert.equal(heroAction(data, 'rin').price, 600);
  assert.equal(skinAction(data, 'rin-nocturne').action, 'buy');
  data.ownedSkins.push('rin-nocturne');
  assert.equal(skinAction(data, 'rin-nocturne').action, 'locked');
  assert.equal(skinAction(data, 'rin-nocturne').disabled, true);
});

test('independent event cursors do not replay old hits or lose a new event', () => {
  const events: GameEvent[] = [1, 2, 3].map(id => ({ id, kind: 'hit', x: 0, z: 1, value: 2 }));
  const first = unseenEvents(events, 0);
  assert.deepEqual(first.events.map(event => event.id), [1, 2, 3]);
  assert.equal(first.cursor, 3);
  assert.deepEqual(unseenEvents(events, first.cursor).events, []);
  assert.deepEqual(unseenEvents([...events, { ...events[2], id: 4 }], first.cursor).events.map(event => event.id), [4]);
  assert.equal(unseenEvents([], 9).cursor, 9);
});

test('dynamic labels cannot inject markup or break an attribute', () => {
  assert.equal(escapeHtml('<img src=x onerror="bad()">\'&'), '&lt;img src=x onerror=&quot;bad()&quot;&gt;&#39;&amp;');
});

test('rewards show the earned amount instead of an internal route identifier', () => {
  const event: GameEvent = { id: 1, kind: 'reward', x: 0, z: 0, value: 75, text: 'salvage' };
  const label = battleCallout(event);
  assert.match(label ?? '', /75/);
  assert.doesNotMatch(label ?? '', /salvage/);
  assert.equal(battleCallout({ ...event, kind: 'shot' }), null);
});

test('synergy callouts present the named combination rather than its raw ID', () => {
  const event: GameEvent = { id: 2, kind: 'synergy', x: 0, z: 0, value: 1, text: 'thunder-rail' };
  assert.match(battleCallout(event) ?? '', /Thunder Rail/);
  assert.match(battleCallout({ ...event, text: 'guardian-choir' }) ?? '', /Guardian Choir/);
});

test('a route without a currency payout does not announce a zero reward', () => {
  assert.equal(battleCallout({ id: 3, kind: 'reward', x: 0, z: 0, value: 0, text: 'safe' }), null);
});

test('the sector-clear summary reports the reward paid by the selected route', () => {
  assert.equal(ui.routeClearMessage({ sector: 0, rewardMultiplier: 1 }), 'Act 1 cleared. 150 Echoes earned.');
  assert.equal(ui.routeClearMessage({ sector: 1, rewardMultiplier: 1.5 }), 'Act 2 cleared. 225 Echoes earned.');
});
