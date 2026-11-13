import { ECONOMY, HEROES, SKINS, getHero, getSkin } from './game/catalog.ts';
import type { GameEvent, GameState, HeroId, Mode, Profile, SkinId, SynergyId } from './game/types.ts';

export interface ActionState {
  action: 'buy' | 'equip' | 'equipped' | 'unlock' | 'select' | 'selected' | 'locked';
  label: string;
  price: number;
  disabled: boolean;
}
const numbers = new Intl.NumberFormat('en-US');
export function numberLabel(value: number): string { return numbers.format(Math.floor(value)); }
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}
export function heroAction(profile: Profile, id: HeroId): ActionState {
  const hero = getHero(id);
  if (!profile.ownedHeroes.includes(id)) return { action: 'unlock', label: `Unlock ${hero.name}`, price: hero.price, disabled: profile.echoes < hero.price };
  const selected = profile.selectedHero === id;
  return { action: selected ? 'selected' : 'select', label: selected ? 'Your headliner' : `Select ${hero.name}`, price: 0, disabled: selected };
}
export function skinAction(profile: Profile, id: SkinId): ActionState {
  const skin = getSkin(id);
  if (!profile.ownedSkins.includes(id)) return { action: 'buy', label: 'Unlock outfit', price: skin.price, disabled: profile.echoes < skin.price };
  if (!profile.ownedHeroes.includes(skin.hero)) return { action: 'locked', label: `Unlock ${getHero(skin.hero).name} first`, price: 0, disabled: true };
  const equipped = profile.equippedSkins[skin.hero] === id;
  return { action: equipped ? 'equipped' : 'equip', label: equipped ? 'Equipped' : 'Wear this outfit', price: 0, disabled: equipped };
}
export function unseenEvents(events: readonly GameEvent[], cursor: number): { events: GameEvent[]; cursor: number } {
  const fresh = events.filter(event => event.id > cursor);
  return { events: fresh, cursor: fresh.reduce((last, event) => Math.max(last, event.id), cursor) };
}

export function routeClearMessage(state: Pick<GameState, 'sector' | 'rewardMultiplier'>): string {
  const reward = Math.round(ECONOMY.sectorClear * state.rewardMultiplier);
  return `Act ${state.sector + 1} cleared. ${numberLabel(reward)} Echoes earned.`;
}

export const SYNERGY_LABELS: Readonly<Record<SynergyId, string>> = {
  'thunder-rail': 'Thunder Rail', 'prism-barrage': 'Prism Barrage', 'guardian-choir': 'Guardian Choir',
};
export function battleCallout(event: GameEvent): string | null {
  if (event.kind === 'recruit') return `+${event.value} GHOST FANS`;
  if (event.kind === 'crate') return 'AMPLIFIER BROKEN · POWER UP';
  if (event.kind === 'damage') return `−${Math.round(event.value)} VITALS`;
  if (event.kind === 'reward') return event.value > 0 ? `+${numberLabel(event.value)} ECHOES` : null;
  if (event.kind === 'synergy' && event.text && Object.hasOwn(SYNERGY_LABELS, event.text)) return `${SYNERGY_LABELS[event.text as SynergyId]} · SYNERGY`;
  return null;
}

const ICON_PATHS: Record<string, string> = {
  moon: '<path d="M19 13A8 8 0 0 1 11 3a8 8 0 1 0 8 10Z"/>',
  ghost: '<path d="M5 20V10a7 7 0 0 1 14 0v10l-3-2-4 2-4-2-3 2Z"/><path d="M9 10v2m6-2v2"/>',
  diamond: '<path d="m12 2 8 10-8 10L4 12 8 2Z"/><path d="m4 12 8 4 8-4M8 2l4 14 4-14"/>',
  play: '<path d="m8 4 12 8-12 8Z"/>',
  pause: '<path d="M8 5v14m8-14v14"/>',
  sound: '<path d="m4 9 4 0 5-4v14l-5-4H4Z"/><path d="M17 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>',
  muted: '<path d="m4 9 4 0 5-4v14l-5-4H4Z"/><path d="m17 9 5 6m0-6-5 6"/>',
  hanger: '<path d="M10 6a2 2 0 1 1 2 2v2L3 17v2h18v-2l-9-7"/>',
  arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
  star: '<path d="m12 2 2.5 7.5L22 12l-7.5 2.5L12 22l-2.5-7.5L2 12l7.5-2.5Z"/>',
};
export function icon(name: string): string {
  return `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[name] ?? ICON_PATHS.star}</svg>`;
}

