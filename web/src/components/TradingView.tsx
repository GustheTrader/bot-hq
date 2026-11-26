import { useEffect, useMemo } from 'react';
import { acquireA2uiClient, sharedA2uiClient } from '../a2ui/client';
import { getAt } from '../a2ui/pointer';
import { useA2ui } from '../a2ui/react';
import { SurfaceView } from '../a2ui/SurfaceView';
import '../styles/config.css';
import '../styles/a2ui.css';

/**
 * Order Ticket: surfaces from the durable Rust A2UI agent (agents/a2ui-durable, docs/a2ui/CONTRACT.md) over
 * /a2ui/ws. Paper orders only. Everything on screen comes from the agent; with no agent there is nothing to show
 * but the reconnecting state.
 */
export function TradingView() {
  const client = sharedA2uiClient();
  useEffect(() => acquireA2uiClient().release, []);

  const conn = useA2ui(client, (s) => s.conn);
  const attempts = useA2ui(client, (s) => s.attempts);
  const surfacesMap = useA2ui(client, (s) => s.surfaces);
  const surfaces = useMemo(() => Object.values(surfacesMap).sort((a, b) => a.surfaceId.localeCompare(b.surfaceId)), [surfacesMap]);
  const resumed = surfaces.some((s) => getAt(s.dataModel, '/session/resumed') === true);
  const sessionId = surfaces.map((s) => getAt(s.dataModel, '/session/id')).find((v): v is string => typeof v === 'string');

  // When the last good connection was lost (kept in the shared store, so it survives this view remounting).
  const lostAt = useA2ui(client, (s) => s.lostAt);

  const connected = conn === 'connected';
  const pill = connected
    ? resumed ? { cls: 'is-resumed', text: 'Resumed' } : { cls: 'is-working', text: 'Connected' }
    : conn === 'reconnecting' ? { cls: 'is-needs', text: 'Reconnecting' } : { cls: '', text: 'Connecting' };

  return (
    <main className="chat tasks-view trading-view">
      <header className="tasks-view__header">
        <h1 className="tasks-view__title">Order Ticket</h1>
        <span className="hq-view__summary" aria-live="polite">
          <span className="trading-view__meta">Paper only{sessionId ? ` · session ${sessionId}` : ''}</span>
          <span className={`hq-view__pill ${pill.cls}`} title={connected ? 'Live connection to the A2UI agent' : `Retrying (${attempts} failed attempt${attempts === 1 ? '' : 's'})`}>{pill.text}</span>
        </span>
      </header>
      <div className="tasks-view__scroll">
        <div className="tasks-view__inner">
          {!connected && (
            <div className="trading-view__banner" role="status">
              <strong>Agent offline — reconnecting.</strong>{' '}
              {surfaces.length > 0
                ? `The ticket below is the last state the agent sent${lostAt ? ` (${new Date(lostAt).toLocaleTimeString()})` : ''}; it is not live and cannot be edited until the agent is back.`
                : `No data is shown until the durable agent (bothq-a2ui-agent) accepts the connection. Retrying every 2 s at most${attempts > 0 ? ` · ${attempts} attempt${attempts === 1 ? '' : 's'} so far` : ''}.`}
            </div>
          )}
          {connected && surfaces.length === 0 && (
            <div className="tasks-empty">
              <h2 className="tasks-empty__title">Connected, no ticket yet</h2>
              <p className="tasks-empty__sub">The agent has not opened an order-ticket surface. It will appear here as soon as it does.</p>
            </div>
          )}
          <div className="trading-view__surfaces">
            {surfaces.map((s) => <SurfaceView key={s.surfaceId} surface={s} client={client} />)}
          </div>
        </div>
      </div>
    </main>
  );
}
