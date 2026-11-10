import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/.tmp/**',
      '**/.playwright-mcp/**',
      '**/.trae/**',
      'pnpm-lock.yaml',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      // 显式指定 tsconfig 根目录。仓库出现嵌套子包（apps/hongguo）后，
      // typescript-eslint 会看到多个候选根目录并报 TSConfigRootDirs 错误。
      parserOptions: { tsconfigRootDir: import.meta.dirname },
      globals: {
        ...globals.node,
      },
    },
    rules: {
      curly: ['error', 'all'],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
);
