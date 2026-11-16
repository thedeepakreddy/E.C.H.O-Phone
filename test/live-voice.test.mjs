/** Live voice: the phone's session with Gemini Live, the relay's token and tools, and agents on their own model. */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import "../public/live-voice.js";
import { deriveKeys } from "../lib/secure.js";
import { createStore } from "../lib/store.js";
import { createGemini, GeminiError } from "../lib/gemini.js";
import { createCloud, CloudError } from "../lib/cloud.js";
import { createRelay } from "../server.js";

const { Session, Downsampler, toBase64, fromBase64, ENDPOINT } = globalThis.EchoLive;
const SECRET = "s".repeat(48);
const NOW = Date.parse("2026-10-06T10:00:00Z");
const tick = () => new Promise((r) => setTimeout(r, 0));

test("microphone audio becomes 16 kHz 16-bit PCM whatever the frame boundaries", () => {
  const down = new Downsampler(48000);
  assert.equal(down.rate, 16000);
  const a = down.push(new Float32Array(4096).fill(.5)), b = down.push(new Float32Array(4096).fill(-1));
  assert.equal(a.length + b.length, Math.floor(8192 / 3), "no samples are lost between frames");
  assert.equal(a[0], Math.trunc(.5 * 0x7fff));
  assert.equal(b.at(-1), -0x8000);
  assert.equal(new Downsampler(8000).rate, 8000, "a slower microphone is sent at its own rate");
  assert.deepEqual([...fromBase64(toBase64(new Uint8Array([0, 255, 16, 128])))], [0, 255, 16, 128]);
});

/** A stand-in for Google's socket: records what the phone sends, lets the test speak as the server. */
function fakeSocket() {
  const sockets = [];
  const make = (url) => {
    const ws = { url, sent: [], readyState: 0,
      send(text) { ws.sent.push(JSON.parse(text)); },
      close() { if (ws.readyState === 3) return; ws.readyState = 3; ws.onclose?.(); },
      open() { ws.readyState = 1; ws.onopen(); },
      // Google sends JSON in binary frames.
      say(message) { return ws.onmessage({ data: new TextEncoder().encode(JSON.stringify(message)).buffer }); } };
    sockets.push(ws);
    return ws;
  };
  return { make, sockets };
}
function harness(overrides = {}) {
  const net = fakeSocket(), played = [], states = [], turns = [], errors = [], tools = [];
  const out = { playing: false, onIdle: null, play(bytes, rate) { played.push([bytes.length, rate]); out.playing = true; }, flush() { out.playing = false; played.push("flush"); }, close() { out.closed = true; } };
  const mic = { rate: 48000, closed: false, close() { mic.closed = true; } };
  let frame;
  const session = new Session({
    acquire: async (onFrame) => { frame = onFrame; return mic; },
    begin: async () => ({ token: "auth_tokens/abc", model: "gemini-3.8-live" }),
    tool: async (call) => { tools.push(call); return { status: "captured" }; },
    onTurn: (turn) => turns.push(turn), onState: (s) => states.push(s), onError: (e) => errors.push(e),
    socket: net.make, output: () => out, now: () => NOW, ...overrides,
  });
  const ready = async () => { const p = session.start(); await tick(); const ws = net.sockets.at(-1); ws.open(); await ws.say({ setupComplete: {} }); await p; return ws; };
  return { session, net, out, mic, played, states, turns, errors, tools, ready, speak: (n = 4096) => frame(new Float32Array(n).fill(.25)) };
}
const audio = (bytes = 4) => ({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: toBase64(new Uint8Array(bytes)) } }] } } });

