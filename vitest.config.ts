import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Rule tests are pure node — bypass project PostCSS (Tailwind v4)
  // so vitest doesn't try to load the @tailwindcss/postcss plugin.
  css: { postcss: { plugins: [] } },
  test: {
    include: ['lib/**/__tests__/**/*.test.ts'],
    environment: 'node',
  },
});
