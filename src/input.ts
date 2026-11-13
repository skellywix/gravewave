import { WORLD } from './game/catalog.ts';
import type { Input } from './game/types.ts';

export function pointerTarget(clientX: number, left: number, width: number): number {
  if (![clientX, left, width].every(Number.isFinite) || width <= 0) return 0;
  return Math.max(-WORLD.halfWidth, Math.min(WORLD.halfWidth, ((clientX - left) / width * 2 - 1) * WORLD.halfWidth));
}

export function keyboardDirection(keys: ReadonlySet<string>): number {
  const left = keys.has('ArrowLeft') || keys.has('a') || keys.has('A');
  const right = keys.has('ArrowRight') || keys.has('d') || keys.has('D');
  return Number(right) - Number(left);
}

export function seedFromSearch(search: string): number | null {
  const value = new URLSearchParams(search).get('seed');
  if (!value || !/^\d+$/.test(value)) return null;
  const seed = Number(value);
  return Number.isSafeInteger(seed) && seed > 0 && seed <= 0xffff_ffff ? seed : null;
}

export interface Controls {
  sample(): Input;
  triggerBurst(): void;
  clear(): void;
  dispose(): void;
}

export function createControls(surface: HTMLElement, onPause: () => void): Controls {
  const keys = new Set<string>();
  const sample: Input = { move: 0, targetX: null, burst: false };
  let targetX: number | null = null;
  let pointer: number | null = null;
  let burst = false;
  const point = (event: PointerEvent): void => {
    const rect = surface.getBoundingClientRect();
    targetX = pointerTarget(event.clientX, rect.left, rect.width);
  };
  const down = (event: PointerEvent): void => {
    if (event.button !== 0 || pointer !== null) return;
    event.preventDefault();
    pointer = event.pointerId;
    surface.setPointerCapture(pointer);
    point(event);
    surface.focus({ preventScroll: true });
  };
  const move = (event: PointerEvent): void => {
    if (event.pointerId === pointer) point(event);
  };
  const up = (event: PointerEvent): void => {
    if (event.pointerId !== pointer) return;
    if (surface.hasPointerCapture(event.pointerId)) surface.releasePointerCapture(event.pointerId);
    pointer = null;
  };
  const clear = (): void => { keys.clear(); targetX = null; burst = false; pointer = null; };
  const keydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && !event.repeat) { onPause(); return; }
    const element = event.target;
    if (element instanceof HTMLElement && element.closest('button,input,select,textarea,[contenteditable]')) return;
    if (['ArrowLeft', 'ArrowRight', 'a', 'A', 'd', 'D'].includes(event.key)) {
      event.preventDefault(); keys.add(event.key); targetX = null;
    }
    if (event.code === 'Space') { event.preventDefault(); if (!event.repeat) burst = true; }
  };
  const keyup = (event: KeyboardEvent): void => { keys.delete(event.key); };
  surface.addEventListener('pointerdown', down);
  surface.addEventListener('pointermove', move);
  surface.addEventListener('pointerup', up);
  surface.addEventListener('pointercancel', up);
  window.addEventListener('keydown', keydown);
  window.addEventListener('keyup', keyup);
  window.addEventListener('blur', clear);
  return {
    sample(): Input {
      sample.move = keyboardDirection(keys);
      sample.targetX = sample.move === 0 ? targetX : null;
      sample.burst = burst;
      burst = false;
      return sample;
    },
    triggerBurst(): void { burst = true; },
    clear,
    dispose(): void {
      clear();
      surface.removeEventListener('pointerdown', down);
      surface.removeEventListener('pointermove', move);
      surface.removeEventListener('pointerup', up);
      surface.removeEventListener('pointercancel', up);
      window.removeEventListener('keydown', keydown);
      window.removeEventListener('keyup', keyup);
      window.removeEventListener('blur', clear);
    },
  };
}
