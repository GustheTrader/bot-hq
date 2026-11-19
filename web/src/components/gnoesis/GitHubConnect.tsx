import { useEffect, useRef, useState } from 'react';
import { configApi } from '../../lib/configApi';

const errText = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

/**
 * Sign the computer in to GitHub right here: shows GitHub's one-time code and a link to github.com/login/device,
 * then waits until it is approved. `onDone` runs once git on the computer is signed in.
 */
export function GitHubConnect({ onDone, label = 'Connect GitHub', small = true }: { onDone: () => void; label?: string; small?: boolean }) {
  const [code, setCode] = useState<{ code: string; url: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => () => { if (timer.current) clearInterval(timer.current); }, []);

  const poll = () => {
    if (timer.current) clearInterval(timer.current);
    timer.current = setInterval(async () => {
      try {
        const s = await configApi.githubDeviceStatus();
        if (s.state === 'done') { clearInterval(timer.current!); setCode(null); onDone(); }
        else if (s.state === 'error') { clearInterval(timer.current!); setCode(null); setError(s.error); }
      } catch { /* keep waiting */ }
    }, 2500);
  };

  const start = async () => {
    setBusy(true); setError(null);
    try { const r = await configApi.githubDeviceStart(); setCode(r); poll(); }
    catch (e) { setError(errText(e, 'Could not start GitHub sign-in')); }
    finally { setBusy(false); }
  };

  const cancel = () => {
    if (timer.current) clearInterval(timer.current);
    setCode(null);
    configApi.githubDeviceCancel().catch(() => {});
  };

  const copy = () => { navigator.clipboard?.writeText(code?.code ?? '').then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => {}); };

  if (code) {
    return (
      <div className="gh-device" role="status">
        <span className="gh-device__step">Enter this code on GitHub:</span>
        <button type="button" className="gh-device__code" onClick={copy} title="Copy the code">{code.code}{copied ? ' ✓' : ''}</button>
        <a className="btn btn--primary btn--sm" href={code.url} target="_blank" rel="noreferrer noopener" onClick={copy}>Open github.com</a>
        <span className="gh-device__wait">Waiting for you to approve…</span>
        <button type="button" className="link-btn link-btn--small" onClick={cancel}>Cancel</button>
      </div>
    );
  }
  return (
    <span className="gh-connect">
      <button type="button" className={`btn btn--primary${small ? ' btn--sm' : ''}`} onClick={start} disabled={busy}>{busy ? 'Starting…' : label}</button>
      {error && <span className="gh-connect__error" role="alert">{error}</span>}
    </span>
  );
}
