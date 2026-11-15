/** Replies that arrive as they are written, with fewer model rounds and store trips. */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { deriveKeys } from "../lib/secure.js";
import { createStore } from "../lib/store.js";
import { createGemini } from "../lib/gemini.js";
import { createCloud, expressionFor } from "../lib/cloud.js";
import { createRelay } from "../server.js";

const SECRET = "s".repeat(48);
const NOW = Date.parse("2026-10-06T10:00:00Z");
const sse = (chunks) => new Response(new ReadableStream({ start(c) { for (const chunk of chunks) c.enqueue(new TextEncoder().encode(chunk)); c.close(); } }), { status: 200, headers: { "content-type": "text/event-stream" } });
const event = (parts, extra = {}) => `data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts }, ...extra }] })}\r\n\r\n`;

test("a streamed Gemini answer is delivered piece by piece and joined into one response", async () => {
  const requests = [];
  const whole = event([{ text: "Hel" }]) + event([{ thought: true, text: "hidden" }]) + event([{ text: "lo" }, { functionCall: { name: "get_weather", args: {} }, thoughtSignature: "sig" }], { finishReason: "STOP" });
  // Split mid-event: network chunks never line up with events.
  const gemini = createGemini({ apiKey: "k", fetchImpl: async (url, init) => { requests.push({ url, body: JSON.parse(init.body) }); return sse([whole.slice(0, 31), whole.slice(31)]); } });
  const pieces = [];
  const data = await gemini.generateStream({ contents: [] }, { onText: (t) => pieces.push(t) });
  assert.match(requests[0].url, /gemini-3\.8-flash:streamGenerateContent\?alt=sse$/);
  assert.equal(requests[0].body.generationConfig.thinkingConfig.thinkingLevel, "low");
  assert.deepEqual(pieces, ["Hel", "lo"], "thoughts are never shown");
  const parts = data.candidates[0].content.parts;
  assert.deepEqual(parts.map((p) => p.text ?? p.functionCall.name), ["Hel", "hidden", "lo", "get_weather"]);
  assert.equal(parts[3].thoughtSignature, "sig", "the call keeps its signature for the next round");
  assert.equal(data.candidates[0].finishReason, "STOP");
});

