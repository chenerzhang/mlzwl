import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', '**/*.d.ts'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      // 必须显式指定 tsconfigRootDir。本仓库有根与子包两个 tsconfig 目录，
      // 不指定时 typescript-eslint 会报 "multiple candidate TSConfigRootDirs"。
      parserOptions: { ecmaFeatures: { jsx: true }, tsconfigRootDir: import.meta.dirname },
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
    rules: {
      curly: ['error', 'all'],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // web 是浏览器环境，Node 全局不应可用
    files: ['web/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
  },
);
