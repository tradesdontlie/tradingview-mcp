import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        surface: {
          0: '#0d0f12',
          1: '#13161c',
          2: '#1a1e27',
          3: '#232836',
        },
        accent: {
          blue:   '#3b82f6',
          green:  '#22c55e',
          yellow: '#eab308',
          red:    '#ef4444',
          purple: '#a855f7',
        },
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Fira Code', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
} satisfies Config;
