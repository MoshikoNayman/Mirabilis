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

export function FlowerMark({ size = 22 }) {
  // Six-petal flower — simple, crisp, scalable.
  const petals = [0, 60, 120, 180, 240, 300];
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" className="icq-mark-svg" aria-hidden="true">
      <g transform="translate(24 24)">
        {petals.map((deg) => (
          <ellipse
            key={deg}
            rx="7"
            ry="13"
            cx="0"
            cy="-9"
            transform={`rotate(${deg})`}
            fill="var(--accent)"
            opacity="0.92"
          />
        ))}
        <circle r="6.5" fill="#fff" opacity="0.95" />
        <circle r="4" fill="var(--accent)" />
      </g>
    </svg>
  );
}

export default function StatusOrb({ state = 'unknown', size = 34, onClick, label }) {
  const color = STATE_COLOR[state] || STATE_COLOR.unknown;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label || 'Buddy list and presence'}
      title={label || 'Buddy list'}
      className="au-focus relative inline-flex items-center justify-center rounded-full transition active:scale-95"
      style={{ width: size, height: size }}
    >
      <span
        className="au-orb-ring icq-mark relative inline-flex items-center justify-center"
        data-state={state}
        style={{
          width: size,
          height: size,
          boxShadow: `inset 0 0 0 1px var(--hairline), 0 0 0 2px color-mix(in srgb, ${color} 38%, transparent), var(--shadow-2)`
        }}
      >
        <FlowerMark size={Math.round(size * 0.62)} />
      </span>
      <span
        className="au-dot absolute -bottom-0.5 -right-0.5"
        data-presence={state === 'unknown' ? 'offline' : state}
      />
    </button>
  );
}
