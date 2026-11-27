/** Stable preset IDs are stored in bot records. Append new collections to preserve saved choices. */
export const PORTRAIT_GROUPS = [
  { name: 'Original', names: ['Chief', 'Neon', 'Signal', 'Recon', 'Archive', 'Operations'], image: null, columns: 1, rows: 1 },
  { name: 'Cyberpunk', names: ['Chrome Investigator', 'Crimson Samurai', 'Violet Oracle', 'Volt Mechanic', 'Emerald Strategist'], image: 'cyberpunk-extra.png', columns: 5, rows: 1 },
  { name: 'Anime', names: ['Silver Samurai', 'Tokyo Detective', 'Neon Hacker', 'Scarlet Pilot', 'Shrine Guardian', 'Arcane Scientist', 'Racing Engineer', 'Street Ninja', 'Lunar Swordswoman', 'Android Composer', 'Fox Scout', 'Indigo Strategist'], image: 'anime.png', columns: 4, rows: 3 },
  { name: 'Crypto punks', names: ['Cyan Visor', 'Magenta Mohawk', 'Green Lens', 'Orange Bot', 'Violet Alien', 'Gold Monocle', 'Jade Punk', 'Pink Optic', 'Purple Pilot', 'Chrome Skull', 'Cobalt Samurai', 'Lime Archivist'], image: 'crypto-punks.png', columns: 4, rows: 3 },
];

export const PORTRAITS = PORTRAIT_GROUPS.flatMap((group) => group.names);

/** The stored id of a preset portrait, by its name. */
export function portraitPreset(name: string): string {
  const index = PORTRAITS.indexOf(name);
  if (index < 0) throw new Error(`No portrait is named ${name}.`);
  return `preset:${index}`;
}

export function isPortraitPreset(value: unknown): value is string {
  if (typeof value !== 'string' || !/^preset:(0|[1-9]\d*)$/.test(value)) return false;
  return Number(value.slice(7)) < PORTRAITS.length;
}
