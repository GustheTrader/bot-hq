import { memo, useMemo, useState, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** A link to a file on the bots' computer (an absolute path, or file://), rather than a web page. */
export const isComputerPath = (href: string | undefined): href is string =>
  !!href && (href.startsWith('file://') || (href.startsWith('/') && !href.startsWith('//') && !href.startsWith('/api/')));

/** A file link: opens on the bot's computer, says so while it does, and shows why if it cannot. */
function FileLink({ href, children, onOpen }: { href: string; children: ReactNode; onOpen: (path: string) => void | Promise<void> }) {
  const [state, setState] = useState<'idle' | 'opening' | 'error'>('idle');
  const [why, setWhy] = useState('');
  const click = async (e: React.MouseEvent) => {
    e.preventDefault();
    if (state === 'opening') return;
    setState('opening');
    try { await onOpen(href); setState('idle'); }
    catch (err) { setWhy(err instanceof Error ? err.message : 'Could not open it'); setState('error'); }
  };
  return (
    <>
      <a href={href} className={`md-file-link is-${state}`} title={`Open ${href} on the bot's computer`} onClick={click}>{children}</a>
      {state === 'opening' && <span className="md-file-note"> opening on the computer…</span>}
      {state === 'error' && <span className="md-file-note is-error" role="alert"> {why}</span>}
    </>
  );
}

const table: Components['table'] = ({ node: _n, ...props }) => <div className="md-table"><table {...props} /></div>;

/**
 * Assistant message markdown: paragraphs, lists, blockquotes, inline code, code blocks (screen 02), tables.
 * Links to files on the computer go to `onOpenPath` (shown on the bot's own screen) instead of a dead browser tab.
 */
export const Markdown = memo(function Markdown({ text, onOpenPath }: { text: string; onOpenPath?: (path: string) => void | Promise<void> }) {
  const components = useMemo<Components>(() => ({
    a: ({ node: _n, href, children, ...props }) => (isComputerPath(href) && onOpenPath
      ? <FileLink href={href} onOpen={onOpenPath}>{children}</FileLink>
      : <a {...props} href={href} target="_blank" rel="noreferrer noopener">{children}</a>),
    table,
  }), [onOpenPath]);
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{text}</ReactMarkdown>
    </div>
  );
});
