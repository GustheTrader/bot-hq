import type { ComponentType } from 'react';
import type { A2uiClient } from './client';
import { OrderTicket } from './catalogs/trading/OrderTicket';
import { KNOWN_COMPONENTS, TRADING_CATALOG_ID } from './registry';
import type { Surface } from './store';
import type { WireComponent } from './types';

export interface CatalogComponentProps { surface: Surface; component: WireComponent; client: A2uiClient }
export type CatalogComponent = ComponentType<CatalogComponentProps>;

/** catalogId -> component name -> React component. Names must match registry.ts (checked in dev below). */
export const CATALOGS: Record<string, Record<string, CatalogComponent>> = {
  [TRADING_CATALOG_ID]: { OrderTicket },
};

if (import.meta.env?.DEV) {
  for (const [id, names] of Object.entries(KNOWN_COMPONENTS)) {
    for (const n of names) if (!CATALOGS[id]?.[n]) console.error(`[a2ui] registry lists ${id}/${n} but catalogs.tsx has no component for it`);
  }
}

export function lookupComponent(catalogId: string | undefined, name: string): CatalogComponent | null {
  return (catalogId && CATALOGS[catalogId]?.[name]) || null;
}
