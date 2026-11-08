// @ts-check
import eslint from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    name: 'ccw/global-ignores',
    ignores: ['**/node_modules/**', '**/dist/**', '.scratch/**', 'reference/**'],
  },

  {
    name: 'ccw/ts-source',
    files: ['packages/*/src/**/*.{ts,tsx}'],
    extends: [eslint.configs.recommended, tseslint.configs.recommended, tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
        onUnsupportedTypeScriptVersion: 'error',
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/no-unsafe-type-assertion': 'error',
      '@typescript-eslint/naming-convention': [
        'error',
        { selector: 'variable', format: ['camelCase', 'UPPER_CASE'] },
        { selector: 'function', format: ['camelCase', 'PascalCase'] },
        { selector: 'typeLike', format: ['PascalCase'] },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ImportExpression',
          message: '生产 TypeScript 源码禁止运行时动态 import。',
        },
      ],
    },
  },

  {
    name: 'ccw/machine-effects-only',
    files: ['packages/ccw/src/*.{ts,tsx}'],
    ignores: ['packages/ccw/src/machine.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:fs', 'node:fs/*', 'node:child_process', 'node:child_process/*'],
              message: '真实文件与进程效果只允许出现在 machine adapter。',
            },
          ],
        },
      ],
    },
  },

  {
    name: 'ccw/js-node',
    files: ['**/*.mjs'],
    extends: [eslint.configs.recommended, tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
);
