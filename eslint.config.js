import js from '@eslint/js';
import ts from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import prettierConfig from 'eslint-config-prettier';

export default [
  js.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      globals: {
        // Browser/DOM globals - TypeScript 已经提供这些类型定义
        window: 'readonly',
        document: 'readonly',
        localStorage: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        console: 'readonly',
        Blob: 'readonly',
        URL: 'readonly',
        navigator: 'readonly',
        crypto: 'readonly',
        atob: 'readonly',
        btoa: 'readonly',
        React: 'readonly',
        Date: 'readonly',
        // DOM 事件和元素类型
        MouseEvent: 'readonly',
        KeyboardEvent: 'readonly',
        HTMLElement: 'readonly',
        HTMLInputElement: 'readonly',
        HTMLButtonElement: 'readonly',
        HTMLSelectElement: 'readonly',
        HTMLTextAreaElement: 'readonly',
        Node: 'readonly',
        JSX: 'readonly',
        // 动画 API
        requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly',
        // 浏览器 API
        alert: 'readonly',
        confirm: 'readonly',
        Notification: 'readonly',
        ScrollBehavior: 'readonly',
      },
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
    plugins: {
      '@typescript-eslint': ts,
    },
    rules: {
      ...ts.configs.recommended.rules,
      // 禁用不需要的基础规则 - TypeScript 已经检查这些
      'no-undef': 'off',
      'no-redeclare': 'off',
      'no-useless-assignment': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_|streak' },
      ],
      '@typescript-eslint/no-explicit-any': 'off',
      // 🎨 禁止硬编码颜色 - 必须使用 CSS 变量或主题系统
      'no-restricted-syntax': [
        'error',
        {
          selector: "Literal[value=/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3}|[A-Fa-f0-9]{8})$/] ~ :matches(Property[key.name='style'], Literal[value=/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3}|[A-Fa-f0-9]{8})$/]):not(Literal[value='#00000000'])",
          message: '禁止使用硬编码十六进制颜色值！请使用 CSS 变量 (var(--color-*)) 或主题系统。',
        },
        {
          selector: "CallExpression[callee.object.name='document'] Literal[value=/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/] ~ :not(Literal[value=/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/]):not(Literal[value='#00000000'])",
          message: '禁止使用硬编码十六进制颜色值！请使用 CSS 变量或主题系统。',
        },
      ],
    },
  },
  prettierConfig,
];