test("a live session: token in the URL, sealed setup, speech both ways, one saved turn", async () => {
  const h = harness();
  const ws = await h.ready();
  assert.equal(ws.url, `${ENDPOINT}?access_token=auth_tokens%2Fabc`);
  assert.deepEqual(ws.sent[0], { setup: { model: "models/gemini-3.8-live" } }, "instructions and tools come from the token, not the phone");
  assert.deepEqual(h.states, ["starting", "listening"]);
  h.speak();
  assert.equal(ws.sent[1].realtimeInput.audio.mimeType, "audio/pcm;rate=16000");
  assert.equal(fromBase64(ws.sent[1].realtimeInput.audio.data).length, Math.floor(4096 / 3) * 2);
  await ws.say({ serverContent: { inputTranscription: { text: "What's the " } } });
  await ws.say({ serverContent: { inputTranscription: { text: "weather?" } } });
  await ws.say({ ...audio(), serverContent: { ...audio().serverContent, outputTranscription: { text: "Fourteen degrees " } } });
  assert.equal(h.session.state, "speaking");
  await ws.say({ serverContent: { outputTranscription: { text: "and rainy." }, turnComplete: true } });
  await tick();
  assert.deepEqual(h.turns, [{ user: "What's the weather?", echo: "Fourteen degrees and rainy.", interrupted: false }]);
  assert.equal(h.session.state, "speaking", "still speaking until the last audio has played");
  h.out.playing = false; h.out.onIdle();
  assert.equal(h.session.state, "listening");
  h.session.stop();
  assert.ok(h.mic.closed && h.out.closed && ws.readyState === 3);
  assert.equal(h.session.state, "off");
});

test("talking over Echo stops its voice at once; tools run through the relay", async () => {
  const h = harness();
  const ws = await h.ready();
  await ws.say(audio());
  await ws.say({ serverContent: { outputTranscription: { text: "Let me tell you about" } } });
  await ws.say({ serverContent: { interrupted: true } });
  assert.equal(h.played.at(-1), "flush");
  assert.equal(h.session.state, "listening");
  await ws.say({ serverContent: { turnComplete: true } });
  await tick();
  assert.deepEqual(h.turns[0], { user: "", echo: "Let me tell you about", interrupted: true });
  await ws.say({ toolCall: { functionCalls: [{ id: "f1", name: "remind_me", args: { text: "Call Mum", when: "2026-10-08T09:00" } }] } });
  await tick();
  assert.deepEqual(h.tools, [{ id: "f1", name: "remind_me", args: { text: "Call Mum", when: "2026-10-08T09:00" } }]);
  assert.deepEqual(ws.sent.at(-1), { toolResponse: { functionResponses: [{ id: "f1", name: "remind_me", response: { status: "captured" } }] } });
  h.session.stop();
});

test("a line that never opens reports it; Google's goodbye is followed by a fresh session", async () => {
  const refused = harness();
  const p = refused.session.start(); await tick();
  refused.net.sockets[0].close(); await p;
  assert.equal(refused.errors.length, 1);
  assert.equal(refused.errors[0].beforeReady, true, "the app falls back to record-and-send voice");
  assert.equal(refused.errors[0].stage, "connect");

  // Google's close frame says why; the phone shows it instead of a generic message.
  const told = harness();
  const pending = told.session.start(); await tick();
  told.net.sockets[0].readyState = 3; told.net.sockets[0].onclose({ code: 1007, reason: "Request contains an invalid argument." }); await pending;
  assert.match(told.errors[0].message, /Google closed the voice line: Request contains an invalid argument\./);

  const noToken = harness({ begin: async () => { throw Object.assign(new Error("HTTP 502"), { data: { message: "Google didn't open a voice session: Unknown name" } }); } });
  await noToken.session.start();
  assert.equal(noToken.errors[0].stage, "token");
  assert.ok(noToken.mic.closed, "a refused session releases the microphone");
  assert.equal(noToken.net.sockets.length, 0);
  assert.ok(refused.mic.closed, "the microphone is released");
  assert.equal(refused.session.state, "off");

  const denied = harness({ acquire: async () => { throw Object.assign(new Error("denied"), { name: "NotAllowedError" }); } });
  await denied.session.start();
  assert.equal(denied.errors[0].name, "NotAllowedError");
  assert.equal(denied.errors[0].stage, "microphone");

  // The phone only lets a tap open the microphone: it is asked for before anything is awaited.
  let askedInTap = false;
  const tapped = harness({ acquire: async () => { askedInTap = true; return { rate: 48000, close() {} }; } });
  const starting = tapped.session.start();
  assert.equal(askedInTap, true);
  tapped.session.stop(); await starting;

  const h = harness();
  const first = await h.ready();
  await first.say({ goAway: { timeLeft: "5s" } });
  await tick();
  assert.equal(first.readyState, 3);
  const second = h.net.sockets.at(-1);
  assert.notEqual(second, first);
  second.open(); await second.say({ setupComplete: {} });
  h.speak();
  assert.ok(second.sent.at(-1).realtimeInput, "the conversation carries on over the new session");
  assert.deepEqual(h.errors, []);
  h.session.stop();
});

