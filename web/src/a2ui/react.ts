import { useStore as useZustand } from 'zustand';
import type { A2uiClient } from './client';
import type { A2uiState } from './store';

/**
 * Subscribe a component to the client's A2UI store. The selector must return a stable value: a primitive or an
 * object already held in the store (s.surfaces, s.calls). Never build a new object/array inside it; zustand v5
 * compares with Object.is, so a fresh value each call re-renders forever. Derive with useMemo instead.
 */
export function useA2ui<T>(client: A2uiClient, selector: (s: A2uiState) => T): T {
  return useZustand(client.store, selector);
}
