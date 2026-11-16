/** Real browser: Echo's thinking orbs draw, animate, pause when hidden, and appear where Echo is working. */
import assert from 'node:assert/strict';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { createRelay } from '../server.js';

const pw = process.env.ECHO_BROWSER_DEPENDENCIES ? await import(pathToFileURL(join(process.env.ECHO_BROWSER_DEPENDENCIES, 'playwright/index.mjs')).href) : await import('playwright');
const shots = process.env.ECHO_ORBS_SHOTS;
let release;
const held = new Promise((r) => { release = r; });
const rounds = [{ calls: [['web_search', { query: 'Paris weather' }]] }, { text: 'Paris is **14°** and rainy today, so take a coat.', hold: true }];
const data = (r) => ({ candidates: [{ content: { role: 'model', parts: [...(r.text ? [{ text: r.text }] : []), ...(r.calls ?? []).map(([name, args]) => ({ functionCall: { name, args } }))] } }] });
const gemini = {
  model: 'fixture', embed: async () => Array(512).fill(0),
  generate: async () => data(rounds.shift() ?? { text: 'ok' }),
  generateStream: async (body, { onText }) => {
    const r = rounds.shift();
    if (r.calls) { await new Promise((ok) => setTimeout(ok, 600)); return data(r); }
    const words = r.text.split(/(?<= )/);
    for (const [i, w] of words.entries()) { if (r.hold && i === 5) await held; onText(w); }
    return data(r);
  },
};
// Echo's own web search reaches no real site in this test: a Bing page that takes a moment.
const relay = createRelay({ secret: 'private-orbs-fixture-'.repeat(4), gemini, fetchJson: async () => ({}), searchFetch: async () => { await new Promise((ok) => setTimeout(ok, 1500)); return { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from('<li class="b_algo"><div class="b_algoheader"><a href="https://weather.example/paris"><h2>Paris weather</h2></a></div></li>') }; } });
const server = http.createServer(relay.handler);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const inked = (page, selector) => page.evaluate((sel) => [...document.querySelectorAll(sel)].map((o) => {
  const c = o.querySelector('canvas'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let lit = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) lit++;
  return { state: o.getAttribute('state'), w: c.width, css: c.style.width, lit, label: o.getAttribute('aria-label') };
}), selector);
const browser = await pw.chromium.launch({ headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block', deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base);
  // The engine and all nine states are available.
  assert.deepEqual((await page.evaluate(() => window.EchoOrbs.states)).sort(), ['breathing', 'composing', 'connecting', 'listening', 'searching', 'shaping', 'solving', 'weaving', 'working']);
  // A gallery of every state at both sizes, drawn by the element itself.
  await page.evaluate(() => { const g = document.createElement('div'); g.id = 'gallery'; g.style.cssText = 'position:fixed;inset:0;z-index:99;background:#05090c;display:grid;grid-template-columns:repeat(3,1fr);gap:18px;padding:40px 16px;color:#cfe;font:12px system-ui;align-content:start';
    for (const s of window.EchoOrbs.states) { const c = document.createElement('div'); c.style.cssText = 'display:grid;justify-items:center;gap:6px'; c.append(window.EchoOrbs.make(s, 64), window.EchoOrbs.make(s, 20), s); g.append(c); } document.body.append(g); });
  await page.waitForTimeout(400);
  const all = await inked(page, '#gallery echo-orb');
  assert.equal(all.length, 18);
  for (const o of all) { assert.ok(o.lit > 20, `${o.state} draws (${o.lit} lit pixels)`); assert.equal(o.w, o.css === '64px' ? 128 : 40, 'drawn at 2x for a sharp phone screen'); }
  if (shots) await page.screenshot({ path: `${shots}/orbs-gallery.png` });
  // Animated: two frames differ.
  const frameA = await page.evaluate(() => document.querySelector('#gallery canvas').toDataURL());
  await page.waitForTimeout(250);
  assert.notEqual(await page.evaluate(() => document.querySelector('#gallery canvas').toDataURL()), frameA, 'orbs animate');
  // Offscreen and hidden orbs stop drawing.
  await page.evaluate(() => { document.getElementById('gallery').style.top = '3000px'; });
  await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('#gallery echo-orb')].filter((o) => o.raf).length), 0, 'offscreen orbs pause');
  await page.evaluate(() => document.getElementById('gallery').remove());

  // Chat: Echo thinking, then searching the web, then writing.
  await page.locator('#get-started').click();
  await page.locator('[data-tab="chat"]').click();
  await page.waitForFunction(() => document.querySelector('#presence')?.textContent === 'on your phone');
  await page.locator('#chat-input').fill('Weather in Paris?');
  await page.locator('#chat-input').press('Enter');
  await page.waitForFunction(() => document.querySelector('#typing echo-orb')?.getAttribute('state') === 'breathing');
  await page.waitForFunction(() => document.querySelector('.msg.live echo-orb')?.getAttribute('state') === 'searching');
  assert.match(await page.locator('.msg.live').textContent(), /Searching the live web for “Paris weather”/);
  assert.equal(await page.locator('#typing').isVisible(), false, 'one orb at a time');
  if (shots) await page.screenshot({ path: `${shots}/orbs-chat-searching.png` });
  await page.waitForFunction(() => document.querySelector('.msg.live echo-orb')?.getAttribute('state') === 'composing');
  if (shots) await page.screenshot({ path: `${shots}/orbs-chat-composing.png` });
  release();
  await page.waitForFunction(() => !document.querySelector('.msg.live') && !document.querySelector('#typing'));
  assert.equal(await page.locator('.msg.echo echo-orb').count(), 0, 'a finished answer has no orb');

  // Voice: each phase of a spoken turn has its orb.
  await page.context().grantPermissions(['microphone']);
  await page.locator('#chat-talk').click();
  await page.waitForFunction(() => document.querySelector('#voice-chat-status echo-orb')?.getAttribute('state') === 'listening');
  assert.match(await page.locator('#voice-chat-status').textContent(), /Listening/);
  if (shots) await page.screenshot({ path: `${shots}/orbs-voice.png` });
  await page.locator('#voice-pause').click();
  await page.waitForFunction(() => document.querySelector('#voice-chat').hidden);
  // Other placements exist in the page shell.
  assert.equal(await page.locator('#br-orb').getAttribute('state'), 'working');
  assert.equal(await page.locator('#novid echo-orb').getAttribute('state'), 'connecting');
  assert.deepEqual(errors, []);
  console.log('PASS chromium: all 9 states at both sizes draw sharply and animate; chat shows breathing → searching → composing orbs and none on the finished answer; Browser and Mac screen orbs are in place.');
} finally { await browser.close(); server.closeAllConnections(); server.close(); }
