import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        display: ['"Cormorant Garamond"', 'serif'],
        body: ['"Lora"', 'serif'],
        mono: ['"JetBrains Mono"', 'monospace'],
      },
      colors: {
        ink: {
          950: '#0A0806',
          900: '#0E0B07',
          800: '#141008',
          700: '#1C1510',
          600: '#2A1E14',
          500: '#3A2C1E',
        },
        gold: {
          300: '#F2C97A',
          400: '#E8A84A',
          500: '#D4922A',
          600: '#B87820',
        },
        cream: {
          50: '#FAF5EC',
          100: '#F2E8D4',
          200: '#E4D4B8',
          300: '#C8B898',
        },
        sage: {
          400: '#8BA88E',
          500: '#6B9E74',
          900: '#1E3A22',
        },
      },
    },
  },
  plugins: [],
};

export default config;
