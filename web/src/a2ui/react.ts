import { useStore as useZustand } from 'zustand';
import type { A2uiClient } from './client';
import type { A2uiState } from './store';

/** Subscribe a component to the client's A2UI store. */
export function useA2ui<T>(client: A2uiClient, selector: (s: A2uiState) => T): T {
  return useZustand(client.store, selector);
}
