/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{js,jsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        ink: '#0b1220',
        mist: '#edf4ff',
        accent: '#1aa86f',
        accentSoft: '#dcfce7'
      }
    }
  },
  plugins: []
};
