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
const subprocessMessage =
  'Use the Runner seam (driver/runner) to run commands, or process-control.ts to kill them. ' +
  'If neither fits, add an eslint-disable with the reason.'

const restrictedSubprocessPaths = [
  { name: 'child_process', allowTypeImports: true, message: subprocessMessage },
  { name: 'node:child_process', allowTypeImports: true, message: subprocessMessage },
]

const restrictedRunnerPatterns = [{
  group: ['**/driver/runner/*'],
  message:
    "Import from 'driver/runner' itself. Reaching into an adapter or into utils " +
    'means using something the seam did not choose to expose — if you need it, ' +
    'export it from the index and say why.',
}]

// eslint flat config merges by rule name, last match wins — so these blocks
// restate the whole rule rather than adding to it. Order is significant.
const runnerOwnsSubprocesses = {
  files: ['apps/desktop/src/main/**/*.ts'],
  ignores: ['**/__tests__/**'],
  rules: {
    '@typescript-eslint/no-restricted-imports': ['error', {
      paths: restrictedSubprocessPaths,
      patterns: restrictedRunnerPatterns,
    }],
  },
}

/**
 * The Runner is reached through its interface, not through its files.
 *
 * Before the shell-exec fold, three modules imported adapter-construction
 * helpers — buildSshBaseArgs, cdTarget, shellEscape — and then built the ssh and
 * wsl invocations themselves. That is tighter coupling than existed before the
 * seam: every such import made the eventual migration harder rather than easier.
 *
 * `driver/runner` (the index) is the interface and stays open — it deliberately
 * exports shared shell vocabulary (shellEscape, cdTarget, LOAD_NODE_MANAGERS,
 * the codex resolvers) that callers composing POSIX scripts genuinely need.
 * What is closed is reaching past it into a specific file, because that is how a
 * caller gets at something the seam chose not to offer.
 */
const driversMayReachIntoTheSeam = {
  // Drivers sit against the seam rather than behind it: they implement
  // buildCommand in terms of SpawnCommand and are what the adapters exist to
  // serve. The deep-path rule does not apply to them; the subprocess rule does.
  files: ['apps/desktop/src/main/driver/**/*.ts'],
  ignores: ['**/__tests__/**'],
  rules: {
    '@typescript-eslint/no-restricted-imports': ['error', { paths: restrictedSubprocessPaths }],
  },
}

const boundaryOwners = {
  files: [
    // The seam itself.
    'apps/desktop/src/main/driver/runner/**/*.ts',
    // The OS process-control module: killing by pid, finding what holds a port.
    // A different concern from running a command, with its own home already.
    'apps/desktop/src/main/process-control.ts',
    // Fire-and-forget GUI launching (VS Code, Explorer, Terminal). Genuinely not
    // "run a command and collect output" — nothing to collect, nothing to wait for.
    'apps/desktop/src/main/ipc/handlers.ts',
  ],
  rules: {
    '@typescript-eslint/no-restricted-imports': 'off',
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
  driversMayReachIntoTheSeam,
  boundaryOwners,
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