// ---- the relay's side ----
const text = (t) => ({ candidates: [{ content: { role: "model", parts: [{ text: t }] } }] });
function liveGemini(extra = {}) {
  const setups = [];
  return { setups, model: "gemini-3.8-flash", liveModel: "gemini-3.8-live", liveVoice: "Charon", generate: async () => text("ok"),
    liveToken: async (setup) => { setups.push(setup); return "auth_tokens/t1"; }, ...extra };
}
const store = () => createStore({ key: deriveKeys(SECRET).store, now: () => NOW });

test("the token request is the documented one and seals the whole session", async () => {
  const requests = [];
  const gemini = createGemini({ apiKey: "k", now: () => NOW, fetchImpl: async (url, init) => { requests.push({ url, headers: init.headers, body: JSON.parse(init.body) }); return Response.json({ name: "auth_tokens/xyz" }); } });
  assert.equal(await gemini.liveToken({ model: "models/gemini-3.8-live" }), "auth_tokens/xyz");
  assert.equal(requests[0].url, "https://generativelanguage.googleapis.com/v1beta/auth_tokens");
  assert.equal(requests[0].headers["x-goog-api-key"], "k");
  assert.deepEqual(requests[0].body, { uses: 1, expireTime: "2026-10-06T10:30:00.000Z", newSessionExpireTime: "2026-10-06T10:01:30.000Z", bidiGenerateContentSetup: { model: "models/gemini-3.8-live" } });
  const broken = createGemini({ apiKey: "k", fetchImpl: async () => Response.json({ error: { message: "API key not valid" } }, { status: 400 }) });
  await assert.rejects(broken.liveToken({}), (e) => e instanceof GeminiError && e.kind === "auth");
});

