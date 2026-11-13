import test from 'node:test';
import assert from 'node:assert/strict';
import { ECONOMY, HEROES, SKINS, getHero, getSkin, getSector } from '../src/game/catalog.ts';

test('invalid roster IDs fail explicitly instead of granting a default item', () => {
  assert.throws(() => getHero('missing'), RangeError);
  assert.throws(() => getSkin('mira-not-owned'), RangeError);
});

test('survival cycles themed sectors without accepting invalid indices', () => {
  assert.equal(getSector(3).id, getSector(0).id);
  assert.equal(getSector(7).id, getSector(1).id);
  for (const index of [-1, 0.5, NaN, Infinity]) assert.throws(() => getSector(index), RangeError);
});

test('the first sector clear makes the lowest-price outfit affordable', () => {
  const cheapest = Math.min(...SKINS.filter(skin => skin.price > 0).map(skin => skin.price));
  assert.ok(ECONOMY.starterEchoes < cheapest);
  assert.ok(ECONOMY.starterEchoes + ECONOMY.sectorClear >= cheapest);
  assert.ok(ECONOMY.settlementCap > ECONOMY.sectorClear * 3 + ECONOMY.campaignWin + ECONOMY.salvageRoute * 2);
});

test('every adult heroine has distinct readable default and cosmetic appearances', () => {
  for (const hero of HEROES) {
    assert.ok(hero.age >= 25);
    const outfits = SKINS.filter(skin => skin.hero === hero.id);
    assert.equal(outfits.length, 3);
    assert.equal(getSkin(`${hero.id}-default`).price, 0);
    assert.equal(new Set(outfits.map(skin => skin.portrait)).size, 3);
    assert.equal(new Set(outfits.map(skin => skin.palette.body)).size, 3);
  }
});
