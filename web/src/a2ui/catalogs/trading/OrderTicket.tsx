import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { actionFunctionCall, resolveFunctionCall, resolveValue } from '../../bindings';
import type { A2uiClient } from '../../client';
import { getAt } from '../../pointer';
import { useA2ui } from '../../react';
import type { CallRecord, Surface } from '../../store';
import { isBinding, isObject, type Json, type JsonObject, type WireComponent } from '../../types';

/**
 * bothq.trading.v0 / OrderTicket. Every value on it comes from the surface data model the agent sent (through
 * the component's @path bindings); nothing here invents a price. Field edits write the bound path locally right
 * away and send a debounced `ticketEdited` action; Submit sends callAgentFunction(submitOrder) from a real click.
 */

type Side = 'buy' | 'sell';
type TicketState = 'idle' | 'editing' | 'submitting' | 'filled' | 'rejected';

const bindingPath = (v: Json | undefined): string | null => (isBinding(v) ? v['@path'] : null);
const num = (v: Json | undefined): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: Json | undefined): string | null => (typeof v === 'string' ? v : null);

/** The model path next to a bound value, e.g. /market/lastPrice -> /market/asOf. */
const siblingPath = (path: string | null, key: string): string | null =>
  path ? `${path.slice(0, path.lastIndexOf('/'))}/${key}` : null;

const money = (v: number | null, digits = 2) =>
  v === null ? '—' : v.toLocaleString(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits });

function asOfLabel(iso: string | null): string {
  if (!iso) return 'no timestamp';
  const t = Date.parse(iso);
  return Number.isFinite(t) ? `as of ${new Date(t).toLocaleTimeString()}` : 'no timestamp';
}

/** Whole contracts, 1..10000 (the catalog's Quantity bounds). */
const parseQty = (s: string): number | null => (/^\s*[1-9]\d{0,4}\s*$/.test(s) && Number(s) <= 10000 ? Number(s) : null);
function parseLimit(s: string): number | null {
  if (!/^\s*(0?\.\d{1,2}|0)\s*$/.test(s)) return null;
  const n = Number(s);
  return n >= 0.01 && n <= 0.99 ? Math.round(n * 100) / 100 : null;
}

/** Briefly mark a changed value: 'up' / 'down' for numbers, cleared after the animation. */
function useFlash(value: number | null): 'up' | 'down' | null {
  const prev = useRef<number | null>(value);
  const [flash, setFlash] = useState<{ dir: 'up' | 'down'; n: number } | null>(null);
  useEffect(() => {
    const p = prev.current;
    prev.current = value;
    if (p === null || value === null || p === value) return;
    setFlash((f) => ({ dir: value > p ? 'up' : 'down', n: (f?.n ?? 0) + 1 }));
    const t = setTimeout(() => setFlash(null), 700);
    return () => clearTimeout(t);
  }, [value]);
  return flash?.dir ?? null;
}

/** A text draft for a numeric field: follows the model while the field is not focused. */
function useDraft(modelValue: number | null, format: (n: number) => string) {
  const [draft, setDraft] = useState(modelValue === null ? '' : format(modelValue));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(modelValue === null ? '' : format(modelValue));
  }, [modelValue, format]);
  return {
    draft,
    setDraft,
    onFocus: () => { focused.current = true; },
    onBlur: () => { focused.current = false; setDraft(modelValue === null ? '' : format(modelValue)); },
  };
}

const fmtQty = (n: number) => String(n);
const fmtLimit = (n: number) => n.toFixed(2);

