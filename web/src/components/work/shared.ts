import { useEffect, useState } from 'react';
import { configApi, type HarnessOption } from '../../lib/configApi';

export const errText = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

/** The Code workspace (T3) address the app was built with, if it is a plain https URL. Same rule as the Code view. */
export function t3Url(): string | null {
  const v = import.meta.env.VITE_T3_WORKSPACE_URL as string | undefined;
  if (!v) return null;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash ? u.href : null;
  } catch { return null; }
}

/** "Claude Code · opus", or just "Hermes" when the harness's own default model is used. */
export function engineLabel(harnesses: HarnessOption[] | null, harness: string, model: string | null): string {
  const name = harnesses?.find((h) => h.id === harness)?.name ?? harness;
  return model ? `${name} · ${model}` : name;
}

/** Every harness a bot can run on, and whether each is installed. `null` while loading. */
export function useHarnesses(): HarnessOption[] | null {
  const [list, setList] = useState<HarnessOption[] | null>(null);
  useEffect(() => {
    let alive = true;
    configApi.harnesses().then((r) => { if (alive) setList(r.harnesses); }).catch(() => { if (alive) setList([]); });
    return () => { alive = false; };
  }, []);
  return list;
}
