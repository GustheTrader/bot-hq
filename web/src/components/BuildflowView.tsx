/**
 * Build-flow: the internal construction app (jobs, schedule, daily logs, change orders, selections, leads,
 * estimates, client portal), served by Bot HQ's server under /buildflow/ behind Bot HQ's own sign-in, and shown
 * here edge to edge. Same origin, so it needs no separate login.
 */
export function BuildflowView() {
  return (
    <main className="chat buildflow-view">
      <iframe className="buildflow-view__frame" src="/buildflow/" title="Build-flow" />
    </main>
  );
}
