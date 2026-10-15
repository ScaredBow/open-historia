import { chromium } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = path.resolve(import.meta.dirname, '../Resources/www');
const bridge = fs.readFileSync(path.resolve(import.meta.dirname, '../Resources/bridge.js'), 'utf8');
const server = http.createServer((req, res) => {
  const file = path.join(root, new URL(req.url, 'http://localhost').pathname);
  const target = file.endsWith('/') ? file + 'index.html' : file;
  try {
    const bytes = fs.readFileSync(target);
    res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.json': 'application/json', '.geojson': 'application/json', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png' })[path.extname(target)] || 'application/octet-stream');
    res.end(bytes);
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const executablePath = process.env.BROWSER_PATH || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/chromium');
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
const errors = [];
async function makePage(clip, archive = null) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
  // Native responses are mocked here. XCTest and signed-device tests cover the
  // native boundary and real OAuth. No account credentials enter this harness.
  await page.addInitScript(({ archive }) => {
    let connected = false; window.nativeCalls = []; window.savedArchive = null;
    window.webkit = { messageHandlers: { historia: { postMessage: async ({ method, args }) => {
      window.nativeCalls.push(method);
      const profile = { id: 'p1', label: 'Connection 1', email: 'tester@example.invalid', status: 'connected', sharing: true };
      let value = null;
      if (method === 'snapshot') value = { activeId: connected ? 'p1' : null, profiles: connected ? [profile] : [] };
      else if (method === 'signIn') { connected = true; value = profile; }
      else if (method === 'models') value = [{ slug: 'test-model', name: 'Test model' }];
      else if (method === 'disconnect') { connected = false; value = { revoked: true }; }
      else if (method === 'saveArchive') window.savedArchive = args[0];
      else if (method === 'readArchive') value = archive;
      return { ok: true, value };
    } } } };
  }, { archive });
  await page.addInitScript(bridge.replaceAll('__IS_CLIP__', String(clip)));
  return page;
}
async function records(page, store) {
  return page.evaluate(name => new Promise((resolve, reject) => {
    const open = indexedDB.open('open-historia-web', 3);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result, tx = db.transaction(name), request = tx.objectStore(name).getAll();
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); tx.oncomplete = () => db.close();
    };
  }), store);
}
try {
  const clip = await makePage(true);
  await clip.goto(origin);
  await clip.getByRole('button', { name: 'Continue with ChatGPT', exact: true }).click();
  await clip.getByRole('dialog', { name: 'Welcome to Open Historia' }).waitFor({ state: 'detached' });
  assert.ok((await clip.evaluate(() => window.nativeCalls)).includes('signIn'));
  assert.ok((await clip.evaluate(() => window.nativeCalls)).includes('models'));
  await clip.getByRole('button', { name: 'Dismiss save notice' }).click();
  await clip.getByRole('button', { name: 'Scenarios', exact: true }).click();
  await clip.getByRole('button', { name: 'New Game', exact: true }).first().click();
  await clip.getByRole('button', { name: 'Scenario default', exact: true }).click();
  await clip.getByRole('button', { name: /Medium.*Neutral/ }).click();
  await clip.waitForFunction(async () => {
    const response = await fetch('/api/library/games');
    return response.ok;
  });
  // Wait for the committed game record, rather than a fixed animation delay.
  let games = [];
  for (let attempt = 0; attempt < 100 && !games.length; attempt++) { games = await records(clip, 'games'); if (!games.length) await clip.waitForTimeout(100); }
  assert.equal(games.length, 1);
  await clip.evaluate(() => window.ohKeepAppleSaves());
  const archive = await clip.evaluate(() => window.savedArchive);
  assert.equal(JSON.parse(archive).format, 1);
  const app = await makePage(false, archive);
  await app.goto(origin);
  await app.waitForFunction(() => localStorage.getItem('oh:apple-transfer') === '1');
  const imported = await records(app, 'games');
  assert.equal(imported.length, 1); assert.equal(imported[0].id, games[0].id);
  assert.ok(await app.evaluate(() => Object.values(localStorage).some(value => value.includes('p1'))));
  await app.reload();
  await app.waitForFunction(() => typeof window.ohKeepAppleSaves === 'function');
  assert.equal((await records(app, 'games')).length, 1);
  // Even without the import marker, a later Clip archive cannot overwrite an
  // existing full-app campaign. This exercises the database emptiness guard.
  await app.evaluate(id => new Promise((resolve, reject) => {
    localStorage.removeItem('oh:apple-transfer');
    const open = indexedDB.open('open-historia-web', 3);
    open.onsuccess = () => {
      const db = open.result, tx = db.transaction('games', 'readwrite'), store = tx.objectStore('games');
      const request = store.get(id);
      request.onsuccess = () => store.put({ ...request.result, appleTestMarker: 'keep-existing' });
      tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error);
    };
  }), games[0].id);
  await app.reload();
  await app.waitForFunction(() => typeof window.ohKeepAppleSaves === 'function');
  assert.equal((await records(app, 'games'))[0].appleTestMarker, 'keep-existing');
  assert.deepEqual(errors, []);
  console.log('PASS: native-bridge first-run sign-in/model discovery, local game creation, typed save transfer to fresh full app, restart without duplication; no page errors.');
} finally { await browser.close(); server.close(); }
