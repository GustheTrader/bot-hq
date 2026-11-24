import { lookupComponent } from './catalogs';
import type { A2uiClient } from './client';
import type { Surface } from './store';

/** Visible error for a surface or component this renderer cannot draw (the agent also gets VALIDATION_FAILED). */
export function A2uiErrorBox({ title, message, path }: { title: string; message: string; path?: string }) {
  return (
    <div className="cfg-error a2ui-error" role="alert">
      <strong>{title}</strong>
      <div>{message}</div>
      {path && <code className="cfg-code">{path}</code>}
    </div>
  );
}

/** Render one surface: its 'root' component through the catalog registry. */
export function SurfaceView({ surface, client }: { surface: Surface; client: A2uiClient }) {
  const surfaceProblem = surface.problems.$surface;
  if (surfaceProblem) return <A2uiErrorBox title={`Surface ${surface.surfaceId} cannot render`} message={surfaceProblem.message} path={surfaceProblem.path} />;

  const root = surface.components.root;
  if (!root) return <div className="cfg-empty">Surface {surface.surfaceId} is waiting for its components.</div>;

  const problem = surface.problems.root;
  if (problem) return <A2uiErrorBox title={`Surface ${surface.surfaceId} cannot render`} message={problem.message} path={problem.path} />;

  const catalogId = typeof root['@catalogId'] === 'string' ? (root['@catalogId'] as string) : surface.catalogId;
  const Comp = lookupComponent(catalogId, root.component);
  if (!Comp) return <A2uiErrorBox title={`Surface ${surface.surfaceId} cannot render`} message={`No renderer for ${catalogId ?? '(no catalog)'} / ${root.component}.`} />;
  return <Comp surface={surface} component={root} client={client} />;
}