test("a voice session carries Echo's instructions, the thread so far, and only voice-safe tools", async () => {
  const gemini = liveGemini();
  const cloud = createCloud({ gemini, store: store(), now: () => NOW, tools: {}, limits: { voiceSessions: 2 } });
  const memory = { upcoming: [], search: async () => [] };
  const r = await cloud.liveStart({ history: [{ role: "user", text: "Plan my Paris trip" }, { role: "echo", text: "Spring is best." }], context: { tz: "Europe/Paris" }, memory });
  assert.deepEqual(r, { token: "auth_tokens/t1", model: "gemini-3.8-live" });
  const setup = gemini.setups[0];
  assert.equal(setup.model, "models/gemini-3.8-live");
  assert.deepEqual(setup.generationConfig, { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Charon" } } } });
  assert.deepEqual([setup.inputAudioTranscription, setup.outputAudioTranscription], [{}, {}]);
  const instructions = setup.systemInstruction.parts[0].text;
  assert.match(instructions, /You are Echo/);
  assert.match(instructions, /speaking aloud/);
  assert.match(instructions, /User: Plan my Paris trip\nEcho: Spring is best\./);
  const names = setup.tools[0].functionDeclarations.map((d) => d.name);
  assert.ok(names.includes("remind_me") && names.includes("recall_memory"));
  assert.ok(!names.some((n) => ["read_web_page", "search_research", "image_search", "web_search", "echo_expression", "organize_conversation"].includes(n)));
  assert.deepEqual(setup.tools[1], { googleSearch: {} });
  await cloud.liveStart({ history: [], context: {} });
  await assert.rejects(cloud.liveStart({ history: [], context: {} }), (e) => e instanceof CloudError && e.kind === "cap");
  const refusing = createCloud({ gemini: liveGemini({ liveToken: async () => { throw new GeminiError("other", "Invalid JSON payload received. Unknown name \"x\"."); } }), store: store(), now: () => NOW, tools: {} });
  await assert.rejects(refusing.liveStart({ history: [] }), (e) => e.kind === "failed" && /Google didn't open a voice session: Invalid JSON payload received/.test(e.message));
  assert.equal(await store().count("v:2026-10-06"), 0);
  const off = createCloud({ gemini: liveGemini({ liveModel: null }), store: store(), now: () => NOW, tools: {} });
  await assert.rejects(off.liveStart({ history: [] }), (e) => e.kind === "setup");
});

test("a voice tool runs with chat's checks; anything else is refused", async () => {
  const cloud = createCloud({ gemini: liveGemini(), store: store(), now: () => NOW, tools: {} });
  const saved = [];
  const memory = { upcoming: [], search: async () => [], capture: async (raw) => { saved.push(raw); return { id: "t1", text: raw.text, when: raw.when, repeat: null }; } };
  const ok = await cloud.liveTool({ name: "remind_me", args: { text: "Call Mum", when: "2026-10-08T09:00" }, context: { tz: "UTC" }, memory });
  assert.equal(ok.response.status, "captured");
  assert.deepEqual(ok.effects.captures.map((c) => c.text), ["Call Mum"]);
  const bad = await cloud.liveTool({ name: "remind_me", args: { text: "x", when: "tomorrow" }, context: {}, memory });
  assert.match(bad.response.error, /local time/);
  const refused = await cloud.liveTool({ name: "read_web_page", args: { url: "https://example.org" }, context: {}, memory });
  assert.match(refused.response.error, /voice/);
  assert.equal(saved.length, 1);
});

async function relay(gemini) {
  const r = createRelay({ secret: SECRET, gemini });
  const server = http.createServer(r.handler);
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${server.address().port}`;
  const { cloudPass } = await (await fetch(`${base}/phone/session`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json();
  const headers = { "x-echo-pass": cloudPass, "content-type": "application/json" };
  const post = async (path, body) => { const res = await fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) }); return { status: res.status, body: await res.json().catch(() => null), headers: res.headers }; };
  return { base, headers, post, close: () => { server.closeAllConnections(); server.close(); } };
}

test("the relay hands out a token, runs a spoken tool, and saves the exchange with its receipt", async () => {
  const gemini = liveGemini();
  const r = await relay(gemini);
  try {
    const status = await (await fetch(`${r.base}/cloud/status`, { headers: r.headers })).json();
    assert.equal(status.live, true);
    const page = await fetch(`${r.base}/`);
    assert.match(page.headers.get("content-security-policy"), /connect-src 'self' wss:\/\/generativelanguage\.googleapis\.com;/);
    const thread = (await r.post("/cloud/conversations", { action: "create" })).body.thread;
    const start = await r.post("/cloud/live/start", { threadId: thread.id, context: { tz: "UTC" } });
    assert.deepEqual(start.body, { token: "auth_tokens/t1", model: "gemini-3.8-live" });
    assert.ok(!JSON.stringify(start.body).includes("You are Echo"), "instructions never reach the phone");
    // The relay runs on the real clock: a reminder must be in the future.
    const when = `${new Date(Date.now() + 3 * 86400_000).toISOString().slice(0, 10)}T09:00`;
    const tool = await r.post("/cloud/live/tool", { threadId: thread.id, name: "remind_me", callId: "f1", args: { text: "Call Mum", when }, context: { tz: "UTC" } });
    assert.equal(tool.body.response.status, "captured");
    const turn = await r.post("/cloud/live/turn", { threadId: thread.id, requestId: "voice-turn-0001", user: "Remind me to call Mum Thursday at nine", echo: "Done, Thursday at nine." });
    assert.equal(turn.body.reply, "Done, Thursday at nine.");
    assert.deepEqual(turn.body.captures.map((c) => c.text), ["Call Mum"]);
    const again = await r.post("/cloud/live/turn", { threadId: thread.id, requestId: "voice-turn-0001", user: "x", echo: "y" });
    assert.equal(again.body.reply, "Done, Thursday at nine.", "the same turn is saved once");
    const next = await r.post("/cloud/live/turn", { threadId: thread.id, requestId: "voice-turn-0002", user: "Thanks", echo: "Any time." });
    assert.deepEqual(next.body.captures, [], "a tool's chips belong to the turn that used it");
    assert.equal((await r.post("/cloud/live/turn", { threadId: thread.id, requestId: "voice-turn-0003", user: "Hello", echo: " " })).status, 400);
    // The next session hears what was said.
    await r.post("/cloud/live/start", { threadId: thread.id, context: { tz: "UTC" } });
    assert.match(gemini.setups.at(-1).systemInstruction.parts[0].text, /User: Remind me to call Mum Thursday at nine\nEcho: Done, Thursday at nine\./);
  } finally { r.close(); }
});

test("without a live model the relay says so and the phone keeps record-and-send voice", async () => {
  const r = await relay({ model: "test-model", generate: async () => text("ok") });
  try {
    assert.equal((await (await fetch(`${r.base}/cloud/status`, { headers: r.headers })).json()).live, false);
    const start = await r.post("/cloud/live/start", { context: {} });
    assert.equal(start.status, 503);
    assert.equal(start.body.error, "setup");
  } finally { r.close(); }
});

// ---- agents on their own model ----
const PASSING = "Answer (VERIFIED, https://example.org/source). Task B depends on task A; done when tests pass.\n\nQuality check: fixture.\nVerdict: PASS";
const bot = (id = "research") => ({ id, name: id, role: "Fixture", mode: "research", runId: `run-${id}` });
function modelGemini(script) {
  const used = [];
  return { used, model: "gemini-3.8-flash", agentModel: "gemini-4-hydrogen", fallbackModels: [],
    generate: async (body, { modelId }) => { used.push(modelId); const next = script[modelId]?.shift?.() ?? text(PASSING); if (next instanceof Error) throw next; return next; } };
}

test("agents reason on the stronger free model; chat stays on the quick one", async () => {
  const gemini = modelGemini({});
  const cloud = createCloud({ gemini, store: store(), now: () => NOW, tools: {} });
  await cloud.chat({ text: "Hello" });
  const r = await cloud.chat({ text: "Research this", bot: bot() });
  assert.deepEqual(gemini.used, ["gemini-3.8-flash", "gemini-4-hydrogen"]);
  assert.deepEqual(r.modelInfo, { requested: "gemini-4-hydrogen", used: "gemini-4-hydrogen", fallback: false });
});

test("when the agents' model is used up, the task runs on Phone mode's model and later tasks start there", async () => {
  const gemini = modelGemini({ "gemini-4-hydrogen": [new GeminiError("day", "quota", { limit: 50 })] });
  const cloud = createCloud({ gemini, store: store(), now: () => NOW, tools: {} });
  const r = await cloud.chat({ text: "Research this", bot: bot() });
  assert.deepEqual(gemini.used, ["gemini-4-hydrogen", "gemini-3.8-flash"]);
  assert.deepEqual(r.modelInfo, { requested: "gemini-4-hydrogen", used: "gemini-3.8-flash", fallback: true });
  assert.equal(cloud.agentModel(), "gemini-3.8-flash", "it rests until Google's day turns over");
  await cloud.chat({ text: "Another task", bot: bot("plan") });
  assert.equal(gemini.used.at(-1), "gemini-3.8-flash");
  assert.equal((await cloud.usage()).limit, null, "the agents' quota is not mistaken for chat's");
});

test("a task already under way is never restarted on another model", async () => {
  const call = { candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "get_today", args: {} } }] } }] };
  const gemini = modelGemini({ "gemini-4-hydrogen": [call, new GeminiError("day", "quota")] });
  const cloud = createCloud({ gemini, store: store(), now: () => NOW, tools: {} });
  await assert.rejects(cloud.chat({ text: "Research this", bot: bot() }), (e) => e instanceof CloudError && e.kind === "quota");
  assert.deepEqual(gemini.used, ["gemini-4-hydrogen", "gemini-4-hydrogen"]);
});
