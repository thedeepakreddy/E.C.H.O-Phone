/** Real browser: Settings → Your Gemini key saves a key Google accepts, shows only its last 4, and a used-up day offers "Add my Gemini key". */
import assert from 'node:assert/strict';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { createRelay } from '../server.js';
import { GeminiError } from '../lib/gemini.js';

const pw = process.env.ECHO_BROWSER_DEPENDENCIES ? await import(pathToFileURL(join(process.env.ECHO_BROWSER_DEPENDENCIES, 'playwright/index.mjs')).href) : await import('playwright');
const shots = process.env.ECHO_KEY_SHOTS;
const GOOD = 'AIzaSyD-user-key-0123456789abcdefWXYZ';
const answer = (t) => ({ candidates: [{ content: { role: 'model', parts: [{ text: t }] } }] });
const gemini = { model: 'gemini-3.8-flash', embed: async () => Array(512).fill(0), generate: async () => { throw new GeminiError('day', 'Quota exceeded', { limit: 20 }); } };
const makeGemini = (apiKey) => ({ model: 'gemini-3.8-flash', listModels: async () => { if (apiKey !== GOOD) throw new GeminiError('auth', 'bad'); return ['gemini-3.8-flash']; }, generate: async () => answer('Answered with your own key.') });
const relay = createRelay({ secret: 'private-own-key-fixture-'.repeat(4), gemini, makeGemini, fetchJson: async () => ({}) });
const server = http.createServer(relay.handler);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await pw.chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block', deviceScaleFactor: shots ? 2 : 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept());
  await page.goto(base);
  await page.locator('#get-started').click();
  // Echo's key is used up: the failed reply offers to add one's own.
  await page.locator('[data-tab="chat"]').click();
  await page.waitForFunction(() => document.querySelector('#presence')?.textContent === 'on your phone');
  await page.locator('#chat-input').fill('Hello');
  await page.locator('#chat-input').press('Enter');
  const add = page.locator('[data-cloud-failure] button', { hasText: 'Add my Gemini key' });
  await add.waitFor();
  assert.match(await page.locator('[data-cloud-failure]').textContent(), /Add your own free Gemini key in Settings/);
  if (shots) await page.screenshot({ path: `${shots}/key-chat-limit.png` });
  await add.click();
  await page.waitForFunction(() => document.activeElement?.id === 'key-input');
  // A wrong key is refused; the right one is saved and shown only as its last 4.
  await page.locator('#key-input').fill('AIzaSyD-wrong-key-0123456789abcdef0000');
  await page.locator('#key-save').click();
  await page.waitForFunction(() => /Google didn't accept that key/.test(document.querySelector('#toast')?.textContent ?? ''));
  await page.locator('#key-input').fill(GOOD);
  await page.locator('#key-save').click();
  await page.waitForFunction(() => /••••WXYZ/.test(document.querySelector('#key-state')?.textContent ?? ''));
  assert.equal(await page.locator('#key-input').inputValue(), '', 'the field is cleared once saved');
  assert.equal(await page.locator('#key-input').getAttribute('type'), 'password');
  assert.equal(await page.locator('#key-remove').isVisible(), true);
  assert.ok(!(await page.content()).includes(GOOD), 'the key is nowhere in the page');
  await page.locator('#key-state').scrollIntoViewIfNeeded();
  if (shots) await page.screenshot({ path: `${shots}/key-settings.png` });
  for (const width of [320, 430]) { await page.setViewportSize({ width, height: 844 }); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Settings fits at ${width} px`); }
  await page.setViewportSize({ width: 390, height: 844 });
  // Chat now answers on the user's key.
  await page.locator('[data-back]:visible').first().click();
  await page.locator('[data-tab="chat"]').click();
  await page.locator('#chat-input').fill('Hello again');
  await page.locator('#chat-input').press('Enter');
  await page.waitForFunction(() => [...document.querySelectorAll('.msg.echo')].some((m) => /Answered with your own key/.test(m.textContent)));
  assert.deepEqual(errors, []);
  console.log('PASS chromium: used-up limit offers "Add my Gemini key"; a wrong key is refused, the right one is saved as ••••WXYZ (never in the page) and Chat answers with it.');
} finally { await browser.close(); server.closeAllConnections(); server.close(); }
