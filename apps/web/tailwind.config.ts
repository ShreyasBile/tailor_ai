import type { Config } from 'tailwindcss';

export default {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        paper: '#f6f4ef',
        ink: {
          DEFAULT: '#14161a',
          soft: '#3a3e45',
          muted: '#6b7079',
          faint: '#9aa0a8',
        },
        line: '#e3dfd6',
        card: '#fffdf9',
        accent: {
          DEFAULT: '#2f5d50',
          soft: '#e4eee9',
          ink: '#1d3d34',
        },
        good: '#2f7a4f',
        warn: '#b7791f',
        bad: '#b4432f',
      },
      fontFamily: {
        sans: ['var(--font-sans)', 'system-ui', 'sans-serif'],
        display: ['var(--font-display)', 'Georgia', 'serif'],
      },
      boxShadow: {
        soft: '0 1px 2px rgba(20,22,26,0.04), 0 8px 24px -12px rgba(20,22,26,0.12)',
        lift: '0 2px 4px rgba(20,22,26,0.05), 0 20px 40px -20px rgba(20,22,26,0.25)',
      },
      borderRadius: {
        xl2: '1.25rem',
      },
      keyframes: {
        'fade-up': {
          from: { opacity: '0', transform: 'translateY(6px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        scan: {
          '0%': { transform: 'translateY(0%)' },
          '100%': { transform: 'translateY(100%)' },
        },
      },
      animation: {
        'fade-up': 'fade-up 0.4s ease-out both',
        scan: 'scan 2.2s ease-in-out infinite alternate',
      },
    },
  },
  plugins: [],
} satisfies Config;
