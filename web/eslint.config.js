import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['vite.config.ts', 'vitest.config.ts'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      eqeqeq: ['error', 'always'],
      // User data must never be parsed as HTML.
      'no-restricted-properties': [
        'error',
        { property: 'innerHTML', message: 'Build DOM with lib/dom.ts (textContent) instead.' },
        { property: 'outerHTML', message: 'Build DOM with lib/dom.ts (textContent) instead.' },
        { property: 'insertAdjacentHTML', message: 'Build DOM with lib/dom.ts instead.' },
      ],
    },
  },
  { files: ['eslint.config.js'], ...tseslint.configs.disableTypeChecked },
);
