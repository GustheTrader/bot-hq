import { useEffect, useState } from 'react';
import type { Bot, Project } from '@shared/types';
import { ActiveCard, tierOf } from '../HqView';
import { configApi } from '../../lib/configApi';
import { useConfigUI } from '../../configStore';
import { useStore } from '../../store';
import { Composer } from './Composer';
import { useAttention } from './attention';
import { engineLabel, useHarnesses } from './shared';

function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

/**
 * Work → Launch: the normal starting point. A greeting, one box to say what the work is (type `/` for skills),
 * and the choices that go with it: a project or folder, a bot, a harness and a model.
 */
export function LaunchPage({ stay = false }: { stay?: boolean }) {
  const user = useStore((s) => s.user);
  const harnesses = useHarnesses();
  const attention = useAttention();
  const setTab = useConfigUI((s) => s.setWorkTab);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [choice, setChoice] = useState('');
  const [sent, setSent] = useState<Bot | null>(null);
  const bots = useStore((s) => s.bots);
  const live = useStore((s) => s.live);
  // Bots working or waiting on you, as live cards: with `stay`, the work you start shows up here while you keep going.
  const active = stay ? bots.filter((b) => live[b.id] && tierOf(live[b.id]) !== 'idle') : [];

  useEffect(() => {
    let alive = true;
    configApi.projects().then((r) => { if (alive) setProjects(r.projects); }).catch(() => { if (alive) setProjects([]); });
    return () => { alive = false; };
  }, []);

  // A name, not an email address, in the greeting.
  const first = (user?.name ?? '').includes('@') ? '' : (user?.name ?? '').trim().split(/\s+/)[0];

  return (
    <div className="launch">
      <h2 className="launch__hello">{greeting()}{first ? `, ${first}` : ''}</h2>

      <Composer harnesses={harnesses} projects={projects ?? []} projectChoice={choice} onProjectChoice={setChoice} stay={stay} onStarted={setSent} />

      {sent && (
        <div className="launch__sent" role="status">
          <span>Sent to {sent.name}. Its progress shows on its Bot HQ page and the card below. Keep going.</span>
          <button type="button" className="link-btn link-btn--small" onClick={() => setSent(null)} aria-label="Dismiss">&times;</button>
        </div>
      )}

      {active.length > 0 && (
        <section className="launch__live">
          <div className="section-label">Running now</div>
          <div className="launch__cards">
            {active.map((b) => <ActiveCard key={b.id} bot={b} live={live[b.id]} tier={tierOf(live[b.id])} />)}
          </div>
        </section>
      )}

      {attention.total > 0 && (
        <button type="button" className="launch__attention" onClick={() => setTab('attention')}>
          <span className="launch__attention-dot" aria-hidden />
          <span>{attention.total} {attention.total === 1 ? 'thing needs' : 'things need'} you</span>
          <span className="launch__attention-go">View &rarr;</span>
        </button>
      )}

      {projects && projects.length > 0 && (
        <section className="launch__projects">
          <div className="section-label section-label--row">
            <span>Your projects</span>
            <button type="button" className="link-btn link-btn--small" onClick={() => setTab('projects')}>All projects</button>
          </div>
          <div className="launch__chips">
            {projects.slice(0, 6).map((p) => (
              <button key={p.id} type="button" className={`launch__chip${choice === p.id ? ' is-on' : ''}`} onClick={() => setChoice(choice === p.id ? '' : p.id)} aria-pressed={choice === p.id} title={p.description || p.name}>
                <span className="launch__chip-name">{p.name}</span>
                <span className="launch__chip-meta">{engineLabel(harnesses, p.harness, p.harnessModel)}</span>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
