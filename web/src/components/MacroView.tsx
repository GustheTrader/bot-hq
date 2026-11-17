/**
 * GTM Tools (Macro): the business-apps sub-app, embedded under the Team label.
 *
 * Macro runs in Docker on the owner's laptop, so its address is usually
 * http://127.0.0.1:<port>. Only a browser on that same machine can reach it;
 * anywhere else the frame stays blank, so the page always offers a new-tab link
 * and says why. The address is a build constant, like VITE_T3_WORKSPACE_URL.
 */
function macroUrl(value: string | undefined): URL | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) return null;
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    return url.protocol === 'https:' || (url.protocol === 'http:' && loopback) ? url : null;
  } catch {
    return null;
  }
}

const macro = macroUrl(import.meta.env.VITE_MACRO_TEAM_URL);
const onlyThisComputer = macro ? ['localhost', '127.0.0.1', '[::1]'].includes(macro.hostname) : false;

export function MacroView() {
  return (
    <main className="chat tasks-view macro-view">
      <header className="tasks-view__header">
        <h1 className="tasks-view__title">GTM Tools</h1>
        {macro && (
          <a href={macro.href} target="_blank" rel="noopener noreferrer">Open in new tab</a>
        )}
      </header>
      {macro ? (
        <>
          {onlyThisComputer && (
            <p className="tasks-empty__sub macro-view__note">
              GTM Tools runs on your laptop, so this only loads in a browser on that computer.
            </p>
          )}
          <iframe className="macro-view__frame" src={macro.href} title="GTM Tools" />
        </>
      ) : (
        <div className="tasks-empty">
          <h2 className="tasks-empty__title">GTM Tools</h2>
          <p className="tasks-empty__sub">GTM Tools is awaiting setup. Set VITE_MACRO_TEAM_URL and rebuild the web app.</p>
        </div>
      )}
    </main>
  );
}
