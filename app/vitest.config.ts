import type { TestProjectConfiguration } from 'vitest/config'
import { defineConfig } from 'vitest/config'

const reactUi: TestProjectConfiguration = {
  extends: './vite.config.ts',
  test: {
    name: 'ui',
    environment: 'jsdom',
    css: { include: [/status-stack\.css$/] },
    setupFiles: ['src/vitest.setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    globals: true,
    env: { NODE_ENV: 'development' },
    testTimeout: 15_000,
    hookTimeout: 30_000,
    // Keep node builtins external so the Vite transform doesn't externalize + truncate
    // them to a bare 'node:' specifier under the jsdom environment.
    deps: { external: [/^node:/] }
  }
}

const electronNative: TestProjectConfiguration = {
  test: {
    name: 'electron',
    environment: 'node',
    include: ['electron/**/*.test.ts', 'e2e/**/*.unit.test.ts'],
    testTimeout: 30_000
  }
}

export default defineConfig({
  test: {
    projects: [reactUi, electronNative]
  }
})
