import './style.css';
import { ECONOMY, HEROES, SKINS, UPGRADES, WORLD, getHero, getSector, getSkin } from './game/catalog.ts';
import { activeSynergies, chooseRoute, chooseUpgrade, createRun, tick } from './game/engine.ts';
import type { GameState, HeroId, Mode, ProfileResult, RouteId, SceneHandle, SkinId, StorageLike, UpgradeId } from './game/types.ts';
import { createScene } from './render/scene.ts';
import { createControls, seedFromSearch } from './input.ts';
import { createCinematic, advanceCinematic, nextCinematicFrame, skipCinematic, cinematicForEvent } from './cinematics.ts';
import type { Cinematic, CinematicKind } from './cinematics.ts';
import { createAudio } from './audio.ts';
import { createSession } from './session.ts';
import { appShell, escapeHtml, heroAction, icon, menuMarkup, numberLabel, skinAction, unseenEvents, battleCallout, routeClearMessage, SYNERGY_LABELS } from './ui.ts';

const root = document.querySelector<HTMLDivElement>('#app');
if (!root) throw new Error('The game mount is missing.');
root.innerHTML = appShell();
function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing game element: ${id}`);
  return found as T;
}
const storage: StorageLike = {
  getItem: key => window.localStorage.getItem(key),
  setItem: (key, value) => window.localStorage.setItem(key, value),
};
const session = createSession(storage);
const audio = createAudio(session.profile.settings.sound);
const canvas = element<HTMLCanvasElement>('arena');
const menu = element('menu');
const play = element('play');
const dialogLayer = element('dialog-layer');
const cinemaLayer = element('cinema-layer');
const worldLabels = element('world-labels');
const controls = createControls(canvas, togglePause);
let hero: HeroId = session.profile.selectedHero;
let skin: SkinId = session.profile.equippedSkins[hero];
let mode: Mode = 'campaign';
let wardrobe = false;
let run: GameState | null = null;
let scene: SceneHandle | null = null;
let paused = false;
let fatal = false;
let graphicsAvailable = true;
let cinema: Cinematic | null = null;
let cinemaKey = '';
let afterCinema: (() => void) | null = null;
let dialogKind = '';
let returnFocus: HTMLElement | null = null;
let eventCursor = 0;
let accumulator = 0;
let previousTime = performance.now();
let hudTime = 0;
let calloutUntil = 0;
let toastTimer: number | undefined;
let firstSeed = seedFromSearch(location.search);
const labelNodes = new Map<number, HTMLDivElement>();
const reducedBySystem = matchMedia('(prefers-reduced-motion: reduce)').matches;
const motionReduced = (): boolean => session.profile.settings.reducedMotion || reducedBySystem;
const clock = (seconds: number): string => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

function notify(message: string): void {
  const toast = element('toast'); toast.textContent = message; toast.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { toast.hidden = true; }, 4000);
}
function updateSaveWarning(): void {
  const warning = element('save-warning'); warning.hidden = session.warning === null;
  warning.replaceChildren();
  if (!session.warning) return;
  const text = document.createElement('span');
  text.textContent = `${session.warning} Progress this session is temporary. `;
  warning.append(text);
  if (session.persistence === 'unavailable') {
    const retry = document.createElement('button'); retry.dataset.action = 'save-retry'; retry.textContent = 'Retry saving'; warning.append(retry);
  }
}
function apply(result: ProfileResult): boolean {
  notify(result.message); updateSaveWarning(); return result.ok;
}
function showMenu(): void {
  play.hidden = true; menu.hidden = false; paused = false; run = null;
  controls.clear(); closeDialog(); hideCinema(); audio.setMusic(false);
  scene?.dispose(); scene = null; labelNodes.clear(); worldLabels.replaceChildren();
  hero = session.profile.selectedHero; skin = session.profile.equippedSkins[hero];
  renderMenu();
}
function renderMenu(): void {
  document.documentElement.dataset.motion = motionReduced() ? 'reduced' : 'full';
  menu.innerHTML = menuMarkup(session.profile, hero, skin, mode, wardrobe);
  updateSaveWarning();
}
function focusFirst(layer: HTMLElement): void {
  layer.querySelector<HTMLElement>('button:not(:disabled),[tabindex="0"]')?.focus({ preventScroll: true });
}
function openDialog(kind: string, title: string, body: string): void {
  controls.clear(); accumulator = 0; dialogKind = kind;
  if (dialogLayer.hidden) returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  dialogLayer.innerHTML = `<section class="dialog ${kind}" role="dialog" aria-modal="true" aria-labelledby="dialog-title"><h2 id="dialog-title">${escapeHtml(title)}</h2>${body}</section>`;
  dialogLayer.hidden = false; focusFirst(dialogLayer);
}
function closeDialog(): void {
  dialogLayer.hidden = true; dialogLayer.replaceChildren(); dialogKind = '';
  if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  returnFocus = null;
}
function hideCinema(): void {
  cinema = null; cinemaKey = ''; afterCinema = null; cinemaLayer.hidden = true; cinemaLayer.replaceChildren();
}
function finishCinema(): void {
  const callback = afterCinema; hideCinema(); accumulator = 0;
  callback?.();
  if (run && dialogLayer.hidden) canvas.focus({ preventScroll: true });
}
function showCinema(kind: CinematicKind, next: (() => void) | null = null): void {
  if (!run) return;
  cinema = createCinematic(kind, run.hero, run.sector); afterCinema = next; cinemaKey = '';
  if (cinema.blocking) controls.clear();
  paintCinema();
}
function paintCinema(): void {
  if (!cinema || !run) return;
  const key = `${cinema.kind}:${cinema.index}`;
  if (cinemaKey === key) return;
  cinemaKey = key;
  const frame = cinema.frames[cinema.index];
  const portrait = getSkin(session.profile.equippedSkins[run.hero]);
  cinemaLayer.hidden = false;
  cinemaLayer.className = cinema.blocking ? 'cinema-blocking' : 'cinema-burst';
  cinemaLayer.innerHTML = `<section class="cinematic ${cinema.kind}" ${cinema.blocking ? 'role="dialog" aria-modal="true"' : 'role="status"'} aria-label="${escapeHtml(frame.title)}"><img src="./${portrait.portrait}" alt="${escapeHtml(getHero(run.hero).name)}" class="cinema-art"><div class="cinema-copy"><h2>${escapeHtml(frame.title)}</h2><span class="speaker">${escapeHtml(frame.speaker)}</span><p>${escapeHtml(frame.line)}</p>${cinema.blocking ? '<button class="text-button" data-action="cinema-next">Continue ' + icon('arrow') + '</button>' : ''}</div>${cinema.blocking ? '<button class="skip-button" data-action="cinema-skip">Skip scene</button>' : ''}</section>`;
  if (cinema.blocking) focusFirst(cinemaLayer);
}
async function unlockAudio(): Promise<void> {
  try { await audio.unlock(); } catch { notify('Sound could not start. You can keep playing or try Sound again.'); }
}
function randomSeed(): number { return crypto.getRandomValues(new Uint32Array(1))[0] || 1; }
function runId(): string { return [...crypto.getRandomValues(new Uint32Array(4))].map(value => value.toString(16).padStart(8, '0')).join(''); }
function startRun(): void {
  if (!session.profile.ownedHeroes.includes(hero)) return;
  if (session.profile.selectedHero !== hero) { if (!apply(session.chooseHero(hero))) return; }
  closeDialog(); hideCinema(); controls.clear();
  const seed = firstSeed ?? randomSeed(); firstSeed = null;
  run = createRun(seed, hero, mode, runId()); paused = false; fatal = false; eventCursor = 0; accumulator = 0;
  menu.hidden = true; play.hidden = false;
  scene?.dispose(); scene = null; labelNodes.clear(); worldLabels.replaceChildren();
  try {
    scene = createScene(canvas, { hero, skin: session.profile.equippedSkins[hero], reducedMotion: motionReduced(), pixelRatio: window.devicePixelRatio });
    resize(); scene.render(run, 0);
  } catch {
    fatal = true;
    openDialog('error', 'The stage could not open', '<p>This browser could not start WebGL. Try a current browser with hardware acceleration enabled.</p><button class="primary-button" data-action="home">Back to backstage</button>');
    return;
  }
  element<HTMLImageElement>('hud-portrait').src = `./${getSkin(session.profile.equippedSkins[hero]).portrait}`;
  updateHUD(); void unlockAudio();
  if (!session.profile.storySeen.includes('deploy')) showCinema('deploy', () => { session.seeStory('deploy'); updateSaveWarning(); });
  else canvas.focus({ preventScroll: true });
}
function resize(): void {
  if (!scene || play.hidden) return;
  const bounds = canvas.getBoundingClientRect(); scene.resize(bounds.width, bounds.height);
}
new ResizeObserver(resize).observe(element('arena-frame'));
function togglePause(): void {
  if (!run || fatal || run.phase === 'victory' || run.phase === 'defeat' || cinema?.blocking) return;
  if (paused && !graphicsAvailable) { notify('Graphics are still recovering. Please wait.'); return; }
  if (paused) { paused = false; closeDialog(); canvas.focus({ preventScroll: true }); void unlockAudio(); return; }
  if (run.phase !== 'combat') return;
  if (cinema && !cinema.blocking) hideCinema();
  paused = true; controls.clear();
  openDialog('pause', 'The dead can wait.', '<p>Your parade is paused.</p><button class="primary-button" data-action="resume">Back to the noise</button><button class="secondary-button" data-action="sound">Toggle sound</button><button class="text-button" data-action="abandon">End run & collect Echoes</button>');
}
function choices(): void {
  if (!run) return;
  if (run.phase === 'upgrade') {
    const cards = run.offers.map(id => {
      const upgrade = UPGRADES.find(item => item.id === id)!;
      return `<button class="upgrade-choice" data-action="upgrade" data-id="${id}"><h3>${escapeHtml(upgrade.name)}</h3><span class="upgrade-family">${escapeHtml(upgrade.family)} · RANK ${run!.upgrades[id] + 1}/${upgrade.maxLevel}</span><p>${escapeHtml(upgrade.description)}</p><strong>${escapeHtml(upgrade.detail)}</strong></button>`;
    }).join('');
    openDialog('upgrades', 'Remix your set list.', `<p>Pick one. The crowd will notice.</p><div class="upgrade-choices">${cards}</div><small class="synergy-help">Silver Needle + Static Kiss = Thunder Rail<br>Crowd Pleaser + Broken Record = Prism Barrage<br>Lace Aegis + Sweet Requiem = Guardian Choir</small>`);
  } else if (run.phase === 'route') {
    openDialog('routes', 'Where to next?', `<p>${routeClearMessage(run)}</p><div class="route-choices"><button data-action="route" data-id="safe"><h3>Quiet procession</h3><p>Recover ${ECONOMY.safeHeal} health. Standard enemies and rewards.</p></button><button data-action="route" data-id="redline"><h3>Raise the dead</h3><p>Next act: 25% tougher enemies. 50% more kill, amplifier, and boss-clear Echoes.</p></button><button data-action="route" data-id="salvage"><h3>Afterparty detour</h3><p>Collect ${ECONOMY.salvageRoute} extra Echoes. No healing.</p></button></div>`);
  }
}
function showResults(): void {
  if (!run) return;
  const won = run.phase === 'victory';
  openDialog('results', won ? 'The moon is yours.' : 'That was rehearsal.', `<p>${won ? 'Three acts. One broken curse. An unforgettable night.' : 'Keep your Echoes. Change the set list. Go again.'}</p><dl class="result-stats"><div><dt>Score</dt><dd>${numberLabel(run.score)}</dd></div><div><dt>Echoes earned</dt><dd>${numberLabel(Math.min(run.echoes, ECONOMY.settlementCap))}</dd></div><div><dt>Time on stage</dt><dd>${clock(run.elapsed)}</dd></div><div><dt>Ghostly takedowns</dt><dd>${numberLabel(run.kills)}</dd></div></dl><p class="result-balance">Your wardrobe fund: <strong>${numberLabel(session.profile.echoes)} Echoes</strong></p><button class="primary-button" data-action="retry">One more parade ${icon('arrow')}</button><button class="secondary-button" data-action="home">Backstage & wardrobe</button><small class="run-seed">Run seed ${run.seed} · ${run.mode}</small>`);
}
function terminal(): void {
  if (!run) return;
  session.settle(run); updateSaveWarning(); controls.clear(); audio.setMusic(false);
  showCinema(run.phase === 'victory' ? 'victory' : 'defeat', showResults);
}
function processEvents(): void {
  if (!run) return;
  const fresh = unseenEvents(run.events, eventCursor); eventCursor = fresh.cursor;
  audio.play(fresh.events);
  for (const event of fresh.events) {
    const sceneKind = cinematicForEvent(event, run.phase, cinema?.blocking ?? false);
    if (sceneKind) showCinema(sceneKind);
    const label = battleCallout(event);
    if (label) {
      element('battle-callout').textContent = label; element('battle-callout').dataset.kind = event.kind; calloutUntil = performance.now() + 1600;
    }
  }
}
function updateHUD(): void {
  if (!run) return;
  const player = run.player; const sector = getSector(run.sector);
  element('mode-label').textContent = `${mode === 'campaign' ? 'Campaign' : 'Survival'} · Act ${run.sector + 1}`;
  element('sector-label').textContent = sector.name;
  element('sector-clock').textContent = clock(run.sectorTime);
  element('health-text').textContent = `${Math.ceil(player.health)} / ${player.maxHealth}`;
  element('health-fill').style.width = `${Math.max(0, player.health / player.maxHealth * 100)}%`;
  element('health-meter').setAttribute('aria-valuenow', String(Math.ceil(player.health)));
  element('health-meter').setAttribute('aria-valuemax', String(player.maxHealth));
  element('shield-text').textContent = player.shield > 0 ? `${Math.ceil(player.shield)} shield` : 'No shield';
  element('fans-text').textContent = String(player.squad); element('power-text').textContent = player.power.toFixed(1);
  element('run-echoes').textContent = numberLabel(run.echoes); element('score-text').textContent = numberLabel(run.score);
  const encore = element<HTMLButtonElement>('encore-button'); encore.disabled = player.charge < 100 || run.phase !== 'combat' || paused;
  element('charge-text').textContent = player.charge >= 100 ? 'READY' : `${Math.floor(player.charge)}%`;
  element('encore-fill').style.width = `${player.charge}%`;
  const boss = run.enemies.find(enemy => enemy.kind === 'boss'); element('boss-bar').hidden = !boss;
  if (boss) { element('boss-name').textContent = sector.bossName; element('boss-health').textContent = `${Math.ceil(boss.health)} HP`; element('boss-fill').style.width = `${boss.health / boss.maxHealth * 100}%`; }
  const synergies = activeSynergies(run).map(id => SYNERGY_LABELS[id]);
  element('synergy-strip').textContent = synergies.join(' / ');
  element('steer-hint').hidden = run.elapsed > 12;
}
function updateLabels(): void {
  if (!run || !scene) return;
  const alive = new Set<number>();
  for (const object of run.objects) {
    const point = scene.project(object.x, object.z); alive.add(object.id);
    let node = labelNodes.get(object.id);
    if (!node) { node = document.createElement('div'); node.className = `world-label ${object.kind}`; worldLabels.append(node); labelNodes.set(object.id, node); }
    node.hidden = !point.visible;
    node.style.transform = `translate(${point.x}px,${point.y}px) translate(-50%,-110%)`;
    node.textContent = object.kind === 'gate' ? `+${object.value} FANS` : `AMP ${Math.ceil(object.health)}`;
  }
  for (const [id, node] of labelNodes) { if (!alive.has(id)) { node.remove(); labelNodes.delete(id); } }
}
// Reads the phase through a parameter so TypeScript does not keep the loop's `combat` narrowing after tick() mutated it.
function leftCombat(state: GameState): boolean { return state.phase !== 'combat'; }
function endedRun(state: GameState): boolean { return state.phase === 'victory' || state.phase === 'defeat'; }
function frame(now: number): void {
  const dt = Math.min(0.1, Math.max(0, (now - previousTime) / 1000)); previousTime = now;
  if (run && scene && !fatal) {
    const blocking = Boolean(cinema?.blocking);
    if (cinema && graphicsAvailable && !paused && !document.hidden) { advanceCinematic(cinema, dt); if (cinema.done) finishCinema(); else paintCinema(); }
    if (graphicsAvailable && !paused && !blocking && !document.hidden && run.phase === 'combat') {
      accumulator += dt;
      while (accumulator >= 1 / 60 && run.phase === 'combat' && !cinema?.blocking) {
        tick(run, controls.sample(), 1 / 60); accumulator -= 1 / 60; processEvents();
        if (leftCombat(run)) {
          accumulator = 0;
          if (endedRun(run)) terminal(); else choices();
          break;
        }
      }
    } else accumulator = 0;
    scene.render(run, !graphicsAvailable || paused || blocking || document.hidden ? 0 : dt);
    updateLabels(); hudTime += dt;
    if (hudTime >= 0.08) { updateHUD(); hudTime = 0; }
    if (now > calloutUntil) element('battle-callout').textContent = '';
    audio.setMusic(graphicsAvailable && !paused && !document.hidden && !cinema?.blocking && run.phase === 'combat');
  } else audio.setMusic(false);
  requestAnimationFrame(frame);
}

root.addEventListener('click', event => {
  const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[data-action]') : null;
  if (!target || target.disabled) return;
  const action = target.dataset.action;
  if (action === 'hero') {
    const found = HEROES.find(item => item.id === target.dataset.id); if (!found) return;
    hero = found.id; skin = session.profile.equippedSkins[hero];
    if (session.profile.ownedHeroes.includes(hero) && session.profile.selectedHero !== hero) session.chooseHero(hero);
    renderMenu(); return;
  }
  if (action === 'outfit') { const found = SKINS.find(item => item.id === target.dataset.id && item.hero === hero); if (found) { skin = found.id; renderMenu(); } return; }
  if (action === 'mode') { mode = target.dataset.mode === 'survival' ? 'survival' : 'campaign'; renderMenu(); return; }
  if (action === 'wardrobe') { wardrobe = !wardrobe; renderMenu(); return; }
  if (action === 'hero-action') {
    const state = heroAction(session.profile, hero);
    if (state.action === 'unlock') { if (apply(session.buy('hero', hero))) session.chooseHero(hero); }
    else if (state.action === 'select') apply(session.chooseHero(hero));
    renderMenu(); return;
  }
  if (action === 'skin-action') {
    const state = skinAction(session.profile, skin);
    if (state.action === 'buy') apply(session.buy('skin', skin));
    else if (state.action === 'equip') { if (session.profile.selectedHero !== hero) session.chooseHero(hero); apply(session.wear(skin)); }
    renderMenu(); return;
  }
  if (action === 'start' || action === 'retry') { startRun(); return; }
  if (action === 'home') { showMenu(); element('start-run').focus(); return; }
  if (action === 'pause' || action === 'resume') { togglePause(); return; }
  if (action === 'abandon' && run) { paused = false; closeDialog(); run.phase = 'defeat'; terminal(); return; }
  if (action === 'encore') { controls.triggerBurst(); canvas.focus({ preventScroll: true }); return; }
  if (action === 'upgrade' && run && UPGRADES.some(item => item.id === target.dataset.id)) { if (chooseUpgrade(run, target.dataset.id as UpgradeId)) { closeDialog(); controls.clear(); canvas.focus(); } return; }
  if (action === 'route' && run && ['safe', 'redline', 'salvage'].includes(target.dataset.id ?? '')) { if (chooseRoute(run, target.dataset.id as RouteId)) { closeDialog(); showCinema('sector'); } return; }
  if (action === 'cinema-next' && cinema) { nextCinematicFrame(cinema); if (cinema.done) finishCinema(); else paintCinema(); return; }
  if (action === 'cinema-skip' && cinema) { skipCinematic(cinema); finishCinema(); return; }
  if (action === 'sound') { session.setSetting('sound', !session.profile.settings.sound); audio.setEnabled(session.profile.settings.sound); if (session.profile.settings.sound) void unlockAudio(); notify(session.profile.settings.sound ? 'Sound on' : 'Sound off'); if (!menu.hidden) renderMenu(); updateSaveWarning(); return; }
  if (action === 'motion') { session.setSetting('reducedMotion', !session.profile.settings.reducedMotion); renderMenu(); return; }
  if (action === 'save-retry') { notify(session.retrySaving() ? 'Your progress is saved.' : 'Saving is still blocked. Keep this tab open to preserve this session.'); updateSaveWarning(); return; }
  if (action === 'help') { openDialog('help', 'Welcome to the afterlife.', '<p>Drag or tap the arena to steer. On a keyboard, use A / D or the arrow keys. Your heroine fires automatically.</p><p>Collect ghost-fan gates. Shoot cursed amplifiers for more power. Avoid crimson ground warnings before they strike.</p><p>Charge Encore through combat, then press Space or the Encore button. Choose upgrades at 24 and 48 seconds. Defeat each act’s boss to choose your next route.</p><p>Earn Echoes from play, even when you lose. Unlock heroines and outfits in the wardrobe. Outfits are cosmetic. Progress stays in this browser; no account or payment.</p><button class="primary-button" data-action="close-help">Ready for the noise</button>'); return; }
  if (action === 'close-help') closeDialog();
});
document.addEventListener('keydown', event => {
  const layer = cinema?.blocking ? cinemaLayer : !dialogLayer.hidden ? dialogLayer : null;
  if (event.key === 'Escape' && dialogKind === 'help') { closeDialog(); return; }
  if (event.key !== 'Tab' || !layer) return;
  const buttons = [...layer.querySelectorAll<HTMLElement>('button:not(:disabled),[tabindex="0"]')];
  const first = buttons[0]; const last = buttons.at(-1); if (!first || !last) return;
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) return;
  controls.clear(); audio.setMusic(false);
  if (run?.phase === 'combat' && !paused && !cinema?.blocking) togglePause();
});
canvas.addEventListener('webglcontextlost', () => {
  graphicsAvailable = false; controls.clear(); accumulator = 0; audio.setMusic(false);
  if (run?.phase === 'combat' && !paused) togglePause();
  notify('Graphics are recovering. Your run is paused.');
});
canvas.addEventListener('webglcontextrestored', () => {
  graphicsAvailable = true; accumulator = 0; controls.clear();
  notify(paused ? 'Graphics recovered. Resume when ready.' : 'Graphics recovered.');
});
window.addEventListener('pagehide', () => { controls.clear(); audio.setMusic(false); });
renderMenu(); requestAnimationFrame(frame);
