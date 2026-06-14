import { defineConfig } from 'oxfmt';

export default defineConfig({
  quoteProps: 'as-needed',
  jsdoc: {
    preferCodeFences: true,
    capitalizeDescriptions: false,
  },
  arrowParens: 'always',
  bracketSpacing: true,
  bracketSameLine: false,
  singleQuote: true,
  endOfLine: 'lf',
  jsxSingleQuote: false,
  sortPackageJson: false,
  objectWrap: 'preserve',
  printWidth: 80,
  insertFinalNewline: true,
  tabWidth: 2,
  useTabs: false,
  semi: true,
  sortImports: {
    groups: [
      'builtin',
      'testing',
      'next',
      'react',
      'external',
      'lawy',
      'internal',
      ['parent', 'sibling', 'index'],
      'unknown',
    ],
    internalPattern: ['~/', '@/', '#'],
    customGroups: [
      {
        groupName: 'testing',
        elementNamePattern: ['@playwright/**', 'vitest', 'vitest/**'],
      },
      {
        groupName: 'next',
        elementNamePattern: ['next', 'next/**'],
      },
      {
        groupName: 'react',
        elementNamePattern: ['react', 'react-dom', 'react/**', 'react-dom/**'],
      },
      {
        groupName: 'lawy',
        elementNamePattern: ['@lawy/**/*'],
      },
    ],
    newlinesBetween: false,
    order: 'asc',
    ignoreCase: true,
  },
  ignorePatterns: [
    '**/.vite',
    '**/.wrangler',
    '.agents',
    '**/coverage',
    '**/test-report',
    '**/test-results',
    '**/dist',
    '**/*.tsbuildinfo',
    '**/node_modules',
  ],
  proseWrap: 'preserve',
  overrides: [
    {
      files: ['**/*.{json,jsonc}'],
      options: {
        trailingComma: 'none',
      },
    },
  ],
});