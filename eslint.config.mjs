import eslint from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

const typescriptFiles = ['apps/**/*.{ts,tsx}', 'packages/**/*.ts']
const reactFiles = ['apps/desktop/src/renderer/src/**/*.{ts,tsx}', 'apps/mobile/**/*.{ts,tsx}']

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
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
  {
    files: reactFiles,
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
)
