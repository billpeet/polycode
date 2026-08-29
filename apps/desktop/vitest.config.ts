import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'main',
          include: ['src/main/**/*.test.ts'],
          environment: 'node',
          setupFiles: ['./src/main/driver/__tests__/setup.ts'],
        },
      },
      {
        test: {
          name: 'renderer',
          include: ['src/renderer/src/**/*.test.{ts,tsx}'],
          environment: 'node',
        },
      },
      {
        // packages/shared has no test runner of its own and is consumed as raw
        // TypeScript by both apps. Running its suite here keeps protocol and
        // presentation logic shared by desktop and mobile covered by `pnpm test`.
        test: {
          name: 'shared',
          root: '../../packages/shared',
          include: ['src/**/*.test.ts'],
          environment: 'node',
        },
      },
    ],
  },
})
