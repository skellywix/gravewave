import type { HeroDefinition, SkinDefinition, SectorDefinition, UpgradeDefinition } from './types.ts';

export const WORLD = {
  halfWidth: 4.2,
  playerZ: 0,
  sectorSeconds: 72,
  choiceTimes: [24, 48],
  spawnDistance: 48,
  vanishDistance: -3,
} as const;

export const LIMITS = {
  enemies: 48,
  projectiles: 180,
  objects: 16,
  telegraphs: 20,
  events: 128,
  particles: 96,
  visibleGhosts: 18,
  pixelRatio: 2,
} as const;

export const ECONOMY = {
  starterEchoes: 300,
  heroinePrice: 600,
  nocturnePrice: 400,
  festivalPrice: 500,
  kill: 1,
  crate: 5,
  sectorClear: 150,
  campaignWin: 150,
  salvageRoute: 75,
  safeHeal: 25,
  redlineRewards: 1.5,
  redlineHealth: 1.25,
  exhaustionReward: 25,
  exhaustionHeal: 10,
  settlementCap: 100_000,
  walletCap: 1_000_000_000,
  settlementHistory: 32,
} as const;

export const HEROES: readonly HeroDefinition[] = [
  {
    id: 'mira', name: 'Mira', age: 27, role: 'The moonlit headliner',
    tagline: 'A little lace. A lot of collateral.',
    description: 'Elegant piercing fire from a parasol railgun. Her Moonbreaker Encore cuts straight through the crowd.',
    weapon: 'Parasol railgun', burstName: 'Moonbreaker', price: 0,
    stats: { health: 100, damage: 15, fireRate: 4.8, shotCount: 1, spread: 0, projectileSpeed: 25, moveSpeed: 7.8 },
  },
  {
    id: 'rin', name: 'Rin', age: 26, role: 'The crimson troublemaker',
    tagline: 'Turn it up. Wake the dead.',
    description: 'Coffin-guitar scatter fire fills the lane. Her Heartbreaker Encore detonates in a riot of crimson sparks.',
    weapon: 'Coffin guitar', burstName: 'Heartbreaker', price: ECONOMY.heroinePrice,
    stats: { health: 95, damage: 7, fireRate: 3.8, shotCount: 3, spread: 0.13, projectileSpeed: 23, moveSpeed: 8.2 },
  },
  {
    id: 'sera', name: 'Sera', age: 29, role: 'The sweet little haunting',
    tagline: 'They are not lost souls. They are fans.',
    description: 'Spectral shock bolts and a protective aura. Her Velvet Requiem Encore restores a shield while sweeping enemies away.',
    weapon: 'Spectral grimoire', burstName: 'Velvet Requiem', price: ECONOMY.heroinePrice,
    stats: { health: 115, damage: 11, fireRate: 4.5, shotCount: 1, spread: 0, projectileSpeed: 24, moveSpeed: 7.5 },
  },
];

export const SKINS: readonly SkinDefinition[] = [
  { id: 'mira-default', hero: 'mira', name: 'Midnight Headliner', collection: 'Original', price: 0, description: 'Moon-blue velvet, black lace, silver crescents.', portrait: 'art/mira-default.webp', palette: { body: '#25203f', trim: '#69e9f5', hair: '#e9e5ff', projectile: '#81f3ff' } },
  { id: 'mira-nocturne', hero: 'mira', name: 'Widow of the Moon', collection: 'Nocturne', price: ECONOMY.nocturnePrice, description: 'An ivory-and-black gala gown with a silver moon veil.', portrait: 'art/mira-nocturne.webp', palette: { body: '#ded6ee', trim: '#a0b9ff', hair: '#ffffff', projectile: '#d7d3ff' } },
  { id: 'mira-festival', hero: 'mira', name: 'Ghostlight Riot', collection: 'Afterparty', price: ECONOMY.festivalPrice, description: 'Electric teal, black leather, and too many silver chains.', portrait: 'art/mira-festival.webp', palette: { body: '#166273', trim: '#83ffdf', hair: '#c9f2ff', projectile: '#70ffce' } },
  { id: 'rin-default', hero: 'rin', name: 'Crimson Feedback', collection: 'Original', price: 0, description: 'Crimson brocade and a coffin guitar with an attitude.', portrait: 'art/rin-default.webp', palette: { body: '#641d39', trim: '#ff6889', hair: '#be2457', projectile: '#ff6f91' } },
  { id: 'rin-nocturne', hero: 'rin', name: 'Blood Rose Ball', collection: 'Nocturne', price: ECONOMY.nocturnePrice, description: 'Wine-red satin, black rose lace, and gilded thorns.', portrait: 'art/rin-nocturne.webp', palette: { body: '#a33656', trim: '#ffd08d', hair: '#e04472', projectile: '#ffbb78' } },
  { id: 'rin-festival', hero: 'rin', name: 'Neon Noise', collection: 'Afterparty', price: ECONOMY.festivalPrice, description: 'Hot pink goth-punk with torn sleeves and silver hardware.', portrait: 'art/rin-festival.webp', palette: { body: '#c52c8c', trim: '#ff87db', hair: '#ef406c', projectile: '#ff81d9' } },
  { id: 'sera-default', hero: 'sera', name: 'Velvet Séance', collection: 'Original', price: 0, description: 'Plum velvet, lace sleeves, and a very friendly haunting.', portrait: 'art/sera-default.webp', palette: { body: '#492051', trim: '#83ffda', hair: '#7049b6', projectile: '#a0ffe1' } },
  { id: 'sera-nocturne', hero: 'sera', name: 'Saint of Starlight', collection: 'Nocturne', price: ECONOMY.nocturnePrice, description: 'Lilac lace and a moon-silver cathedral halo.', portrait: 'art/sera-nocturne.webp', palette: { body: '#b091d1', trim: '#e8d5ff', hair: '#9865cb', projectile: '#ead5ff' } },
  { id: 'sera-festival', hero: 'sera', name: 'Hex After Hours', collection: 'Afterparty', price: ECONOMY.festivalPrice, description: 'Mint-and-black club couture and ghost-shaped charms.', portrait: 'art/sera-festival.webp', palette: { body: '#28765e', trim: '#9dffb3', hair: '#9b67e7', projectile: '#9dffb3' } },
];

