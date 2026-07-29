import eslint from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

const typescriptFiles = ['apps/**/*.{ts,tsx}', 'packages/**/*.ts']
const reactFiles = ['apps/desktop/src/renderer/src/**/*.{ts,tsx}', 'apps/mobile/**/*.{ts,tsx}']

/**
 * Running an external command is the Runner's job.
 *
 * Six separate implementations of "run a command at a Project Location" had
 * grown across the main process, each with its own transport ladder and its own
 * subtly different quoting. They are now one seam — `driver/runner/*` — and this
 * rule is what stops a seventh appearing: the next module that reaches for
 * child_process has to either use Runner or write down why it cannot.
 *
 * Type-only imports are allowed, because `ChildProcess` is the currency the seam
 * hands back and half the main process legitimately names it.
 *
 * The exceptions below own the boundary itself. Everything else that still needs
 * an escape hatch carries an inline eslint-disable with its reason, so the
 * remaining work stays visible rather than becoming quietly acceptable.
 */
const runnerOwnsSubprocesses = {
  files: ['apps/desktop/src/main/**/*.ts'],
  ignores: [
    // The seam.
    'apps/desktop/src/main/driver/runner/**',
    // The OS process-control module: killing by pid, finding what holds a port.
    // A different concern from running a command, with its own home already.
    'apps/desktop/src/main/process-control.ts',
    // Fire-and-forget GUI launching (VS Code, Explorer, Terminal). Genuinely not
    // "run a command and collect output" — nothing to collect, nothing to wait for.
    'apps/desktop/src/main/ipc/handlers.ts',
    '**/__tests__/**',
  ],
  rules: {
    '@typescript-eslint/no-restricted-imports': ['error', {
      paths: [{
        name: 'child_process',
        allowTypeImports: true,
        message:
          'Use the Runner seam (driver/runner) to run commands, or process-control.ts to kill them. ' +
          'If neither fits, add an eslint-disable with the reason.',
      }, {
        name: 'node:child_process',
        allowTypeImports: true,
        message:
          'Use the Runner seam (driver/runner) to run commands, or process-control.ts to kill them. ' +
          'If neither fits, add an eslint-disable with the reason.',
      }],
    }],
  },
}

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/out/**',
      '**/release/**',
      '**/.expo/**',
      '**/android/**',
      '**/ios/**',
      '**/*.d.ts',
    ],
  },
  {
    files: typescriptFiles,
    extends: [eslint.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 'latest',
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  runnerOwnsSubprocesses,
  {
    files: reactFiles,
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      ...reactHooks.configs.flat.recommended.rules,
    },
  },
)
