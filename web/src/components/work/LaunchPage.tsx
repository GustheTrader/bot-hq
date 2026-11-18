import { useEffect, useState } from 'react';
import type { Project } from '@shared/types';
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
export function LaunchPage() {
  const user = useStore((s) => s.user);
  const harnesses = useHarnesses();
  const attention = useAttention();
  const setTab = useConfigUI((s) => s.setWorkTab);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [choice, setChoice] = useState('');

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

      <Composer harnesses={harnesses} projects={projects ?? []} projectChoice={choice} onProjectChoice={setChoice} />

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
