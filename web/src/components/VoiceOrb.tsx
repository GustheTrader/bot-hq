import { useEffect, useRef } from 'react';
import { callLevels, callSpectrum } from '../voice/call';

/**
 * The voice-chat orb: a glowing blob in the bot's colour that swells and ripples with the voice, ringed by a sound
 * wave. The bot's speech drives the ring from its real spectrum; your voice ripples the blob's edge (lighter tint).
 * Drawn on a canvas each frame without re-rendering React. Honors reduced motion (a gentle, slow breath only).
 *
 * The colour is read from the canvas's own CSS `color`, which the call bar sets to the bot's colour.
 */

type Mood = 'connecting' | 'listening' | 'speaking' | 'thinking' | 'muted' | 'error';

function rgb(color: string): [number, number, number] {
  const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(color);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [143, 89, 249];
}
const mix = (a: [number, number, number], b: [number, number, number], t: number): [number, number, number] =>
  [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const css = (c: [number, number, number], alpha = 1) => `rgba(${c[0] | 0}, ${c[1] | 0}, ${c[2] | 0}, ${alpha})`;

export function VoiceOrb({ mood, size = 200 }: { mood: Mood; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const moodRef = useRef(mood);
  moodRef.current = mood;

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    let base = rgb(getComputedStyle(canvas).color);
    let lastColorCheck = 0;
    let out = 0;
    let mic = 0;
    const ring = new Float32Array(72);
    let raf = 0;
    const t0 = performance.now();

    const draw = (now: number) => {
      const t = (now - t0) / 1000;
      if (now - lastColorCheck > 1000) { base = rgb(getComputedStyle(canvas).color); lastColorCheck = now; } // theme or bot colour changed
      const m = moodRef.current;
      const lv = callLevels();
      out += ((reduce ? 0 : lv.out) - out) * 0.25;
      mic += ((reduce ? 0 : Math.min(1, lv.mic * 3)) - mic) * 0.25;
      const energy = Math.max(out, mic * 0.85);
      const breath = 0.5 + 0.5 * Math.sin(t * (m === 'thinking' ? 2.2 : 1.1));
      const dim = m === 'connecting' || m === 'muted' || m === 'error' ? 0.55 : 1;

      const c = size / 2;
      const R = size * (0.26 + 0.035 * breath + (reduce ? 0 : 0.09 * energy));
      ctx.clearRect(0, 0, size, size);

      // Glow.
      const glow = ctx.createRadialGradient(c, c, R * 0.6, c, c, size * 0.5);
      glow.addColorStop(0, css(base, (0.34 + 0.3 * energy) * dim));
      glow.addColorStop(1, css(base, 0));
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, size, size);

      // Sound-wave ring: the bot's spectrum when it speaks, a soft synthetic wave from your mic otherwise.
      const spec = reduce ? null : callSpectrum();
      const n = ring.length;
      for (let i = 0; i < n; i++) {
        let target = 0;
        if (spec) {
          // Speech energy sits in the lower bins; mirror it so the ring is symmetric.
          const k = i < n / 2 ? i : n - 1 - i;
          const bin = Math.floor((k / (n / 2)) * spec.length * 0.45) + 2;
          target = spec[Math.min(spec.length - 1, bin)] / 255;
        } else if (mic > 0.02) {
          target = mic * (0.45 + 0.35 * Math.sin(i * 0.9 + t * 7) * Math.sin(i * 0.37 - t * 3));
        }
        ring[i] += (Math.max(0, target) - ring[i]) * 0.35;
      }
      const ringR = R * 1.18;
      ctx.lineCap = 'round';
      ctx.lineWidth = Math.max(2, size * 0.012);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 - Math.PI / 2 + t * 0.15;
        const len = size * 0.012 + ring[i] * size * 0.13;
        ctx.strokeStyle = css(mix(base, [255, 255, 255], spec ? 0.15 : 0.45), (0.25 + 0.75 * Math.min(1, ring[i] * 1.6)) * dim);
        ctx.beginPath();
        ctx.moveTo(c + Math.cos(a) * ringR, c + Math.sin(a) * ringR);
        ctx.lineTo(c + Math.cos(a) * (ringR + len), c + Math.sin(a) * (ringR + len));
        ctx.stroke();
      }

      // The blob: a circle whose edge ripples with the voice.
      const pts = 96;
      ctx.beginPath();
      for (let i = 0; i <= pts; i++) {
        const a = (i / pts) * Math.PI * 2;
        const wob = reduce ? 0 : energy * (0.07 * Math.sin(3 * a + t * 2.4) + 0.05 * Math.sin(5 * a - t * 3.1) + 0.03 * Math.sin(8 * a + t * 5.2));
        const idle = 0.015 * Math.sin(2 * a + t * 0.8);
        const r = R * (1 + wob + idle);
        const x = c + Math.cos(a) * r;
        const y = c + Math.sin(a) * r;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath();
      const tint = mic > out ? 0.25 * mic : 0; // your voice lightens it a little
      const body = ctx.createRadialGradient(c - R * 0.35, c - R * 0.4, R * 0.1, c, c, R * 1.1);
      body.addColorStop(0, css(mix(base, [255, 255, 255], 0.55 + tint), dim));
      body.addColorStop(0.45, css(mix(base, [255, 255, 255], 0.12 + tint), dim));
      body.addColorStop(1, css(mix(base, [0, 0, 0], 0.35), dim));
      ctx.fillStyle = body;
      ctx.fill();

      // Highlight.
      const hl = ctx.createRadialGradient(c - R * 0.38, c - R * 0.45, 0, c - R * 0.38, c - R * 0.45, R * 0.55);
      hl.addColorStop(0, `rgba(255,255,255,${0.35 * dim})`);
      hl.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = hl;
      ctx.fill();

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [size]);

  return <canvas ref={ref} className="vorb" style={{ width: size, height: size }} aria-hidden />;
}
