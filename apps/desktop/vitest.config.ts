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
    ],
  },
})