export const UPGRADES: readonly UpgradeDefinition[] = [
  { id: 'overdrive', name: 'Heavy Reverb', family: 'ballistics', maxLevel: 3, description: 'Every shot hits harder.', detail: '+20% weapon damage per rank.' },
  { id: 'rapid', name: 'Double Time', family: 'ballistics', maxLevel: 3, description: 'Less waiting. More noise.', detail: '+15% fire rate per rank.' },
  { id: 'scatter', name: 'Crowd Pleaser', family: 'ballistics', maxLevel: 3, description: 'Bring a wider audience.', detail: '+1 projectile per volley per rank.' },
  { id: 'pierce', name: 'Silver Needle', family: 'ballistics', maxLevel: 3, description: 'One shot. An entire queue.', detail: 'Pierce 1 additional enemy per rank.' },
  { id: 'arc', name: 'Static Kiss', family: 'storm', maxLevel: 3, description: 'An electric meet-and-greet.', detail: 'Chain to 1 additional foe per rank for 35% shot damage.' },
  { id: 'critical', name: 'Killer Chorus', family: 'storm', maxLevel: 3, description: 'Some notes hit twice as hard.', detail: '+10% chance of double damage per rank.' },
  { id: 'battery', name: 'Encore! Encore!', family: 'storm', maxLevel: 3, description: 'The fans demand another.', detail: '+25% Encore charge gain per rank.' },
  { id: 'ricochet', name: 'Broken Record', family: 'storm', maxLevel: 3, description: 'A farewell with sharp edges.', detail: 'Kills release 1 returning shard per rank.' },
  { id: 'barrier', name: 'Lace Aegis', family: 'aegis', maxLevel: 3, description: 'Delicate. Not defenseless.', detail: '+15 shield capacity and 15 shield on selection.' },
  { id: 'repair', name: 'Sweet Requiem', family: 'aegis', maxLevel: 3, description: 'A little tenderness mid-riot.', detail: 'Recover 3 health per rank every 6 seconds.' },
  { id: 'rally', name: 'Ghost Fan Club', family: 'aegis', maxLevel: 3, description: 'Membership is eternal.', detail: '+2 ghost fans now; gates recruit +1 more per rank.' },
  { id: 'salvage', name: 'Tip the Band', family: 'aegis', maxLevel: 3, description: 'Even ghosts carry change.', detail: '+25% kill and amplifier Echoes per rank.' },
];

export const SECTORS: readonly SectorDefinition[] = [
  { id: 0, name: 'Ghostlight Pier', subtitle: 'The fans are dying to meet you.', bossName: 'Sir Cuddles', bossTitle: 'The plush nightmare', bossPattern: 'lanes', color: '#253147', fog: '#151a32', sky: '#11162d', accent: '#72e9f3' },
  { id: 1, name: 'Velvet Midway', subtitle: 'One last ride. Again.', bossName: 'The Mourning Carriage', bossTitle: 'No refunds. No survivors.', bossPattern: 'sweep', color: '#46243d', fog: '#24132b', sky: '#1b1029', accent: '#ff7299' },
  { id: 2, name: 'Cathedral of Static', subtitle: 'Tonight, heaven gets a noise complaint.', bossName: 'Saint Static', bossTitle: 'The final headline act', bossPattern: 'crossfire', color: '#342750', fog: '#211634', sky: '#140e27', accent: '#c5a0ff' },
];

export function getHero(id: string): HeroDefinition {
  const hero = HEROES.find(item => item.id === id);
  if (!hero) throw new RangeError(`Unknown heroine: ${id}`);
  return hero;
}

export function getSkin(id: string): SkinDefinition {
  const skin = SKINS.find(item => item.id === id);
  if (!skin) throw new RangeError(`Unknown outfit: ${id}`);
  return skin;
}

export function getSector(index: number): SectorDefinition {
  if (!Number.isInteger(index) || index < 0) throw new RangeError('Sector index must be a nonnegative integer.');
  return SECTORS[index % SECTORS.length];
}
