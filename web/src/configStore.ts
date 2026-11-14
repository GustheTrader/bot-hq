import { create } from 'zustand';
import type { ServerEvent } from '@shared/types';
import { useStore } from './store';

/** UI state for bot settings, app settings, the Tasks view and the theme. Kept apart from store.ts on purpose. */

export type Theme = 'system' | 'light' | 'dark';

/** Colour palettes (styles/palettes.css). Each has a light and a dark look; Graphite is the original. */
export const PALETTES = [
  { id: 'graphite', label: 'Graphite', light: { side: '#F5F5F5', pane: '#FFFFFF', ink: '#1C1C1C', bubble: '#1C1C1C' }, dark: { side: '#0E0E0E', pane: '#161616', accent: '#F5F5F5' } },
  { id: 'paper', label: 'Paper & Ink', light: { side: '#F1EADB', pane: '#FFFDF6', ink: '#221C35', bubble: '#C23A22' }, dark: { side: '#110F18', pane: '#1C1926', accent: '#EFE8D8' } },
  { id: 'tidepool', label: 'Tidepool', light: { side: '#E4EFEC', pane: '#FBFEFD', ink: '#0F2A2E', bubble: '#0E5A60' }, dark: { side: '#081113', pane: '#0F1E21', accent: '#7FD6CC' } },
  { id: 'ember', label: 'Ember', light: { side: '#F3E6DE', pane: '#FFFAF7', ink: '#2B1A1F', bubble: '#A93C22' }, dark: { side: '#130C0E', pane: '#20161A', accent: '#FF9166' } },
  { id: 'aurora', label: 'Aurora', light: { side: '#EAE8F7', pane: '#FDFCFF', ink: '#1D1838', bubble: '#4B3BC9' }, dark: { side: '#0A0914', pane: '#141126', accent: '#8EF0C0' } },
  { id: 'blueprint', label: 'Blueprint', light: { side: '#E0EAFB', pane: '#F9FBFF', ink: '#0E2A5C', bubble: '#1447C8' }, dark: { side: '#060E1E', pane: '#0C1830', accent: '#FFD25E' } },
] as const;
export type Palette = (typeof PALETTES)[number]['id'];
export type BotSettingsTab = 'general' | 'skills' | 'memories' | 'routines';
export type AppSection = 'general' | 'computer' | 'permissions' | 'apps' | 'account';

interface ConfigUI {
  botSettings: { botId: string; tab: BotSettingsTab } | null;
  appSettings: AppSection | null;
  view: 'chat' | 'tasks';
  theme: Theme;
  palette: Palette;
  /** Bumped by server events (tasks, memories) so open views refetch. Keys: 'tasks', 'memories:<botId>'. */
  versions: Record<string, number>;
  openBotSettings(botId: string, tab?: BotSettingsTab): void;
  closeBotSettings(): void;
  openAppSettings(section?: AppSection): void;
  closeAppSettings(): void;
  setView(v: 'chat' | 'tasks'): void;
  setTheme(t: Theme): void;
  setPalette(p: Palette): void;
  bump(key: string): void;
}

const LS_THEME = 'grokbot.theme';
const readTheme = (): Theme => {
  try { const t = localStorage.getItem(LS_THEME); return t === 'light' || t === 'dark' ? t : 'system'; } catch { return 'system'; }
};

const LS_PALETTE = 'grokbot.palette';
const readPalette = (): Palette => {
  try { const p = localStorage.getItem(LS_PALETTE); return PALETTES.some((x) => x.id === p) ? (p as Palette) : 'graphite'; } catch { return 'graphite'; }
};

/** Graphite is the plain tokens, so it is the absence of the attribute. */
export function applyPalette(p: Palette) {
  if (p === 'graphite') delete document.documentElement.dataset.palette;
  else document.documentElement.dataset.palette = p;
}

const darkQuery = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

export function applyTheme(t: Theme) {
  const resolved = t === 'system' ? (darkQuery?.matches ? 'dark' : 'light') : t;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
}

export const useConfigUI = create<ConfigUI>((set, get) => ({
  botSettings: null,
  appSettings: null,
  view: 'chat',
  theme: readTheme(),
  palette: readPalette(),
  versions: {},
  openBotSettings: (botId, tab = 'general') => set({ botSettings: { botId, tab } }),
  closeBotSettings: () => set({ botSettings: null }),
  openAppSettings: (section = 'general') => set({ appSettings: section }),
  closeAppSettings: () => set({ appSettings: null }),
  setView: (view) => set({ view }),
  setTheme: (theme) => {
    try { localStorage.setItem(LS_THEME, theme); } catch { /* ignore */ }
    applyTheme(theme);
    set({ theme });
  },
  setPalette: (palette) => {
    try { localStorage.setItem(LS_PALETTE, palette); } catch { /* ignore */ }
    applyPalette(palette);
    set({ palette });
  },
  bump: (key) => set({ versions: { ...get().versions, [key]: (get().versions[key] ?? 0) + 1 } }),
}));

// Apply the saved theme as early as possible, and follow the OS while on "system".
applyTheme(readTheme());
applyPalette(readPalette());
darkQuery?.addEventListener?.('change', () => { if (useConfigUI.getState().theme === 'system') applyTheme('system'); });

// store.ts forwards events it doesn't handle itself as a DOM event.
window.addEventListener('grokbot:event', (e) => {
  const ev = (e as CustomEvent<ServerEvent>).detail;
  const { bump } = useConfigUI.getState();
  if (ev.type === 'tasks') { bump('tasks'); bump(`tasks:${ev.botId}`); }
  if (ev.type === 'memories') bump(`memories:${ev.botId}`);
});

// Picking a bot anywhere (sidebar, search) goes back to its chat.
useStore.subscribe((s, prev) => {
  if (s.selectedBotId !== prev.selectedBotId && useConfigUI.getState().view !== 'chat') useConfigUI.getState().setView('chat');
});

export const useVersion = (key: string) => useConfigUI((s) => s.versions[key] ?? 0);
