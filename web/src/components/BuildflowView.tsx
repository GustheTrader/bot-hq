import { useConfigUI } from '../configStore';

/**
 * Build-flow: the internal construction app (jobs, schedule, daily logs, change orders, selections, leads,
 * estimates, client portal), served by Bot HQ's server under /buildflow/ behind Bot HQ's own sign-in, and shown
 * here edge to edge. Same origin, so it needs no separate login. Other views open a page in it with openBuildflow().
 */
export function BuildflowView() {
  const path = useConfigUI((s) => s.buildflowPath);
  return (
    <main className="chat buildflow-view">
      <iframe key={path} className="buildflow-view__frame" src={`/buildflow${path}`} title="Build-flow" />
    </main>
  );
}
