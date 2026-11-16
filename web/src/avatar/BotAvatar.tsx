import type { AvatarColor, AvatarShape, Bot } from '@shared/types';
import { palette } from '../lib/colors';
import { Icon } from '../components/Icon';
import { useStore } from '../store';
import { SHAPES, type ShapeDef } from './shapes.gen';

/** Shapes without an exported SVG fall back to the closest silhouette we have. */
const FALLBACK: Partial<Record<AvatarShape, string>> = {
  bean: 'teardrop', squircle: 'square', capsule: 'tablet', cylinder: 'tablet', gem: 'hex', crystal: 'hex',
  shield: 'house', dome: 'house', arch: 'house', leaf: 'teardrop',
};

export function shapeDef(shape: AvatarShape | string): ShapeDef {
  return SHAPES[shape] ?? SHAPES[FALLBACK[shape as AvatarShape] ?? 'blob'] ?? SHAPES.blob;
}

/** Shapes offered in the Create New Bot picker, in the design's order (rows of 5/5/3). */
export const PICKER_SHAPES: AvatarShape[] = ['blob', 'cloud', 'square', 'sparkle', 'clover', 'heart', 'flower', 'teardrop', 'tablet', 'wedge', 'house', 'star', 'hex'];

interface Props {
  shape: AvatarShape | string;
  color: AvatarColor | string;
  /** Slot size in px. The drawing overflows the slot by the design's 1.533x ratio. */
  size: number;
  star?: boolean;
  /** Selected-shape ring (white gap + gray outline following the silhouette). */
  ring?: boolean;
  className?: string;
  title?: string;
}

const OVERDRAW = 55.2 / 36;

export function BotAvatar({ shape, color, size, star, ring, className, title }: Props) {
  const def = shapeDef(shape);
  const draw = size * OVERDRAW;
  const off = (draw - size) / 2;
  const fill = palette(color).fill;
  // Stroke widths in viewBox units: viewBox width maps to `draw` px.
  const vbw = Number(def.viewBox.split(/\s+/)[2]);
  const px = vbw / draw;
  return (
    <span className={`bot-avatar ${className ?? ''}`} style={{ width: size, height: size }} title={title} role="img" aria-label={title}>
      <svg width={draw} height={draw} viewBox={def.viewBox} style={{ position: 'absolute', left: -off, top: -off, overflow: 'visible' }} aria-hidden>
        {ring && <path d={def.outline} fill="#1C1C1C3D" stroke="#1C1C1C3D" strokeWidth={px * 2 * 3.4} strokeLinejoin="round" />}
        {ring && <path d={def.outline} fill="#FFFFFF" stroke="#FFFFFF" strokeWidth={px * 2 * 2.4} strokeLinejoin="round" />}
        <path d={def.outline} fill="#FFFFFF" />
        <path d={def.d} fill={fill} fillRule="evenodd" />
      </svg>
      {star && (
        <span className="bot-avatar__star" style={{ width: size * 0.2667, height: size * 0.2667 }}>
          <Icon name="star" size={size * 0.1333} color="#FFFFFF" />
        </span>
      )}
    </span>
  );
}

export const PORTRAITS = ['Chief', 'Neon', 'Signal', 'Recon', 'Archive', 'Operations'];

export function portraitSource(index: number) {
  return `/portraits/${index}.webp`;
}

type PortraitBot = Pick<Bot, 'avatarShape' | 'avatarColor' | 'name' | 'avatarImage'> & Partial<Pick<Bot, 'id' | 'kind' | 'isPrimary'>>;

export function BotAvatarFor({ bot, size, star, className }: { bot: PortraitBot; size: number; star?: boolean; className?: string }) {
  const roster = useStore((state) => state.bots);
  if (bot.kind === 'room') return <BotAvatar shape={bot.avatarShape} color={bot.avatarColor} size={size} className={className} title={bot.name} />;
  const index = roster.filter((member) => member.kind !== 'room' && !member.isPrimary)
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    .findIndex((member) => member.id === bot.id);
  const preset = bot.avatarImage?.startsWith('preset:') ? Number(bot.avatarImage.slice(7)) : null;
  const source = preset === null ? bot.avatarImage ?? portraitSource(bot.isPrimary ? 0 : 1 + Math.max(index, 0) % 5) : portraitSource(preset);
  return (
    <span className={`bot-avatar bot-portrait ${bot.isPrimary ? 'bot-portrait--chief' : ''} ${className ?? ''}`} style={{ width: size, height: size }} title={bot.name}>
      <img src={source} alt={bot.name} width={size} height={size} draggable={false} />
      {star && <span className="bot-avatar__star"><Icon name="star" size={Math.round(size / 7)} color="#FFFFFF" /></span>}
    </span>
  );
}

export function PortraitPresets({ value, disabled, onSelect }: { value?: string | null; disabled?: boolean; onSelect: (value: string) => void }) {
  return <div className="portrait-picker__presets" role="group" aria-label="Portraits">
    {PORTRAITS.slice(1).map((name, index) => {
      const option = `preset:${index + 1}`;
      return <button key={name} type="button" aria-label={name} title={name} aria-pressed={value === option} disabled={disabled} onClick={() => onSelect(option)}>
        <img src={portraitSource(index + 1)} alt="" width={48} height={48} />
      </button>;
    })}
  </div>;
}