test("a streamed quota failure is classified like any other", async () => {
  const gemini = createGemini({ apiKey: "k", fetchImpl: async () => new Response(JSON.stringify({ error: { message: "quota", details: [{ violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier", quotaValue: "1000" }] }] } }), { status: 429 }) });
  await assert.rejects(gemini.generateStream({ contents: [] }), (e) => e.kind === "day" && e.limit === 1000);
});

/** A scripted streaming Gemini: each round is { text?, calls? }. */
function scripted(rounds, seen = []) {
  const next = (body) => { seen.push(structuredClone(body)); const r = rounds.shift(); if (r instanceof Error) throw r; return r; };
  const data = (r) => ({ candidates: [{ content: { role: "model", parts: [...(r.text ? [{ text: r.text }] : []), ...(r.calls ?? []).map(([name, args]) => ({ functionCall: { name, args } }))] } }] });
  return { model: "test-model",
    generate: async (body, { onRequest } = {}) => { onRequest?.(); return data(next(body)); },
    generateStream: async (body, { onRequest, onText } = {}) => { onRequest?.(); const r = next(body); if (r.text) for (const word of r.text.split(/(?<= )/)) onText(word); return data(r); } };
}
const cloudWith = (gemini, tools = {}) => createCloud({ gemini, store: createStore({ key: deriveKeys(SECRET).store, now: () => NOW }), now: () => NOW, tools });

test("chat streams its answer, names the lookup, and withdraws words written before it", async () => {
  const events = [];
  const cloud = cloudWith(scripted([{ text: "Let me check.", calls: [["get_weather", { place: "Paris" }]] }, { text: "It is 14° in Paris." }]),
    { geocode: async () => [{ name: "Paris", country: "France", lat: 48.85, lon: 2.35 }], weather: async () => ({ temp: 14 }) });
  const r = await cloud.chat({ history: [], text: "Weather in Paris?", context: { tz: "UTC" }, onStream: (e) => events.push(e) });
  assert.equal(r.reply, "It is 14° in Paris.");
  assert.deepEqual(events.map((e) => e.type === "delta" ? e.text : `<${e.type}${e.name ? ` ${e.name}` : ""}>`),
    ["Let ", "me ", "check.", "<tool get_weather>", "<reset>", "It ", "is ", "14° ", "in ", "Paris."]);
  assert.deepEqual([r.usage.requests, r.usage.messages], [2, 1], "usage is counted without a second read");
});

test("lookups in one round run together; saves keep their order", async () => {
  let running = 0, most = 0;
  const slow = async (value) => { running++; most = Math.max(most, running); await new Promise((r) => setTimeout(r, 20)); running--; return value; };
  const saved = [];
  const seen = [];
  const cloud = cloudWith(scripted([{ calls: [["get_weather", {}], ["world_events", { topic: "storms" }], ["save_memory", { text: "one" }], ["save_memory", { text: "two" }]] }, { text: "Done." }], seen),
    { weather: () => slow({ temp: 9 }), world: () => slow({ updatedAt: NOW, conflicts: [], earthquakes: { count: 0, top: [] }, tsunamis: [], fires: {}, storms: [] }) });
  const memory = { upcoming: [], search: async () => [], save: async (note) => { saved.push(note.text); await new Promise((r) => setTimeout(r, saved.length === 1 ? 20 : 0)); return { id: note.text, title: note.text, dates: [] }; } };
  const r = await cloud.chat({ history: [], text: "Weather, storms, and remember two things", context: { tz: "UTC", lat: 1, lon: 1 }, memory });
  assert.equal(most, 2, "both lookups were in flight at once");
  assert.deepEqual(saved, ["one", "two"]);
  assert.deepEqual(seen[1].contents.at(-1).parts.map((p) => p.functionResponse.name), ["get_weather", "world_events", "save_memory", "save_memory"], "results go back in the order asked");
  assert.deepEqual(r.saved.map((s) => s.title), ["one", "two"]);
});

test("filing a conversation alongside the answer costs no second model round", async () => {
  const seen = [], organized = [];
  const cloud = cloudWith(scripted([{ text: "Paris is lovely in spring.", calls: [["organize_conversation", { title: "Paris trip", folder: "Life" }]] }], seen));
  const memory = { upcoming: [], search: async () => [], organize: async (o) => { organized.push(o); return { title: o.title, folderId: "f1" }; } };
  const r = await cloud.chat({ history: [], text: "Tell me about Paris", context: { tz: "UTC", threadId: "t1" }, memory });
  assert.equal(r.reply, "Paris is lovely in spring.");
  assert.equal(seen.length, 1);
  assert.equal(organized[0].title, "Paris trip");
  assert.ok(!seen[0].tools[0].functionDeclarations.some((d) => d.name === "echo_expression"), "the reaction is read from the reply, not asked of the model");
});

test("the humanoid's reaction comes from the reply", () => {
  assert.equal(expressionFor("Which one do you mean?"), "curious");
  assert.equal(expressionFor("Congratulations on the new job."), "celebrate");
  assert.equal(expressionFor("## Plan\n1. First"), "thoughtful");
  assert.equal(expressionFor("It's 14°."), "attentive");
});

async function relay(gemini) {
  const r = createRelay({ secret: SECRET, gemini });
  const server = http.createServer(r.handler);
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${server.address().port}`;
  const { cloudPass } = await (await fetch(`${base}/phone/session`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json();
  return { base, headers: { "x-echo-pass": cloudPass, "content-type": "application/json" }, close: () => { server.closeAllConnections(); server.close(); r.close?.(); } };
}
const readEvents = async (res) => (await res.text()).trim().split("\n\n").map((block) => { const [e, d] = block.split("\n"); return [e.slice(7), JSON.parse(d.slice(6))]; });

test("the relay streams a chat turn, saves it once, and still answers plain JSON", async () => {
  const r = await relay(scripted([{ text: "Hello there." }, { text: "Plain." }, new Error("boom")]));
  try {
    const thread = (await (await fetch(`${r.base}/cloud/conversations`, { method: "POST", headers: r.headers, body: JSON.stringify({ action: "create" }) })).json()).thread;
    const ask = (body, accept) => fetch(`${r.base}/cloud/chat`, { method: "POST", headers: { ...r.headers, ...(accept ? { accept } : {}) }, body: JSON.stringify({ threadId: thread.id, context: { tz: "UTC" }, ...body }) });
    const live = await ask({ text: "Hi", requestId: "request-0001" }, "text/event-stream");
    assert.match(live.headers.get("content-type"), /text\/event-stream/);
    const events = await readEvents(live);
    assert.deepEqual(events.slice(0, -1), [["delta", { text: "Hello " }], ["delta", { text: "there." }]]);
    assert.equal(events.at(-1)[0], "done");
    assert.equal(events.at(-1)[1].reply, "Hello there.");
    // The same request again is the saved receipt, not a second model call.
    const again = await readEvents(await ask({ text: "Hi", requestId: "request-0001" }, "text/event-stream"));
    assert.deepEqual(again.map(([e]) => e), ["done"]);
    assert.equal(again[0][1].reply, "Hello there.");
    const plain = await ask({ text: "And without streaming", requestId: "request-0002" });
    assert.match(plain.headers.get("content-type"), /application\/json/);
    assert.equal((await plain.json()).reply, "Plain.");
    const failed = await ask({ text: "This one fails", requestId: "request-0003" }, "text/event-stream");
    assert.equal(failed.status, 502, "a failure before any text keeps its status code");
    assert.equal((await failed.json()).error, "failed");
  } finally { r.close(); }
});

test("app files are compressed, fingerprinted, and not re-sent when unchanged", async () => {
  const r = await relay(null);
  try {
    const raw = await fetch(`${r.base}/app.js`, { headers: { "accept-encoding": "identity" } });
    const size = (await raw.arrayBuffer()).byteLength;
    const etag = raw.headers.get("etag");
    assert.ok(etag);
    for (const encoding of ["br", "gzip"]) {
      const res = await new Promise((done, fail) => http.get(`${r.base}/app.js`, { headers: { "accept-encoding": encoding } }, (m) => { let n = 0; m.on("data", (c) => { n += c.length; }); m.on("end", () => done({ headers: m.headers, n })); }).on("error", fail));
      assert.equal(res.headers["content-encoding"], encoding);
      assert.ok(res.n < size / 3, `${encoding} is under a third of ${size} bytes (${res.n})`);
    }
    const unchanged = await fetch(`${r.base}/app.js`, { headers: { "if-none-match": etag } });
    assert.equal(unchanged.status, 304);
    assert.equal((await unchanged.arrayBuffer()).byteLength, 0);
    const picture = await fetch(`${r.base}/icons/icon-192.png`, { headers: { "accept-encoding": "br" } });
    assert.equal(picture.headers.get("content-encoding"), null, "pictures are already compressed");
  } finally { r.close(); }
});
