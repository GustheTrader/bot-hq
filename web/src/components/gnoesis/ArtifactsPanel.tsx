import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../store';
import { BotAvatarFor } from '../../avatar/BotAvatar';
import { LibraryTab } from '../config/LibraryTab';

/** GnoesisWork → Artifacts: the files each bot has made, one bot at a time (its library on the computer). */
export function ArtifactsPanel() {
  const allBots = useStore((s) => s.bots);
  const bots = useMemo(() => allBots.filter((b) => b.kind !== 'team'), [allBots]);
  const [botId, setBotId] = useState<string>('');
  useEffect(() => { if (!bots.some((b) => b.id === botId) && bots.length) setBotId(bots[0].id); }, [bots, botId]);
  const bot = bots.find((b) => b.id === botId);

  return (
    <div className="gw-artifacts">
      <p className="gw-lede">What your bots have made: reports, files and exports they saved to their library.</p>
      <div className="gw-artifacts__bots" role="tablist" aria-label="Bot">
        {bots.map((b) => (
          <button key={b.id} type="button" role="tab" aria-selected={b.id === botId} className={`gw-artifacts__bot${b.id === botId ? ' is-active' : ''}`} onClick={() => setBotId(b.id)}>
            <BotAvatarFor bot={b} size={16} /> {b.name}
          </button>
        ))}
      </div>
      {bot ? <LibraryTab bot={bot} /> : <div className="cfg-empty">No bots yet.</div>}
    </div>
  );
}
