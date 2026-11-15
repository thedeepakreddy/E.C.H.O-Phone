/** Real browser: a chat reply appears while it is still being written, then settles into the saved message. */
import assert from 'node:assert/strict';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { createRelay } from '../server.js';

const pw = process.env.ECHO_BROWSER_DEPENDENCIES ? await import(pathToFileURL(join(process.env.ECHO_BROWSER_DEPENDENCIES, 'playwright/index.mjs')).href) : await import('playwright');
const shot = process.env.ECHO_STREAMING_SHOT;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let release;
const held = new Promise((r) => { release = r; });
const rounds = [
  { calls: [['get_weather', { place: 'Paris' }]] },
  { text: '**Paris** is 14° and rainy. Take a coat, and the *Marais* is good for dinner.', hold: true },
];
const data = (r) => ({ candidates: [{ content: { role: 'model', parts: [...(r.text ? [{ text: r.text }] : []), ...(r.calls ?? []).map(([name, args]) => ({ functionCall: { name, args } }))] } }] });
const gemini = {
  model: 'fixture', embed: async () => Array(512).fill(0),
  generate: async () => data(rounds.shift()),
  generateStream: async (body, { onText }) => {
    const r = rounds.shift();
    const words = (r.text ?? '').split(/(?<= )/);
    for (const [i, word] of words.entries()) { if (r.hold && i === 6) await held; onText(word); await wait(15); }
    return data(r);
  },
};
const relay = createRelay({ secret: 'private-streaming-fixture-'.repeat(4), gemini, fetchJson: async (url) => /geocoding/.test(url) ? { results: [{ name: 'Paris', country: 'France', latitude: 48.85, longitude: 2.35 }] } : {} });
const server = http.createServer(relay.handler);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await pw.chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block', deviceScaleFactor: shot ? 2 : 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base);
  await page.locator('#get-started').click();
  await page.locator('[data-tab="chat"]').click();
  await page.locator('#chat-input').fill('Weather in Paris?');
  await page.locator('#chat-input').press('Enter');
  // Half the answer is on screen, formatted, while the model is still writing.
  const live = page.locator('.msg.live .echo-markdown');
  await live.waitFor();
  await page.waitForFunction(() => /rainy/.test(document.querySelector('.msg.live')?.textContent ?? ''));
  assert.equal(await page.locator('.msg.live strong').textContent(), 'Paris');
  assert.doesNotMatch(await live.textContent(), /dinner/, 'the rest has not arrived yet');
  assert.equal(await page.locator('#typing').isVisible(), false, 'the dots give way to the words');
  if (shot) await page.screenshot({ path: shot });
  release();
  await page.waitForFunction(() => !document.querySelector('.msg.live') && /dinner/.test(document.querySelector('.msg.echo:not(.live)')?.textContent ?? ''));
  assert.equal(await page.locator('.msg.echo').count(), 1, 'one saved message replaces the live one');
  assert.equal(await page.locator('#typing').count(), 0);
  await page.reload();
  await page.locator('[data-tab="chat"]').click();
  await page.waitForFunction(() => /dinner/.test(document.querySelector('.msg.echo')?.textContent ?? ''));
  assert.deepEqual(errors, []);
  console.log('PASS chromium: reply streams into one formatted live bubble during a tool round and settles into the saved message; survives reload.');
} finally { await browser.close(); server.closeAllConnections(); server.close(); }
