import eslint from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';
import { defineConfig } from 'eslint/config';
import { importX } from 'eslint-plugin-import-x';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import sonarjs from 'eslint-plugin-sonarjs';
import unicorn from 'eslint-plugin-unicorn';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  {
    ignores: ['dist/**', 'node_modules/**', 'eslint.config.mjs'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  importX.flatConfigs.recommended,
  importX.flatConfigs.typescript,
  sonarjs.configs.recommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
      },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    settings: {
      'import-x/resolver': {
        typescript: {
          project: './tsconfig.json',
          alwaysTryTypes: true,
        },
      },
    },
    plugins: {
      unicorn,
    },
    rules: {
      '@typescript-eslint/interface-name-prefix': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-extraneous-class': 'off',
      'sonarjs/todo-tag': 'warn',
      'sonarjs/no-duplicate-string': 'error',
      'sonarjs/no-collapsible-if': 'error',
      'sonarjs/cyclomatic-complexity': 'error',
      '@typescript-eslint/explicit-member-accessibility': [
        'error',
        { accessibility: 'explicit' },
      ],
      '@typescript-eslint/naming-convention': [
        'error',
        {
          selector: 'memberLike',
          modifiers: ['private'],
          format: ['camelCase'],
          leadingUnderscore: 'require',
        },
        {
          selector: 'memberLike',
          modifiers: ['protected'],
          format: ['camelCase'],
          leadingUnderscore: 'require',
        },
        {
          selector: 'method',
          modifiers: ['private', 'static'],
          format: ['camelCase'],
          leadingUnderscore: 'require',
        },
        {
          selector: 'classProperty',
          modifiers: ['private', 'static'],
          format: null,
          custom: {
            regex: '^(_[a-z][a-zA-Z0-9]*|[A-Z][A-Z0-9_]*)$',
            match: true,
          },
        },
      ],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/prefer-nullish-coalescing': 'error',
      '@typescript-eslint/prefer-optional-chain': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
      '@typescript-eslint/array-type': [
        'error',
        { default: 'array', readonly: 'generic' },
      ],
      '@typescript-eslint/consistent-type-definitions': ['error', 'type'],
      '@typescript-eslint/member-ordering': [
        'error',
        {
          default: {
            memberTypes: [
              'public-static-field',
              'protected-static-field',
              'private-static-field',
              'public-instance-field',
              'protected-instance-field',
              'private-instance-field',
              'constructor',
              'public-static-method',
              'protected-static-method',
              'private-static-method',
              'public-instance-method',
              'protected-instance-method',
              'private-instance-method',
            ],
          },
        },
      ],
      '@typescript-eslint/prefer-readonly': 'error',
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true },
      ],

      'import-x/no-cycle': ['error', { maxDepth: Infinity }],
      'import-x/no-duplicates': 'error',
      'import-x/order': [
        'error',
        {
          groups: [
            'builtin',
            'external',
            'internal',
            'parent',
            'sibling',
            'index',
            'type',
          ],
          'newlines-between': 'never',
          alphabetize: { order: 'asc', caseInsensitive: true },
        },
      ],

      'unicorn/prefer-node-protocol': 'error',
      'unicorn/no-useless-undefined': 'error',
      'unicorn/prefer-includes': 'error',
      'unicorn/prefer-array-some': 'error',
      'unicorn/prefer-array-find': 'error',
      'unicorn/prefer-string-slice': 'error',
      'unicorn/prefer-number-properties': 'error',
      'unicorn/no-for-each': 'error',
      'unicorn/no-useless-spread': 'error',
      'unicorn/prefer-optional-catch-binding': 'error',
      'unicorn/prefer-regexp-test': 'error',
      'unicorn/error-message': 'error',
      'unicorn/throw-new-error': 'error',

      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['/src', '/src/**'],
              message:
                'Absolute imports from `src/...` are forbidden. Use relative imports (e.g. `../../lib/...`).',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    ignores: ['test/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'ImportDeclaration[source.value=/^(\\.\\.\\/)+src(\\/|$)/]',
          message:
            'Relative imports into `src/` are only allowed from `test/`.',
        },
        {
          selector:
            'ExportNamedDeclaration[source.value=/^(\\.\\.\\/)+src(\\/|$)/]',
          message:
            'Relative imports into `src/` are only allowed from `test/`.',
        },
        {
          selector:
            'ExportAllDeclaration[source.value=/^(\\.\\.\\/)+src(\\/|$)/]',
          message:
            'Relative imports into `src/` are only allowed from `test/`.',
        },
      ],
    },
  },
  {
    files: ['**/*.module.ts'],
    rules: {
      'import-x/no-cycle': 'off',
    },
  },
  {
    files: ['test/**/*.{ts,tsx}', '**/*.spec.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-enum-comparison': 'off',
      'import-x/no-cycle': 'off',
      'sonarjs/no-duplicate-string': 'off',
      'sonarjs/hardcoded-secret-signatures': 'off',
      'sonarjs/cognitive-complexity': 'off',
      'sonarjs/cyclomatic-complexity': 'off',
    },
  },
  eslintPluginPrettierRecommended,
  {
    plugins: {
      '@stylistic': stylistic,
    },
    rules: {
      curly: ['error', 'all'],
      '@stylistic/padding-line-between-statements': [
        'error',
        { blankLine: 'always', prev: '*', next: 'return' },
        { blankLine: 'always', prev: 'block-like', next: '*' },
        {
          blankLine: 'always',
          prev: [
            'type',
            'interface',
            {
              selector:
                'ExportNamedDeclaration[declaration.type="TSTypeAliasDeclaration"]',
            },
            {
              selector:
                'ExportNamedDeclaration[declaration.type="TSInterfaceDeclaration"]',
            },
          ],
          next: '*',
        },
      ],
    },
  },
);
