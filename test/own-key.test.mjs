/** A user's own Gemini key: saved after Google accepts it, never sent back, and used when Echo's own key runs out. */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRelay } from "../server.js";
import { GeminiError } from "../lib/gemini.js";

const SECRET = "s".repeat(48);
const GOOD = "AIzaSyD-user-key-0123456789abcdefWXYZ";
const answer = (t) => ({ candidates: [{ content: { role: "model", parts: [{ text: t }] } }] });
const call = (name, args) => ({ candidates: [{ content: { role: "model", parts: [{ functionCall: { name, args } }] } }] });

function owner(script = []) {
  const calls = [];
  return { calls, model: "gemini-3.8-flash", generate: async (body) => { calls.push(body); const next = script.shift() ?? answer("Echo's key answered."); if (next instanceof Error) throw next; return next; } };
}
async function relay(gemini) {
  const made = [];
  const makeGemini = (apiKey) => {
    const client = { apiKey, calls: [], model: "gemini-3.8-flash",
      listModels: async () => { if (apiKey !== GOOD) throw new GeminiError("auth", "API key not valid"); return ["gemini-3.8-flash"]; },
      generate: async (body) => { client.calls.push(body); return answer("Your key answered."); } };
    made.push(client);
    return client;
  };
  const r = createRelay({ secret: SECRET, gemini, makeGemini });
  const server = http.createServer(r.handler);
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${server.address().port}`;
  const session = async () => (await (await fetch(`${base}/phone/session`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json()).cloudPass;
  const as = (pass) => ({
    get: async (path) => { const res = await fetch(`${base}${path}`, { headers: { "x-echo-pass": pass } }); return { status: res.status, body: await res.json(), text: "" }; },
    post: async (path, b) => { const res = await fetch(`${base}${path}`, { method: "POST", headers: { "x-echo-pass": pass, "content-type": "application/json" }, body: JSON.stringify(b) }); const text = await res.text(); return { status: res.status, body: JSON.parse(text), text }; },
  });
  return { made, session, as, close: () => { server.closeAllConnections(); server.close(); } };
}
const dayQuota = () => new GeminiError("day", "Quota exceeded", { limit: 20, quota: "GenerateRequestsPerDay" });

test("a key is checked with Google before it is saved, and only its last 4 characters ever come back", async () => {
  const r = await relay(owner());
  try {
    const me = r.as(await r.session());
    assert.equal((await me.post("/cloud/key", { action: "save", key: "short" })).status, 400);
    const rejected = await me.post("/cloud/key", { action: "save", key: "AIzaSyD-wrong-key-0123456789abcdef0000" });
    assert.equal(rejected.status, 400);
    assert.match(rejected.body.message, /Google didn't accept that key/);
    const saved = await me.post("/cloud/key", { action: "save", key: GOOD });
    assert.deepEqual([saved.status, saved.body.ownKey.last4, saved.body.ownKey.mode], [200, "WXYZ", "fallback"]);
    const read = await me.get("/cloud/key"), status = await me.get("/cloud/status");
    assert.equal(read.body.ownKey.last4, "WXYZ");
    assert.equal(status.body.ownKey.last4, "WXYZ");
    for (const body of [saved.text, JSON.stringify(read.body), JSON.stringify(status.body)]) assert.ok(!body.includes(GOOD.slice(0, 20)), "the key itself never leaves the server");
    // Another account sees nothing.
    assert.equal((await r.as(await r.session()).get("/cloud/key")).body.ownKey, null);
  } finally { r.close(); }
});

test("when Echo's key runs out, the user's key answers, and keeps answering until the day turns over", async () => {
  const shared = owner([dayQuota()]);
  const r = await relay(shared);
  try {
    const me = r.as(await r.session());
    await me.post("/cloud/key", { action: "save", key: GOOD });
    const first = await me.post("/cloud/chat", { text: "Hello", context: {} });
    assert.equal(first.status, 200);
    assert.equal(first.body.reply, "Your key answered.");
    assert.equal(first.body.keyUsed, "own");
    const sharedCalls = shared.calls.length;
    const second = await me.post("/cloud/chat", { text: "Again", context: {} });
    assert.equal(second.body.reply, "Your key answered.");
    assert.equal(shared.calls.length, sharedCalls, "Echo's used-up key isn't tried again today");
    assert.equal((await me.get("/cloud/key")).body.sharedOut, true);
    // Someone without a key is told how to keep going, and the phone offers the button. (Google still refuses Echo's key.)
    shared.generate = async () => { throw dayQuota(); };
    const other = r.as(await r.session());
    const stuck = await other.post("/cloud/chat", { text: "Hello", context: {} });
    assert.equal(stuck.status, 429);
    assert.equal(stuck.body.ownKeyHelps, true);
    assert.match(stuck.body.message, /Add your own free Gemini key in Settings/);
  } finally { r.close(); }
});

test("a request already under way is never restarted on the other key", async () => {
  const shared = owner([call("save_memory", { text: "Passport renews in March" }), dayQuota()]);
  const r = await relay(shared);
  try {
    const me = r.as(await r.session());
    await me.post("/cloud/key", { action: "save", key: GOOD });
    const res = await me.post("/cloud/chat", { text: "Remember my passport renews in March", context: {} });
    assert.equal(res.status, 429, "the memory was already saved: running it again on another key could save it twice");
    assert.equal(r.made.at(-1).calls.length, 0);
  } finally { r.close(); }
});

test("'Always' uses only the user's key; removing it goes back to Echo's", async () => {
  const shared = owner();
  const r = await relay(shared);
  try {
    const me = r.as(await r.session());
    await me.post("/cloud/key", { action: "save", key: GOOD, mode: "always" });
    assert.equal((await me.post("/cloud/chat", { text: "Hi", context: {} })).body.keyUsed, "own");
    assert.equal(shared.calls.length, 0);
    assert.equal((await me.post("/cloud/key", { action: "mode", mode: "fallback" })).body.ownKey.mode, "fallback");
    assert.equal((await me.post("/cloud/chat", { text: "Hi", context: {} })).body.keyUsed, "shared");
    assert.deepEqual((await me.post("/cloud/key", { action: "remove" })).body, { ownKey: null });
    assert.equal((await me.get("/cloud/status")).body.ownKey, null);
  } finally { r.close(); }
});

test("a relay without its own key still works for users who bring theirs", async () => {
  const r = await relay(null);
  try {
    const me = r.as(await r.session());
    assert.equal((await me.post("/cloud/chat", { text: "Hi", context: {} })).status, 503);
    await me.post("/cloud/key", { action: "save", key: GOOD });
    assert.equal((await me.get("/cloud/status")).body.ready, true);
    assert.equal((await me.post("/cloud/chat", { text: "Hi", context: {} })).body.reply, "Your key answered.");
  } finally { r.close(); }
});
