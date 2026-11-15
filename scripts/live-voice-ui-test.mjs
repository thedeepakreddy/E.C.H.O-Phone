/** Real browser: Listen opens a live voice session, Echo answers aloud, and the exchange is saved to Chat. Google's socket is a local stand-in. */
import assert from 'node:assert/strict';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { createRelay } from '../server.js';

const pw = process.env.ECHO_BROWSER_DEPENDENCIES ? await import(pathToFileURL(join(process.env.ECHO_BROWSER_DEPENDENCIES, 'playwright/index.mjs')).href) : await import('playwright');
const shot = process.env.ECHO_LIVE_VOICE_SHOT;
const setups = [];
const gemini = {
  model: 'fixture', liveModel: 'gemini-3.8-live', liveVoice: 'Charon', embed: async () => Array(512).fill(0),
  generate: async () => ({ candidates: [{ content: { role: 'model', parts: [{ text: 'Typed answer.' }] } }] }),
  liveToken: async (setup) => { setups.push(setup); return 'auth_tokens/fixture'; },
};
const relay = createRelay({ secret: 'private-live-voice-fixture-'.repeat(4), gemini, fetchJson: async () => ({}) });
const server = http.createServer(relay.handler);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

/** Runs in the page before the app: Gemini Live as the phone sees it. It answers once it has heard about a second of audio. */
function standIn() {
  const when = `${new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10)}T09:00`;
  const silence = btoa(String.fromCharCode(...new Uint8Array(4800)));
  window.__live = { urls: [], frames: 0, setup: null, toolResponse: null, closed: 0 };
  window.WebSocket = class {
    constructor(url) { this.url = url; this.readyState = 0; window.__live.urls.push(url); setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 10); }
    say(message) { if (this.readyState === 1) this.onmessage?.({ data: new TextEncoder().encode(JSON.stringify(message)).buffer }); }
    send(text) {
      const m = JSON.parse(text);
      if (m.setup) { window.__live.setup = m.setup; return void setTimeout(() => this.say({ setupComplete: {} }), 10); }
      if (m.realtimeInput?.audio && ++window.__live.frames === 12) {
        this.say({ serverContent: { inputTranscription: { text: 'Remind me to call Mum.' } } });
        this.say({ toolCall: { functionCalls: [{ id: 'f1', name: 'remind_me', args: { text: 'Call Mum', when } }] } });
      }
      if (m.toolResponse) {
        window.__live.toolResponse = m.toolResponse;
        this.say({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: silence } }] }, outputTranscription: { text: 'Done. I will ' } } });
        this.say({ serverContent: { outputTranscription: { text: 'remind you to call Mum.' } } });
        setTimeout(() => this.say({ serverContent: { turnComplete: true } }), 400);
      }
    }
    close() { if (this.readyState === 3) return; this.readyState = 3; window.__live.closed++; this.onclose?.(); }
  };
}

const browser = await pw.chromium.launch({ headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block', permissions: ['microphone'], deviceScaleFactor: shot ? 2 : 1 });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(standIn);
  await page.goto(base);
  await page.locator('#get-started').click();
  await page.locator('[data-tab="chat"]').click();
  await page.waitForFunction(() => document.querySelector('#presence')?.textContent === 'on your phone');
  await page.locator('#chat-talk').click();
  await page.waitForFunction(() => /just talk|interrupt|on it/.test(document.querySelector('#voice-chat-status')?.textContent ?? ''));
  const live = await page.evaluate(() => window.__live);
  assert.match(live.urls[0], /^wss:\/\/generativelanguage\.googleapis\.com\/ws\/google\.ai\.generativelanguage\.v1beta\.GenerativeService\.BidiGenerateContentConstrained\?access_token=auth_tokens%2Ffixture$/);
  assert.deepEqual(live.setup, { model: 'models/gemini-3.8-live' });
  assert.match(setups[0].systemInstruction.parts[0].text, /speaking aloud/);
  // Echo hears the fake microphone, sets the reminder through the relay, and answers aloud.
  await page.waitForFunction(() => /talk to interrupt/.test(document.querySelector('#voice-chat-status')?.textContent ?? ''));
  if (shot) await page.screenshot({ path: shot });
  await page.waitForFunction(() => /remind you to call Mum/.test(document.querySelector('.msg.echo')?.textContent ?? ''));
  assert.equal(await page.locator('.msg.me.voice').textContent().then((t) => t.includes('Remind me to call Mum.')), true, 'what was said is in Chat');
  assert.equal(await page.locator('.msg.echo .saved-chip').textContent(), '✓ Today: Call Mum', 'the spoken reminder is really in Today');
  assert.equal((await page.evaluate(() => window.__live.toolResponse)).functionResponses[0].response.status, 'captured');
  await page.waitForFunction(() => /just talk/.test(document.querySelector('#voice-chat-status')?.textContent ?? ''));
  // Stop: the line and the microphone close, and typing still works.
  await page.locator('#chat-talk').click();
  await page.waitForFunction(() => document.querySelector('#voice-chat')?.hidden === true);
  assert.equal(await page.evaluate(() => window.__live.closed), 1);
  const frames = await page.evaluate(() => window.__live.frames);
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => window.__live.frames), frames, 'no audio leaves the phone after Stop');
  // The exchange is on the server, not only on this phone.
  await page.reload();
  await page.locator('[data-tab="chat"]').click();
  await page.waitForFunction(() => /remind you to call Mum/.test(document.querySelector('.msg.echo')?.textContent ?? ''));
  assert.deepEqual(errors, []);
  console.log('PASS chromium: Listen opens a live session with a sealed token, a spoken reminder is captured through the relay, Echo answers aloud, the exchange is saved to Chat, and Stop closes the line.');
} finally { await browser.close(); server.closeAllConnections(); server.close(); }
