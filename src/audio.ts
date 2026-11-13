import type { EventKind, GameEvent } from './game/types.ts';

export interface SoundCue { kind: EventKind; frequency: number; end: number; duration: number; volume: number; type: OscillatorType; priority: number }
const CUES: Partial<Record<EventKind, SoundCue>> = {
  shot: { kind: 'shot', frequency: 640, end: 260, duration: 0.055, volume: 0.025, type: 'triangle', priority: 1 },
  hit: { kind: 'hit', frequency: 170, end: 80, duration: 0.045, volume: 0.03, type: 'square', priority: 0 },
  kill: { kind: 'kill', frequency: 410, end: 820, duration: 0.11, volume: 0.045, type: 'triangle', priority: 2 },
  recruit: { kind: 'recruit', frequency: 660, end: 990, duration: 0.2, volume: 0.075, type: 'sine', priority: 5 },
  crate: { kind: 'crate', frequency: 220, end: 880, duration: 0.19, volume: 0.06, type: 'triangle', priority: 4 },
  damage: { kind: 'damage', frequency: 140, end: 45, duration: 0.22, volume: 0.08, type: 'sawtooth', priority: 7 },
  boss: { kind: 'boss', frequency: 82, end: 123, duration: 0.55, volume: 0.09, type: 'sawtooth', priority: 8 },
  burst: { kind: 'burst', frequency: 220, end: 1760, duration: 0.42, volume: 0.12, type: 'triangle', priority: 10 },
  synergy: { kind: 'synergy', frequency: 440, end: 1320, duration: 0.4, volume: 0.08, type: 'sine', priority: 9 },
  reward: { kind: 'reward', frequency: 784, end: 1046, duration: 0.17, volume: 0.07, type: 'sine', priority: 5 },
  victory: { kind: 'victory', frequency: 880, end: 1760, duration: 0.7, volume: 0.1, type: 'triangle', priority: 12 },
  defeat: { kind: 'defeat', frequency: 330, end: 82, duration: 0.65, volume: 0.08, type: 'triangle', priority: 12 },
};

export function selectSoundCues(events: readonly GameEvent[]): SoundCue[] {
  const kinds = new Set(events.map(event => event.kind));
  return [...kinds].map(kind => CUES[kind]).filter((cue): cue is SoundCue => cue !== undefined).sort((a, b) => b.priority - a.priority).slice(0, 4);
}

export interface GameAudio {
  unlock(): Promise<void>;
  play(events: readonly GameEvent[]): void;
  setEnabled(value: boolean): void;
  setMusic(value: boolean): void;
  dispose(): Promise<void>;
}

export function createAudio(initialEnabled: boolean): GameAudio {
  let context: AudioContext | null = null;
  let enabled = initialEnabled;
  let playing = false;
  let timer: number | undefined;
  let step = 0;
  let voices = 0;
  const melody = [659.25, 0, 783.99, 739.99, 659.25, 493.88, 587.33, 0, 659.25, 783.99, 987.77, 783.99, 739.99, 587.33, 493.88, 0];
  const tone = (frequency: number, end: number, duration: number, volume: number, type: OscillatorType): void => {
    if (!enabled || !context || context.state !== 'running' || voices >= 16) return;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const now = context.currentTime;
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, now);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(20, end), now + duration);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(volume, now + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    oscillator.connect(gain); gain.connect(context.destination); voices++;
    oscillator.onended = (): void => { oscillator.disconnect(); gain.disconnect(); voices--; };
    oscillator.start(now); oscillator.stop(now + duration + 0.02);
  };
  const updateMusic = (): void => {
    window.clearInterval(timer); timer = undefined;
    if (!playing || !enabled || !context || context.state !== 'running') return;
    timer = window.setInterval(() => {
      const note = melody[step % melody.length];
      if (note > 0) tone(note, note, 0.17, 0.028, 'triangle');
      if (step % 4 === 0) tone(step % 16 < 8 ? 82.41 : 73.42, 55, 0.28, 0.045, 'sine');
      step++;
    }, 230);
  };
  return {
    async unlock(): Promise<void> {
      if (!enabled) return;
      if (!context) context = new AudioContext();
      if (context.state === 'suspended') await context.resume();
      if (context.state !== 'running') throw new Error('Audio is not available in this browser session.');
      updateMusic();
    },
    play(events): void { for (const cue of selectSoundCues(events)) tone(cue.frequency, cue.end, cue.duration, cue.volume, cue.type); },
    setEnabled(value): void { enabled = value; updateMusic(); },
    setMusic(value): void { if (playing === value) return; playing = value; updateMusic(); },
    async dispose(): Promise<void> {
      playing = false;
      window.clearInterval(timer);
      timer = undefined;
      if (context) await context.close();
      context = null;
    },
  };
}
