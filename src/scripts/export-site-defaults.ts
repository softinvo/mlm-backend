/**
 * Writes the website's built-in content to main-frontend/src/site/defaultSite.json.
 * The public site shows that copy whenever the API can't be reached, so a visitor never sees a half-empty page.
 * Run it after changing src/services/site.defaults.ts:   npm run export:site
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DEFAULT_SITE } from '../services/site.defaults';

const out = resolve(__dirname, '../../../main-frontend/src/site/defaultSite.json');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(DEFAULT_SITE, null, 2) + '\n');
console.log(`Wrote ${out}`);
