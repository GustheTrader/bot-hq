import type { ComponentType } from 'react';
import type { A2uiClient } from './client';
import { OrderTicket } from './catalogs/trading/OrderTicket';
import { KNOWN_COMPONENTS, TRADING_CATALOG_ID } from './registry';
import type { Surface } from './store';
import type { WireComponent } from './types';

export interface CatalogComponentProps { surface: Surface; component: WireComponent; client: A2uiClient }
export type CatalogComponent = ComponentType<CatalogComponentProps>;

/**
 * catalogId -> component name -> React component. Names must match registry.ts exactly: checked both ways in dev
 * below, and in web/test/a2ui.test.ts (which also checks them against the agent's canonical catalog).
 */
export const CATALOGS: Record<string, Record<string, CatalogComponent>> = {
  [TRADING_CATALOG_ID]: { OrderTicket },
};

if (import.meta.env?.DEV) {
  for (const [id, names] of Object.entries(KNOWN_COMPONENTS)) {
    for (const n of names) if (!CATALOGS[id]?.[n]) console.error(`[a2ui] registry lists ${id}/${n} but catalogs.tsx has no component for it`);
  }
  for (const [id, comps] of Object.entries(CATALOGS)) {
    for (const n of Object.keys(comps)) if (!KNOWN_COMPONENTS[id]?.includes(n)) console.error(`[a2ui] catalogs.tsx has ${id}/${n} but registry.ts does not list it, so the store rejects it`);
  }
}

export function lookupComponent(catalogId: string | undefined, name: string): CatalogComponent | null {
  const cat = catalogId && Object.prototype.hasOwnProperty.call(CATALOGS, catalogId) ? CATALOGS[catalogId] : undefined;
  return cat && Object.prototype.hasOwnProperty.call(cat, name) ? cat[name] : null;
}
