/**
 * GTM Tools (Macro) — INTERIM launcher.
 *
 * Macro's hosted app (macro.com) blocks being embedded in an iframe
 * (X-Frame-Options: DENY) and its sign-in server only accepts the macro.com /
 * localhost origins, so an embedded cross-origin view cannot sign in. Until the
 * self-hosted Macro backend is running (on the laptop's Ubuntu/WSL stack), this
 * view just launches the hosted app in a new tab, where sign-in works normally.
 *
 * When the self-hosted backend is live, restore the embedded <iframe> version
 * (see git history) and point VITE_MACRO_TEAM_URL at that origin.
 */
const LAUNCH_URL = 'https://macro.com';

export function MacroView() {
  return (
    <main className="chat tasks-view macro-view">
      <header className="tasks-view__header">
        <h1 className="tasks-view__title">GTM Tools</h1>
        <a href={LAUNCH_URL} target="_blank" rel="noopener noreferrer">Open in new tab</a>
      </header>
      <div className="tasks-empty">
        <h2 className="tasks-empty__title">GTM Tools</h2>
        <p className="tasks-empty__sub">
          GTM Tools opens in its own tab for now — sign-in there works normally.
          An embedded, self-hosted version is on the way.
        </p>
        <a
          className="macro-view__launch"
          href={LAUNCH_URL}
          target="_blank"
          rel="noopener noreferrer"
        >
          Open GTM Tools →
        </a>
      </div>
    </main>
  );
}
