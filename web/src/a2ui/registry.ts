/**
 * Which catalogs and component names this renderer can draw. Kept free of React so the store (and the node
 * tests) can check incoming surfaces without loading any UI code; catalogs.tsx maps the same names to React
 * components and must stay in step with this list.
 */
export const TRADING_CATALOG_ID = 'bothq.trading.v0';

export const KNOWN_COMPONENTS: Readonly<Record<string, readonly string[]>> = {
  [TRADING_CATALOG_ID]: ['OrderTicket'],
};

export const isKnownCatalog = (catalogId: string | undefined): catalogId is string =>
  !!catalogId && Object.prototype.hasOwnProperty.call(KNOWN_COMPONENTS, catalogId);

export const isKnownComponent = (catalogId: string | undefined, name: string): boolean =>
  isKnownCatalog(catalogId) && KNOWN_COMPONENTS[catalogId].includes(name);
