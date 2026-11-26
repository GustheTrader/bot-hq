import type { Space } from '@shared/types';
import { palette } from '../lib/colors';
import { useStore } from '../store';

/** The coloured dot and name that say which business or project something belongs to. */
export function SpaceTag({ spaceId }: { spaceId?: string | null }) {
  const space = useStore((s) => s.spaces.find((x) => x.id === spaceId));
  if (!space) return null;
  return (
    <span className="space-tag" title={`${space.kind === 'business' ? 'Business' : 'Project'}: ${space.name}`}>
      <span className="space-tag__dot" style={{ background: palette(space.color).fill }} aria-hidden />
      <span className="space-tag__name">{space.name}</span>
    </span>
  );
}

function groups(spaces: Space[]): [string, Space[]][] {
  return ([['Businesses', 'business'], ['Projects', 'project']] as const)
    .map(([label, kind]): [string, Space[]] => [label, spaces.filter((s) => s.kind === kind)])
    .filter(([, list]) => list.length > 0);
}

/** Picks the workspace something belongs to. An empty value is General. */
export function SpaceSelect({ value, onChange, label = 'Workspace', id }: { value: string | null; onChange: (id: string | null) => void; label?: string; id?: string }) {
  const spaces = useStore((s) => s.spaces);
  return (
    <select id={id} className="text-input" value={value ?? ''} onChange={(e) => onChange(e.target.value || null)} aria-label={label}>
      <option value="">General</option>
      {groups(spaces).map(([group, list]) => (
        <optgroup key={group} label={group}>
          {list.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </optgroup>
      ))}
    </select>
  );
}

/** The sidebar's view filter: everything, General, or one business or project. */
export function SpaceSwitcher() {
  const spaces = useStore((s) => s.spaces);
  const active = useStore((s) => s.activeSpace);
  const set = useStore((s) => s.set);
  const setModal = useStore((s) => s.setModal);
  return (
    <div className="space-switch">
      <select className="text-input space-switch__select" value={active} onChange={(e) => set({ activeSpace: e.target.value })} aria-label="Show workspace">
        <option value="all">All workspaces</option>
        <option value="general">General</option>
        {groups(spaces).map(([group, list]) => (
          <optgroup key={group} label={group}>
            {list.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </optgroup>
        ))}
      </select>
      <button type="button" className="link-btn link-btn--small" onClick={() => setModal('spaces')}>{spaces.length ? 'Manage' : 'New'}</button>
    </div>
  );
}
