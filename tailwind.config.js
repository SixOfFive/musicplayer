/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Spotify-inspired palette
        'bg-base': '#121212',
        'bg-elev-1': '#181818',
        'bg-elev-2': '#1f1f1f',
        'bg-highlight': '#2a2a2a',
        'bg-sidebar': '#000000',
        'text-primary': '#ffffff',
        'text-secondary': '#b3b3b3',
        'text-muted': '#7a7a7a',
        'accent': '#1DB954',
        'accent-hover': '#1ed760',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
