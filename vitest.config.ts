import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/global-setup.ts'],
    setupFiles: ['tests/setup.ts'],
    // Git run by tests and by the CLI under test ignores the developer's configuration.
    env: { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    // Most tests run git and the CLI several times: allow for slow, busy CI
    // machines, where they take twice as long as usual.
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/cli.ts'],
      // Just under the current coverage: a drop fails `pnpm test:coverage`.
      thresholds: { statements: 90, branches: 87, functions: 88, lines: 91 },
    },
  },
})
