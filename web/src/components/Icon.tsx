import type { CSSProperties } from 'react';

export type IconName =
  | 'apps' | 'arrow_down' | 'chat_filled' | 'check' | 'chev_down' | 'chev_right' | 'clock' | 'close'
  | 'composer_plus' | 'copy' | 'edit' | 'file' | 'mic' | 'paperclip' | 'plus' | 'record' | 'save'
  | 'search' | 'share' | 'sidebar' | 'slack' | 'star' | 'voice_a' | 'voice_b'
  // inline extras not in the icon font export
  | 'arrow_up' | 'stop' | 'more' | 'monitor' | 'refresh'
  // inline outline glyphs
  | 'eye' | 'pointer' | 'expand' | 'shrink';

const INLINE: Partial<Record<IconName, string>> = {
  arrow_up: 'M12 4.5a1 1 0 0 1 .7.3l6 6a1 1 0 0 1-1.4 1.4L13 7.9V19a1 1 0 1 1-2 0V7.9l-4.3 4.3a1 1 0 1 1-1.4-1.4l6-6a1 1 0 0 1 .7-.3Z',
  stop: 'M7 6h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1Z',
  more: 'M5 10.25a1.75 1.75 0 1 1 0 3.5 1.75 1.75 0 0 1 0-3.5Zm7 0a1.75 1.75 0 1 1 0 3.5 1.75 1.75 0 0 1 0-3.5Zm7 0a1.75 1.75 0 1 1 0 3.5 1.75 1.75 0 0 1 0-3.5Z',
  monitor: 'M4.5 4h15A2.5 2.5 0 0 1 22 6.5v9a2.5 2.5 0 0 1-2.5 2.5H13v1.5h3a1 1 0 1 1 0 2H8a1 1 0 1 1 0-2h3V18H4.5A2.5 2.5 0 0 1 2 15.5v-9A2.5 2.5 0 0 1 4.5 4Zm0 2a.5.5 0 0 0-.5.5v9c0 .28.22.5.5.5h15a.5.5 0 0 0 .5-.5v-9a.5.5 0 0 0-.5-.5h-15Z',
  refresh: 'M12 4a8 8 0 0 1 7.2 4.5V6a1 1 0 1 1 2 0v5a1 1 0 0 1-1 1h-5a1 1 0 1 1 0-2h2.6A6 6 0 1 0 18 14.4a1 1 0 1 1 1.9.6A8 8 0 1 1 12 4Z',
};

/** Outline glyphs, drawn with a 1.8px round stroke. */
const OUTLINE: Partial<Record<IconName, string>> = {
  eye: 'M2.6 12s3.4-6.4 9.4-6.4 9.4 6.4 9.4 6.4-3.4 6.4-9.4 6.4S2.6 12 2.6 12Z M12 9.3a2.7 2.7 0 1 0 0 5.4 2.7 2.7 0 0 0 0-5.4Z',
  pointer: 'M5.4 4.6 10.9 19.4 13.2 13.2 19.4 10.9 5.4 4.6Z',
  expand: 'M14.5 4.5h5v5 M19.5 4.5l-5.8 5.8 M9.5 19.5h-5v-5 M4.5 19.5l5.8-5.8',
  shrink: 'M19.5 9.7h-5.2V4.5 M14.3 9.7l5.4-5.4 M4.5 14.3h5.2v5.2 M9.7 14.3l-5.4 5.4',
};

interface Props { name: IconName; size?: number; opacity?: number; className?: string; style?: CSSProperties; color?: string }

/** Single-color glyph from /assets/icons drawn as a CSS mask so it takes `currentColor`. */
export function Icon({ name, size = 16, opacity, className, style, color }: Props) {
  const inline = INLINE[name];
  if (inline) {
    return (
      <svg className={className} width={size} height={size} viewBox="0 0 24 24" aria-hidden style={{ opacity, color, flexShrink: 0, ...style }}>
        <path d={inline} fill="currentColor" />
      </svg>
    );
  }
  const outline = OUTLINE[name];
  if (outline) {
    return (
      <svg className={className} width={size} height={size} viewBox="0 0 24 24" aria-hidden style={{ opacity, color, flexShrink: 0, ...style }}>
        <path d={outline} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  const url = `url(/assets/icons/${name}.svg)`;
  return (
    <span
      aria-hidden
      className={className}
      style={{
        display: 'inline-block', flexShrink: 0, width: size, height: size, opacity, color,
        backgroundColor: 'currentColor', WebkitMask: `${url} center / 100% 100% no-repeat`, mask: `${url} center / 100% 100% no-repeat`,
        ...style,
      }}
    />
  );
}
