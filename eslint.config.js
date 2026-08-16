// ESLint flat config. The game has no build step: game.js runs in both Node (tests)
// and the browser, and renderer.js consumes game.js's functions as window globals —
// hence the explicit shared-globals list below.
'use strict';

const js = require('@eslint/js');

// Everything game.js publishes onto `window` for renderer.js (keep in sync with the
// export blocks at the bottom of web/game.js)
const gameGlobals = Object.fromEntries(
  Object.keys(require('./web/game.js')).map((name) => [name, 'readonly'])
);

const browserGlobals = {
  window: 'readonly',
  document: 'readonly',
  localStorage: 'readonly',
  navigator: 'readonly',
  performance: 'readonly',
  requestAnimationFrame: 'readonly',
  cancelAnimationFrame: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  console: 'readonly',
  AudioContext: 'readonly',
  Float32Array: 'readonly',
  Uint8Array: 'readonly',
  TextEncoder: 'readonly',
  TextDecoder: 'readonly',
  btoa: 'readonly',
  atob: 'readonly',
  alert: 'readonly',
  confirm: 'readonly',
  prompt: 'readonly',
};

module.exports = [
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: {
        module: 'writable',
        require: 'readonly',
        process: 'readonly',
        console: 'readonly',
        __dirname: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['error', { args: 'none' }],
    },
  },
  {
    // game.js defines the shared functions; it must not see them as pre-existing globals
    files: ['web/game.js'],
    languageOptions: {
      sourceType: 'script',
      globals: browserGlobals,
    },
  },
  {
    files: ['web/renderer.js'],
    languageOptions: {
      sourceType: 'script',
      globals: { ...browserGlobals, ...gameGlobals },
    },
  },
];
