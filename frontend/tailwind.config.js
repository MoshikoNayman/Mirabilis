/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{js,jsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        ink: '#0b1220',
        mist: '#edf4ff',
        // Wrap the CSS var in color-mix so Tailwind's opacity modifiers actually
        // work. Previously `accent: 'var(--accent)'` had no <alpha-value> slot, so
        // Tailwind dropped every `bg-accent/20`, `ring-accent/20`, `border-accent/30`
        // (75 usages) - they compiled to nothing. color-mix keeps solid `bg-accent`
        // working (alpha 1 = 100%) while making the /NN variants resolve correctly,
        // and it recolors per scheme because --accent is per-scheme.
        accent: 'color-mix(in srgb, var(--accent) calc(<alpha-value> * 100%), transparent)',
        accentSoft: 'color-mix(in srgb, var(--accent-soft) calc(<alpha-value> * 100%), transparent)'
      }
    }
  },
  plugins: []
};
