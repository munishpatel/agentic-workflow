import { defineConfig } from 'vitest/config'
import path from 'node:path'

/**
 * Kept separate from vite.config.ts on purpose: vitest ships its own copy of
 * vite, and passing the app's rolldown-based plugins through `vitest/config`
 * produces a type conflict. Tests only cover `src/lib` and `src/mocks`, which
 * need no plugins — just the `@` alias.
 */
export default defineConfig({
  resolve: { alias: { '@': path.resolve(import.meta.dirname, './src') } },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
