import { cpSync, mkdirSync, readdirSync, rmSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '../..');
const target = path.join(root, 'apple/Resources/www');
rmSync(target, { recursive: true, force: true }); mkdirSync(target, { recursive: true });
cpSync(path.join(root, 'dist-ios'), target, { recursive: true });
for (const name of ['screenshots', 'screenshot.png', 'wiki', 'guides', 'get-started', 'how-to-play', 'self-hosting', 'pax-historia-alternative', 'sitemap.xml', 'sitemap.txt', 'robots.txt', 'sw.js', 'version.json', 'consent.js', 'fonts']) rmSync(path.join(target, name), { recursive: true, force: true });
cpSync(path.join(root, 'LICENSE'), path.join(target, 'LICENSE.txt'));
function size(dir) { return readdirSync(dir, { withFileTypes: true }).reduce((sum, entry) => sum + (entry.isDirectory() ? size(path.join(dir, entry.name)) : statSync(path.join(dir, entry.name)).size), 0); }
const bytes = size(target);
if (bytes > 80_000_000) throw new Error(`Web resources exceed the 80 MB budget: ${bytes}. Leave room for native executable under Apple's 100 MB limit.`);
const html = readFileSync(path.join(target, 'index.html'), 'utf8');
if (/googletagmanager|gtag\(|umami|consent\.js/.test(html)) throw new Error('Analytics in Apple bundle');
writeFileSync(path.join(root, 'apple/build-size.json'), JSON.stringify({ webResourcesBytes: bytes, limit: 80000000 }, null, 2));
console.log(`Apple resources: ${bytes} bytes. Map archives stream from existing verified content nodes; no website is embedded.`);
