import test from 'node:test';
import assert from 'node:assert/strict';
import { pointerTarget, keyboardDirection, seedFromSearch } from '../src/input.ts';
import { WORLD } from '../src/game/catalog.ts';

test('phone steering maps the visible canvas and clamps outside touches', () => {
  assert.equal(pointerTarget(110, 10, 200), 0);
  assert.equal(pointerTarget(10, 10, 200), -WORLD.halfWidth);
  assert.equal(pointerTarget(210, 10, 200), WORLD.halfWidth);
  assert.equal(pointerTarget(-500, 10, 200), -WORLD.halfWidth);
  assert.equal(pointerTarget(900, 10, 200), WORLD.halfWidth);
  assert.equal(pointerTarget(10, 0, 0), 0);
  assert.equal(pointerTarget(NaN, 0, 100), 0);
});

test('opposing keys cancel and shifted keyboard controls still steer', () => {
  assert.equal(keyboardDirection(new Set(['a'])), -1);
  assert.equal(keyboardDirection(new Set(['D'])), 1);
  assert.equal(keyboardDirection(new Set(['ArrowLeft', 'ArrowRight'])), 0);
  assert.equal(keyboardDirection(new Set(['A', 'd'])), 0);
  assert.equal(keyboardDirection(new Set()), 0);
});

test('a reproducibility seed accepts only a positive uint32, not coerced text', () => {
  assert.equal(seedFromSearch('?seed=12345'), 12345);
  assert.equal(seedFromSearch('?seed=4294967295'), 4294967295);
  for (const search of ['', '?seed=0', '?seed=-1', '?seed=NaN', '?seed=Infinity', '?seed=1.5', '?seed=4294967296', '?seed=12junk', '?seed=']) {
    assert.equal(seedFromSearch(search), null, search);
  }
});
