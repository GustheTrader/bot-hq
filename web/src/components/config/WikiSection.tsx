import { useState } from 'react';
import bench from '../../wiki/bench-results.json';
import { AS_OF, HARNESS_GUIDE, PROVIDER_NOTES, RERUN, TIPS } from '../../wiki/guide';

interface BenchSetup { id: string; harness: string; provider: string | null; model: string | null; label: string }
interface BenchTask { id: string; name: string }
interface BenchResult { setup: string; task: string; ok: boolean; ms: number; tools: number; error?: string; reply?: string }
interface Bench { ranAt: string; setups: BenchSetup[]; tasks: BenchTask[]; results: BenchResult[] }

const data = bench as Bench;
const secs = (ms: number) => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

const HARNESS_NAMES: Record<string, string> = { hermes: 'Hermes', codex: 'Codex', 'claude-code': 'Claude Code', opencode: 'OpenCode', pi: 'Pi' };

/** One row per setup that was tested: its score, typical time and each task's result. */
function rows() {
  const byKey = new Map(data.results.map((r) => [`${r.setup}|${r.task}`, r]));
  return data.setups
    .map((s) => {
      const cells = data.tasks.map((t) => byKey.get(`${s.id}|${t.id}`) ?? null);
      const ran = cells.filter((c): c is BenchResult => !!c);
      const passed = ran.filter((c) => c.ok);
      return { setup: s, cells, ran: ran.length, passed: passed.length, typical: median(passed.map((c) => c.ms)) };
    })
    .filter((r) => r.ran > 0)
    .sort((a, b) => b.passed - a.passed || a.typical - b.typical);
}

/** For a task, the setups that passed it, fastest first. */
function bestFor(taskId: string, n = 3) {
  const labels = new Map(data.setups.map((s) => [s.id, s.label]));
  return data.results
    .filter((r) => r.task === taskId && r.ok)
    .sort((a, b) => a.ms - b.ms)
    .slice(0, n)
    .map((r) => ({ label: labels.get(r.setup) ?? r.setup, ms: r.ms }));
}

function why(c: BenchResult) {
  if (c.ok) return `Passed in ${secs(c.ms)}${c.tools ? ` · ${c.tools} tool call${c.tools === 1 ? '' : 's'}` : ''}${c.reply ? ` · replied “${c.reply.slice(0, 80)}”` : ''}`;
  if (c.error) return `Failed: ${c.error}`;
  return `Failed the check${c.tools ? ` · ${c.tools} tool call${c.tools === 1 ? '' : 's'}` : ' · no tool call'}${c.reply ? ` · replied “${c.reply.slice(0, 80)}”` : ''}`;
}

