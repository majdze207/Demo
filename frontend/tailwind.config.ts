import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: { 50: '#fffbea', 100: '#fff3c4', 500: '#f5b301', 600: '#d99800', 700: '#b17a00' },
        surface: { 900: '#0a0a0f', 800: '#12121a', 700: '#1a1a26', 600: '#242433' },
        accent: { green: '#22c55e', red: '#ef4444', blue: '#3b82f6' },
      },
      boxShadow: { glow: '0 0 20px rgba(245, 179, 1, 0.35)' },
    },
  },
  plugins: [],
};
export default config;