export function OrderTicket({ surface, component, client }: { surface: Surface; component: WireComponent; client: A2uiClient }) {
  const model = surface.dataModel;
  const connected = useA2ui(client, (s) => s.conn === 'connected');
  const calls = useA2ui(client, (s) => s.calls);

  const read = (prop: string) => resolveValue(component[prop], model);
  const symbol = str(read('symbol'));
  const side = str(read('side')) as Side | null;
  const quantity = num(read('quantity'));
  const limitPrice = num(read('limitPrice'));
  const livePrice = num(read('livePrice'));
  const buyingPower = num(read('buyingPower'));
  const position = num(read('position'));
  const statusRaw = read('status');
  const status = isObject(statusRaw) ? (statusRaw as JsonObject) : {};

  const livePath = bindingPath(component.livePrice);
  const asOf = str(getAt(model, siblingPath(livePath, 'asOf') ?? undefined));
  const bid = num(getAt(model, siblingPath(livePath, 'bid') ?? undefined));
  const ask = num(getAt(model, siblingPath(livePath, 'ask') ?? undefined));
  const source = str(getAt(model, siblingPath(livePath, 'source') ?? undefined));
  const flash = useFlash(livePrice);

  const sidePath = bindingPath(component.side);
  const qtyPath = bindingPath(component.quantity);
  const limitPath = bindingPath(component.limitPrice);

  const qty = useDraft(quantity, fmtQty);
  const limit = useDraft(limitPrice, fmtLimit);
  const qtyValid = parseQty(qty.draft) !== null;
  const limitValid = parseLimit(limit.draft) !== null;

  const mine = useMemo(() => Object.values(calls).filter((c) => c.surfaceId === surface.surfaceId).sort((a, b) => b.startedAt - a.startedAt), [calls, surface.surfaceId]);
  const pending: CallRecord | undefined = mine.find((c) => c.state === 'pending');
  const latest: CallRecord | undefined = mine[0];
  // An unconfirmed call may already have placed an order: block until it is confirmed (Check status re-asks).
  const unconfirmed: CallRecord | undefined = !pending && latest?.state === 'unconfirmed' ? latest : undefined;
  const [localError, setLocalError] = useState<string | null>(null);
  const [editedAt, setEditedAt] = useState(0);

  const submitCall = actionFunctionCall(component.submit);
  const editable = connected && !pending && !unconfirmed;

  /** Write one bound field locally, then queue the debounced ticketEdited action with the resolved values. */
  const edit = (path: string | null, value: Json) => {
    if (!path) return;
    setLocalError(null);
    setEditedAt(Date.now());
    client.store.getState().setLocal(surface.surfaceId, path, value);
    const s = client.store.getState().surfaces[surface.surfaceId];
    if (!s) return;
    const ctx: JsonObject = {};
    for (const k of ['side', 'quantity', 'limitPrice'] as const) {
      const v = resolveValue(component[k], s.dataModel);
      if (v !== undefined) ctx[k] = v;
    }
    client.queueAction(surface.surfaceId, 'ticketEdited', component.id, ctx);
  };

  const onSubmit = (e: MouseEvent<HTMLButtonElement>) => {
    // requiresUserActivation: only a genuine user click may place an order.
    const ua = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation;
    if (!e.nativeEvent.isTrusted || (ua && !ua.isActive)) { setLocalError('Submit needs a real click.'); return; }
    if (!submitCall) return;
    try {
      client.flushActions(surface.surfaceId);
      const s = client.store.getState().surfaces[surface.surfaceId];
      if (!s) throw new Error('The ticket is gone (agent reconnecting).');
      const call = resolveFunctionCall(submitCall, s.dataModel);
      // requiresUserActivation evidence (CONTRACT.md): the agent rejects calls without a trusted, fresh click.
      call.args = { ...call.args, userActivation: { type: 'click', isTrusted: true, timestamp: new Date().toISOString() } };
      client.callAgentFunction(surface.surfaceId, call);
      setLocalError(null);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    }
  };

  const onRecheck = () => {
    if (!unconfirmed) return;
    try { client.recheckCall(unconfirmed.functionCallId); setLocalError(null); }
    catch (err) { setLocalError(err instanceof Error ? err.message : String(err)); }
  };

  const modelState = (str(status.state) ?? 'idle') as TicketState;
  const shownState: TicketState | 'unconfirmed' = pending ? 'submitting' : unconfirmed ? 'unconfirmed' : modelState;
  // The response of the latest call only describes the ticket while the agent's status still points at that
  // order (or at a terminal state): after an edit or a resumed snapshot the model status wins.
  const terminal = modelState === 'filled' || modelState === 'rejected';
  const done = latest?.state === 'done' ? latest.response : undefined;
  const doneValue = done && isObject(done.value) ? (done.value as JsonObject) : null;
  const modelOrderId = str(status.orderId);
  const resp = done && !done.error && (modelOrderId ? str(doneValue?.orderId) === modelOrderId : terminal) ? done : undefined;
  const respValue = resp ? doneValue : null;
  // An error answer to the latest call is shown until the user edits the ticket (no order exists for it).
  const callError = done?.error && latest && latest.startedAt >= editedAt ? done.error : undefined;
  const orderId = modelOrderId ?? (respValue ? str(respValue.orderId) : null);
  const statusMessage = localError
    ?? (callError ? errorText(callError) : null)
    ?? (unconfirmed ? 'Connection dropped twice before the agent confirmed this order, so it may exist. Check its status before placing another.' : null)
    ?? (str(status.message) || null);

  return (
    <section className={`viz-card order-ticket${connected ? '' : ' is-stale'}`} aria-label={`Order ticket ${symbol ?? ''}`}>
      <div className="viz-card__head">
        <div className="order-ticket__title">
          <span className="viz-card__title">{symbol ?? '—'}</span>
          <span className="order-ticket__sub">YES contracts{source ? ` · ${source}` : ''}</span>
        </div>
        <span className={`order-ticket__state is-${shownState}`} role="status" aria-live="polite">{shownState}</span>
      </div>

      <div className="viz-tiles order-ticket__tiles">
        <div className={`viz-tile order-ticket__live${flash ? ` is-flash-${flash}` : ''}`}>
          <span className="viz-tile__label">Live price</span>
          <span className="viz-tile__value">{money(livePrice)}</span>
          <span className="viz-tile__sub">{bid !== null && ask !== null ? `${money(bid)} / ${money(ask)} · ` : ''}{asOfLabel(asOf)}</span>
        </div>
        <div className="viz-tile">
          <span className="viz-tile__label">Buying power</span>
          <span className="viz-tile__value">{money(buyingPower)}</span>
          <span className="viz-tile__sub">paper account</span>
        </div>
        <div className="viz-tile">
          <span className="viz-tile__label">Position</span>
          <span className="viz-tile__value">{position === null ? '—' : position}</span>
          <span className="viz-tile__sub">contracts</span>
        </div>
      </div>

      <div className="cfg-grid order-ticket__form">
        <div className="cfg-field">
          <span className="cfg-field__label" id={`${surface.surfaceId}-side`}>Side</span>
          <div className="cfg-seg" role="radiogroup" aria-labelledby={`${surface.surfaceId}-side`}>
            {(['buy', 'sell'] as const).map((s) => (
              <button key={s} type="button" role="radio" aria-checked={side === s} className={side === s ? 'is-active' : ''} disabled={!editable || !sidePath} onClick={() => edit(sidePath, s)}>
                {s === 'buy' ? 'Buy' : 'Sell'}
              </button>
            ))}
          </div>
        </div>
        <label className="cfg-field">
          <span className="cfg-field__label">Quantity</span>
          <input
            className="text-input" inputMode="numeric" value={qty.draft} disabled={!editable || !qtyPath} aria-invalid={!qtyValid}
            onFocus={qty.onFocus} onBlur={qty.onBlur}
            onChange={(e) => { qty.setDraft(e.target.value); const n = parseQty(e.target.value); if (n !== null) edit(qtyPath, n); }}
          />
          {!qtyValid && <span className="cfg-field__hint">Whole contracts, 1 to 10,000.</span>}
        </label>
        <label className="cfg-field">
          <span className="cfg-field__label">Limit price</span>
          <input
            className="text-input" inputMode="decimal" value={limit.draft} disabled={!editable || !limitPath} aria-invalid={!limitValid}
            onFocus={limit.onFocus} onBlur={limit.onBlur}
            onChange={(e) => { limit.setDraft(e.target.value); const n = parseLimit(e.target.value); if (n !== null) edit(limitPath, n); }}
          />
          {!limitValid && <span className="cfg-field__hint">Dollars, 0.01 to 0.99.</span>}
        </label>
        <div className="cfg-field">
          <span className="cfg-field__label">Notional</span>
          <span className="order-ticket__notional">{quantity !== null && limitPrice !== null ? money(quantity * limitPrice) : '—'}</span>
        </div>
      </div>

      <div className="order-ticket__footer">
        <div className={`order-ticket__status is-${shownState}`}>
          <span className="order-ticket__status-line">{statusMessage ?? statusText(shownState)}</span>
          {(orderId || respValue) && (
            <span className="order-ticket__status-meta">
              {orderId && <>Order <code className="cfg-code">{orderId}</code></>}
              {respValue && num(respValue.filledQty) !== null && <> · filled {num(respValue.filledQty)} @ {money(num(respValue.avgPrice))}</>}
              {respValue?.duplicate === true && <> · duplicate request, original order returned</>}
            </span>
          )}
        </div>
        {unconfirmed ? (
          <button type="button" className="btn btn--primary" onClick={onRecheck} disabled={!connected}>Check status</button>
        ) : (
          <button type="button" className="btn btn--primary" onClick={onSubmit} disabled={!editable || !submitCall || !qtyValid || !limitValid || !side}>
            {pending ? 'Submitting…' : side === 'sell' ? 'Submit sell' : 'Submit buy'}
          </button>
        )}
      </div>
    </section>
  );
}

/** Agent error codes (CONTRACT.md), in words; the code stays visible for support. */
function errorText(e: { code: string; message: string }): string {
  switch (e.code) {
    case 'ORDER_IN_FLIGHT': return `An earlier order from this ticket is still being processed; wait for its result before submitting again. (${e.code})`;
    case 'USER_ACTIVATION_REQUIRED': return `The agent did not accept the click as fresh user activation; no order was placed. Click Submit again. (${e.code})`;
    default: return `${e.code}: ${e.message}`;
  }
}

function statusText(s: TicketState | 'unconfirmed'): string {
  switch (s) {
    case 'idle': return 'Ready.';
    case 'editing': return 'Editing.';
    case 'submitting': return 'Sending to the agent…';
    case 'filled': return 'Filled.';
    case 'rejected': return 'Rejected.';
    case 'unconfirmed': return 'Not confirmed.';
    default: return String(s);
  }
}