/** Settings → Wiki: a cheat sheet for picking a harness and model, from task tests on the computer. */
export function WikiSection() {
  const table = rows();
  const [harness, setHarness] = useState<string>('all');
  const shown = harness === 'all' ? table : table.filter((r) => r.setup.harness === harness);
  const harnessesTested = [...new Set(table.map((r) => r.setup.harness))];
  const ran = new Date(data.ranAt);

  return (
    <>
      <div className="app-settings__head">
        <h1>Wiki</h1>
        <p>A cheat sheet for the operator: which harness and model to pick for a job, from task tests run on your Bots’ computer.</p>
      </div>

      <section className="cfg-section">
        <div className="cfg-section__label">Best picks by task</div>
        <div className="wiki-picks">
          {data.tasks.map((t) => {
            const best = bestFor(t.id);
            return (
              <div key={t.id} className="cfg-card wiki-pick">
                <div className="wiki-pick__task">{t.name}</div>
                {best.length ? (
                  <ol>{best.map((b) => <li key={b.label}><span>{b.label}</span><span className="wiki-time">{secs(b.ms)}</span></li>)}</ol>
                ) : <div className="cfg-row__sub">Nothing passed this task.</div>}
              </div>
            );
          })}
        </div>
        <div className="cfg-field__hint">Fastest setups that passed each task. Times are one run each, so treat close times as a tie.</div>
      </section>

      <section className="cfg-section">
        <div className="cfg-section__label wiki-label">
          <span>Test results · {table.length} setups × {data.tasks.length} tasks</span>
          <span className="wiki-filter">
            {['all', ...harnessesTested].map((h) => (
              <button key={h} type="button" className={`wiki-chip${harness === h ? ' is-on' : ''}`} onClick={() => setHarness(h)} aria-pressed={harness === h}>
                {h === 'all' ? 'All' : HARNESS_NAMES[h] ?? h}
              </button>
            ))}
          </span>
        </div>
        <div className="cfg-card wiki-table-wrap">
          <table className="wiki-table">
            <thead>
              <tr>
                <th scope="col">Harness · provider · model</th>
                {data.tasks.map((t) => <th key={t.id} scope="col">{t.name}</th>)}
                <th scope="col">Score</th>
                <th scope="col">Typical</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.setup.id}>
                  <th scope="row">{r.setup.label}</th>
                  {r.cells.map((c, i) => (
                    <td key={data.tasks[i].id} className={c ? (c.ok ? 'is-ok' : 'is-bad') : 'is-none'} title={c ? why(c) : 'Not run'}>
                      {c ? (c.ok ? `✓ ${secs(c.ms)}` : '✗') : '–'}
                    </td>
                  ))}
                  <td className="wiki-score">{r.passed}/{r.ran}</td>
                  <td className="wiki-time">{r.passed ? secs(r.typical) : '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="cfg-field__hint">
          Run {ran.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}. Hover a cell for what happened. The tasks: run a shell command and report its output; write a file with exact contents; read example.com’s title; add the primes below 50 without tools; call the app’s own list_routines tool. Each is graded automatically, not by a model.
        </div>
      </section>

      <section className="cfg-section">
        <div className="cfg-section__label">Harnesses</div>
        <div className="cfg-card">
          {HARNESS_GUIDE.map((h) => (
            <div key={h.id} className="cfg-row wiki-harness">
              <div className="cfg-row__text">
                <div className="cfg-row__title">{h.name}</div>
                <dl className="wiki-dl">
                  <dt>Best for</dt><dd>{h.bestFor}</dd>
                  <dt>Sign-in</dt><dd>{h.signIn}</dd>
                  <dt>Models</dt><dd>{h.models}</dd>
                  <dt>Keeps</dt><dd>{h.keeps}</dd>
                  <dt>Watch</dt><dd>{h.watch}</dd>
                </dl>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="cfg-section">
        <div className="cfg-section__label">Hermes providers · as of {AS_OF}</div>
        <div className="cfg-card">
          {PROVIDER_NOTES.map((p) => (
            <div key={p.name} className="cfg-row">
              <span className={`computer-status-dot is-${p.state === 'ok' ? 'on' : 'off'}${p.state === 'warn' ? ' is-warn' : ''}`} aria-hidden />
              <div className="cfg-row__text">
                <div className="cfg-row__title">{p.name} · {p.how}</div>
                <div className="cfg-row__sub">{p.note}</div>
              </div>
            </div>
          ))}
        </div>
        <div className="cfg-field__hint">Billing and sign-ins change; the Subscriptions page and the Engine panel’s Test show the state now.</div>
      </section>

      <section className="cfg-section">
        <div className="cfg-section__label">Operator tips</div>
        <div className="cfg-card">
          <ul className="wiki-tips">{TIPS.map((t) => <li key={t}>{t}</li>)}</ul>
        </div>
      </section>

      <section className="cfg-section">
        <div className="cfg-section__label">Re-run the tests</div>
        <div className="cfg-card wiki-code"><code className="cfg-code">{RERUN}</code></div>
        <div className="cfg-field__hint">Runs on the Bots’ computer and writes a new results file; copy it to web/src/wiki/bench-results.json to update this page. Setups and tasks live in server/src/bench.ts.</div>
      </section>
    </>
  );
}
