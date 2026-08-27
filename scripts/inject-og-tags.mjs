/**
 * Post-build script: injects Open Graph / Twitter Card meta tags into
 * dist/index.html and copies the app icon to dist/ for use as the OG image.
 *
 * Run automatically via `npm run build:web` (see package.json).
 */

import { readFileSync, writeFileSync, copyFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

// ── Copy icon to dist so it's served at https://wightmare.com/og-image.png ──
copyFileSync(
  resolve(root, 'assests', 'icon.png'),
  resolve(root, 'dist', 'og-image.png'),
);

// ── Build the OG / Twitter meta tag block ──
const ogTags = `
    <!-- Open Graph -->
    <meta property="og:type"        content="website" />
    <meta property="og:url"         content="https://wightmare.com/" />
    <meta property="og:title"       content="WightMare" />
    <meta property="og:description" content="WightMare – a fast-paced survival game. Connect the dots, dodge the lines, and see how long you can last." />
    <meta property="og:image"       content="https://wightmare.com/og-image.png" />
    <meta property="og:image:alt"   content="WightMare logo" />

    <!-- Twitter / X Card -->
    <meta name="twitter:card"        content="summary" />
    <meta name="twitter:url"         content="https://wightmare.com/" />
    <meta name="twitter:title"       content="WightMare" />
    <meta name="twitter:description" content="WightMare – a fast-paced survival game. Connect the dots, dodge the lines, and see how long you can last." />
    <meta name="twitter:image"       content="https://wightmare.com/og-image.png" />

    <!-- Standard description -->
    <meta name="description" content="WightMare – a fast-paced survival game. Connect the dots, dodge the lines, and see how long you can last." />`;

// ── Inject just before </head> ──
const htmlPath = resolve(root, 'dist', 'index.html');
let html = readFileSync(htmlPath, 'utf8');

if (html.includes('<!-- Open Graph -->')) {
  console.log('OG tags already present – skipping injection.');
} else {
  html = html.replace('</head>', `${ogTags}\n  </head>`);
  writeFileSync(htmlPath, html, 'utf8');
  console.log('✓ OG meta tags injected into dist/index.html');
}

console.log('✓ og-image.png copied to dist/');
