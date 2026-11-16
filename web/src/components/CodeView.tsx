function workspaceUrl(value: string | undefined): URL | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
      ? url
      : null;
  } catch {
    return null;
  }
}

const t3Workspace = workspaceUrl(import.meta.env.VITE_T3_WORKSPACE_URL);

export function CodeView() {
  return (
    <main className="chat tasks-view">
      <header className="tasks-view__header">
        <h1 className="tasks-view__title">Code</h1>
      </header>
      <div className="tasks-view__scroll">
        <div className="tasks-view__inner">
          <div className="tasks-empty">
            <h2 className="tasks-empty__title">T3 Code</h2>
            <p className="tasks-empty__sub">
              {t3Workspace
                ? 'Open your coding agent workspace to start or resume a session.'
                : 'The T3 Code workspace is awaiting setup.'}
            </p>
            {t3Workspace && (
              <a href={t3Workspace.href} target="_blank" rel="noopener noreferrer">
                Open T3 Code (new tab)
              </a>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
