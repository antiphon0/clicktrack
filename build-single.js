#!/usr/bin/env node
// Bundles web/{index.html, styles.css, game.js, renderer.js} into a single HTML file.
// Usage: node build-single.js > clicktrack.html

const fs = require('fs');
const path = require('path');

const webDir = path.join(__dirname, 'web');

const html = fs.readFileSync(path.join(webDir, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(webDir, 'styles.css'), 'utf8');
const gameJs = fs.readFileSync(path.join(webDir, 'game.js'), 'utf8');
const rendererJs = fs.readFileSync(path.join(webDir, 'renderer.js'), 'utf8');

let output = html;

// Replace CSS link with inline style.
// The (?:\?[^"]*)? tolerates the ?v= cache-buster on the asset URLs; without it these
// regexes silently fail to match and the "bundle" ships external <script src> tags.
output = output.replace(
  /<link\s+rel="stylesheet"\s+href="styles\.css(?:\?[^"]*)?"\s*\/?>/,
  `<style>\n${css}\n</style>`
);

// Replace script tags with inline scripts
output = output.replace(
  /<script\s+src="game\.js(?:\?[^"]*)?"><\/script>/,
  `<script>\n${gameJs}\n</script>`
);
output = output.replace(
  /<script\s+src="renderer\.js(?:\?[^"]*)?"><\/script>/,
  `<script>\n${rendererJs}\n</script>`
);

process.stdout.write(output);
