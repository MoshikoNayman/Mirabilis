// frontend/src/components/ui/StatusOrb.jsx
// The Mirabilis flower as a living presence orb. Its ring/glow reflects the
// aggregate provider presence; it "breathes" when idle and speeds up while a
// response is streaming. This is the ICQ flower, reimagined with Apple polish.
'use client';

const STATE_COLOR = {
  online: 'var(--presence-online)',
  away: 'var(--presence-away)',
  busy: 'var(--presence-busy)',
  offline: 'var(--presence-offline)',
  unknown: 'var(--presence-offline)'
};

// The ICQ mascot flower, duotone: accent spiral petals with a lighter-accent
// pair and the signature yellow heart. Petals use the authentic ICQ path data,
// so it recolors with the active theme accent while keeping the ICQ silhouette.
const ICQ_PETALS = [
  'm106.61 110.23s-42.218-47.933-48.752-62.93c-6.534-14.998-4.4796-30.925 7.3807-35.35 11.86-4.4252 29.058 10.284 32.436 29.134 3.3782 18.85 8.9346 69.146 8.9346 69.146z',
  'm104.24 108.08s-3.4772-58.275 0-77.208c3.4772-18.933 21.955-27.771 36.631-23.482 14.676 4.2897 26.361 23.591 15.968 42.267-10.394 18.676-52.599 58.422-52.599 58.422z',
  'm104.14 106.37s40.123-44.003 58.085-48.769c17.962-4.7668 29.582-2.6383 34.339 9.6808 4.7576 12.319-7.0663 24.257-24.476 31.234-17.41 6.977-67.948 7.8542-67.948 7.8542z',
  'm103.95 105.45s64.011-10.41 80.734-0.91329c16.724 9.4971 17.563 19.84 16.256 31.234s-7.5384 23.693-28.129 23.197-68.862-53.518-68.862-53.518z',
  'm103.38 103.59s33.695 33.474 41.812 47.95c8.1173 14.476 5.3388 30.4-1.7262 35.866s-18.627 2.975-30.496-11.508c-11.869-14.483-9.59-72.308-9.59-72.308z',
  'm104.47 106.23s9.8769 64.267 0.54797 79.273c-9.329 15.006-22.579 21.054-35.001 17.249s-20.905-12.366-19.065-32.592c1.8397-20.226 53.518-63.93 53.518-63.93z'
];
const ICQ_PETAL_A = 'm103.44 107.4s-35.939 37.331-51.327 40.732c-15.388 3.4011-23.473 2.9458-28.129-4.9317s-5.067-16.321 7.6716-27.216 71.784-8.5849 71.784-8.5849z';
const ICQ_PETAL_B = 'm102.01 107.02s-49.266 2.8098-69.592 0-24.215-11.647-23.745-23.745c0.46999-12.098 15.745-27.854 33.426-27.033s59.911 50.779 59.911 50.779z';

export function FlowerMark({ size = 22, variant = 'accent' }) {
  // 'classic' = the authentic ICQ colours (green petals, one red petal, yellow
  // heart, black outline) - used for the spinning "searching" state so the red
  // petal makes the rotation read, just like the original ICQ. 'accent' = the
  // theme-tinted duotone used at rest.
  if (variant === 'classic') {
    return (
      <svg width={size} height={size} viewBox="0 0 210 210" className="icq-mark-svg" style={{ width: size, height: size }} aria-hidden="true">
        <g stroke="#000" strokeLinecap="round" strokeLinejoin="round" strokeWidth="13.229">
          {ICQ_PETALS.map((d, i) => (
            <path key={i} d={d} fill="#00ff03" />
          ))}
          <path d={ICQ_PETAL_A} fill="#f5091f" />
          <path d={ICQ_PETAL_B} fill="#00ff03" />
          <circle cx="103.56" cy="104.51" r="22.852" fill="#f8ee3e" />
        </g>
      </svg>
    );
  }
  const light = 'color-mix(in srgb, var(--accent) 55%, #ffffff)';
  return (
    <svg width={size} height={size} viewBox="0 0 210 210" className="icq-mark-svg" style={{ width: size, height: size }} aria-hidden="true">
      {ICQ_PETALS.map((d, i) => (
        <path key={i} d={d} fill="var(--accent)" />
      ))}
      <path d={ICQ_PETAL_A} fill={light} />
      <path d={ICQ_PETAL_B} fill={light} />
      <circle cx="103.56" cy="104.51" r="22.852" fill="#f8ee3e" />
    </svg>
  );
}

export default function StatusOrb({ state = 'unknown', size = 34, onClick, label, spinning = false }) {
  const color = STATE_COLOR[state] || STATE_COLOR.unknown;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label || 'Buddy list and presence'}
      title={spinning ? 'Searching…' : (label || 'Buddy list')}
      className="au-focus relative inline-flex items-center justify-center rounded-full transition active:scale-95"
      style={{ width: size, height: size }}
    >
      <span
        className="au-orb-ring icq-mark relative inline-flex items-center justify-center"
        data-state={spinning ? 'busy' : state}
        style={{
          width: size,
          height: size,
          boxShadow: `inset 0 0 0 1px var(--hairline), 0 0 0 2px color-mix(in srgb, ${color} 38%, transparent), var(--shadow-2)`
        }}
      >
        <span className={spinning ? 'icq-spin inline-flex' : 'inline-flex'}>
          <FlowerMark size={Math.round(size * 0.62)} variant={spinning ? 'classic' : 'accent'} />
        </span>
      </span>
      <span
        className="au-dot absolute -bottom-0.5 -right-0.5"
        data-presence={state === 'unknown' ? 'offline' : state}
      />
    </button>
  );
}