export function appShell(): string {
  return `<main id="shell">
    <section id="menu" aria-label="Backstage"></section>
    <section id="play" hidden aria-label="The parade">
      <div id="arena-frame"><canvas id="arena" tabindex="0" aria-label="Game arena. Drag or tap to steer, or use A and D. Space triggers Encore."></canvas>
        <div id="world-labels" aria-hidden="true"></div>
        <header class="battle-top"><div class="act-label"><span id="mode-label">Campaign</span><strong id="sector-label">Ghostlight Pier</strong><span id="sector-clock">00:00</span></div><button id="pause-button" class="icon-button" data-action="pause" aria-label="Pause game">${icon('pause')}</button></header>
        <div class="battle-vitals"><img id="hud-portrait" alt="" width="52" height="64"><div class="health-stack"><div><span>VITALS</span><strong id="health-text">100 / 100</strong></div><div id="health-meter" role="progressbar" aria-label="Health" aria-valuemin="0" aria-valuemax="100" aria-valuenow="100"><i id="health-fill"></i></div><small id="shield-text">No shield</small></div></div>
        <div class="battle-counts"><span>${icon('ghost')}<b id="fans-text">1</b><small>FANS</small></span><span><b id="power-text">1.0</b><small>POWER</small></span><span>${icon('diamond')}<b id="run-echoes">0</b><small>ECHOES</small></span></div>
        <div id="boss-bar" hidden><div><span id="boss-name"></span><b id="boss-health"></b></div><div class="boss-track"><i id="boss-fill"></i></div></div>
        <div id="synergy-strip" aria-label="Active synergies"></div><div id="battle-callout" role="status"></div>
        <footer class="battle-bottom"><p id="steer-hint">DRAG OR TAP TO STEER <span>·</span> AUTO-FIRE</p><button id="encore-button" data-action="encore" disabled><i id="encore-fill"></i><span>${icon('star')}<strong>ENCORE</strong><small id="charge-text">0%</small></span></button><div class="battle-score">SCORE <b id="score-text">0</b><span>SPACE · ENCORE &nbsp; ESC · PAUSE</span></div></footer>
      </div>
    </section>
    <div id="dialog-layer" hidden></div><div id="cinema-layer" hidden></div>
    <div id="toast" role="status" aria-live="polite" hidden></div>
    <div id="save-warning" role="status" hidden></div>
  </main>`;
}

