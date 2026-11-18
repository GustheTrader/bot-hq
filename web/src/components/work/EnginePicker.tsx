import { useEffect, useState } from 'react';
import { configApi, type HarnessModels, type HarnessOption } from '../../lib/configApi';
import { errText } from './shared';

/**
 * Pick any harness, then any model that harness offers with its sign-in on the computer. Hermes takes its model
 * from the bot's own Engine settings, so it has no model list here. A harness that is not installed is shown but
 * cannot be picked.
 */
export function EnginePicker({ harnesses, harness, model, onChange }: {
  harnesses: HarnessOption[] | null;
  harness: string;
  model: string | null;
  onChange: (harness: string, model: string | null) => void;
}) {
  const [models, setModels] = useState<HarnessModels | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setModels(null);
    setError(null);
    if (harness === 'hermes') return;
    let alive = true;
    configApi.harnessModels(harness).then((m) => { if (alive) setModels(m); }).catch((e) => { if (alive) setError(errText(e, 'Could not load models')); });
    return () => { alive = false; };
  }, [harness]);

  const options = harnesses && harnesses.length > 0 ? harnesses : [{ id: harness, name: harness, subscription: '', installed: true }];
  const known = !model || models?.models.some((m) => m.value === model);
  return (
    <div className="proj-engine">
      <label className="proj-field">
        <span className="proj-field__label">Harness</span>
        <select className="text-input" value={harness} onChange={(e) => onChange(e.target.value, null)}>
          {options.map((h) => (
            <option key={h.id} value={h.id} disabled={!h.installed && h.id !== harness}>{h.name}{h.installed ? '' : ' (not installed)'}</option>
          ))}
        </select>
      </label>
      <label className="proj-field">
        <span className="proj-field__label">Model</span>
        {harness === 'hermes' ? (
          <span className="proj-hint">Set in the bot&rsquo;s Engine settings</span>
        ) : (
          <select className="text-input" value={model ?? ''} disabled={!models && !error} onChange={(e) => onChange(harness, e.target.value || null)}>
            <option value="">Default{models?.current ? ` (${models.current})` : ''}</option>
            {!known && model && <option value={model}>{model}</option>}
            {models?.models.map((m) => <option key={m.value} value={m.value}>{m.name}</option>)}
          </select>
        )}
      </label>
      {error && <div className="card__error" role="alert">{error}</div>}
    </div>
  );
}