export function menuMarkup(profile: Profile, heroId: HeroId, skinId: SkinId, mode: Mode, wardrobe: boolean): string {
  const hero = getHero(heroId);
  const skin = getSkin(skinId);
  const heroState = heroAction(profile, heroId);
  const skinState = skinAction(profile, skinId);
  const unlocked = profile.ownedHeroes.includes(heroId);
  const outfitList = SKINS.filter(item => item.hero === heroId);
  const description = wardrobe ? skin.description : hero.description;
  const action = wardrobe ? skinState : heroState;
  const price = action.price > 0 ? `<span>${icon('diamond')}${numberLabel(action.price)}</span>` : '';
  const actionButton = wardrobe || !unlocked ? `<button class="outfit-action" data-action="${wardrobe ? 'skin-action' : 'hero-action'}" ${action.disabled ? 'disabled' : ''}>${escapeHtml(action.label)}${price}</button>` : '';
  return `<div class="backstage" style="--accent:${skin.palette.trim}">
    <header class="backstage-top"><a class="wordmark" href="./" aria-label="Gravewave home">${icon('moon')}<span>GRAVEWAVE<small>MIDNIGHT PARADE</small></span></a><div class="wallet" aria-label="${profile.echoes} earned Echoes">${icon('diamond')}<strong id="balance">${numberLabel(profile.echoes)}</strong><span>ECHOES</span></div></header>
    <div class="backstage-body"><div class="editorial-rail"><span>THE DEAD HAVE<br>EXCELLENT TASTE.</span><i></i><small>VOL. 01<br>AFTER MIDNIGHT</small></div>
      <div class="hero-showcase"><div class="portrait-frame"><img class="hero-portrait" src="./${skin.portrait}" alt="${escapeHtml(hero.name)}, ${hero.age}, wearing ${escapeHtml(skin.name)}" fetchpriority="high"><div class="portrait-shade"></div><span class="portrait-edition">${escapeHtml(skin.collection)}<i>COLLECTION</i></span><div class="hero-caption"><h1>${escapeHtml(hero.name)}</h1><span>${escapeHtml(hero.role)}</span><p>“${escapeHtml(hero.tagline)}”</p></div></div>
      <nav class="hero-selector" aria-label="Choose your heroine">${HEROES.map((item, index) => {
    const equipped = getSkin(profile.equippedSkins[item.id]);
    const owned = profile.ownedHeroes.includes(item.id);
    return `<button data-action="hero" data-id="${item.id}" class="hero-thumb ${item.id === heroId ? 'active' : ''}" aria-pressed="${item.id === heroId}" aria-label="Preview ${item.name}${owned ? '' : ', locked'}"><img src="./${equipped.portrait}" alt="" width="64" height="80"><span>${item.name}</span>${owned ? '' : '<i>LOCKED</i>'}</button>`;
  }).join('')}</nav></div>
      <aside class="mission-strip ${wardrobe ? 'mission-wardrobe' : 'mission-home'}"><h2>${wardrobe ? 'Dress for the<br>afterlife.' : 'Cute company.<br>Deadly chemistry.'}</h2><p class="mission-description">${escapeHtml(description)}</p>
        ${wardrobe ? `<div class="outfit-list" aria-label="${hero.name} outfits">${outfitList.map(item => `<button data-action="outfit" data-id="${item.id}" class="outfit-thumb ${item.id === skinId ? 'active' : ''}" aria-pressed="${item.id === skinId}" aria-label="Preview ${escapeHtml(item.name)}"><img src="./${item.portrait}" alt="" width="80" height="100"><span>${escapeHtml(item.collection)}</span><small>${profile.ownedSkins.includes(item.id) ? 'OWNED' : `${numberLabel(item.price)} ECHOES`}</small></button>`).join('')}</div><h3 class="outfit-name">${escapeHtml(skin.name)}</h3>` : `<div class="weapon-line">${icon('star')}<span>${escapeHtml(hero.weapon)}<small>ENCORE · ${escapeHtml(hero.burstName)}</small></span></div>`}
        ${actionButton}
        ${action.disabled && action.price > profile.echoes ? `<p class="earn-note">${numberLabel(action.price - profile.echoes)} more Echoes. Earn them in the parade.</p>` : ''}
        <div class="mode-switch" role="group" aria-label="Game mode"><button data-action="mode" data-mode="campaign" aria-pressed="${mode === 'campaign'}"><strong>Campaign</strong><small>THREE ACTS · ONE CURSE</small></button><button data-action="mode" data-mode="survival" aria-pressed="${mode === 'survival'}"><strong>Survival</strong><small>THE SHOW NEVER ENDS</small></button></div>
        <button id="start-run" class="primary-button" data-action="start" ${unlocked ? '' : 'disabled'}><span>${unlocked ? 'Start the parade' : `Unlock ${hero.name} to play`}</span>${icon('arrow')}</button>
        <div class="mission-foot"><button class="text-button" data-action="wardrobe">${icon('hanger')}${wardrobe ? 'Back to backstage' : 'Open wardrobe'}</button><span>BEST ${numberLabel(profile.bestScores[mode])}</span></div>
        <p class="controls-note">Drag or tap to steer. Auto-fire does the rest.<br>A / D or arrows · Space for Encore</p>
      </aside></div>
    <footer class="backstage-footer"><span>NO TICKETS. NO TIMERS. JUST ONE MORE RUN.</span><div><button data-action="sound" aria-pressed="${profile.settings.sound}" aria-label="${profile.settings.sound ? 'Mute sound' : 'Enable sound'}">${icon(profile.settings.sound ? 'sound' : 'muted')}<span>Sound ${profile.settings.sound ? 'on' : 'off'}</span></button><button data-action="motion" aria-pressed="${profile.settings.reducedMotion}">Motion: ${profile.settings.reducedMotion ? 'reduced' : 'full'}</button><button data-action="help">How to play</button></div></footer>
  </div>`;
}
