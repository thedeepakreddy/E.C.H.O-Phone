/** Echo's brain through ARC: Gemini-shaped requests in, OpenAI-compatible calls out, and back. */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createArc, toOpenAI, fromOpenAI, toJsonSchema, classifyArc } from "../lib/arc.js";
import { createCloud } from "../lib/cloud.js";
import { createStore } from "../lib/store.js";
import { deriveKeys } from "../lib/secure.js";
import { createRelay } from "../server.js";

const SECRET = "s".repeat(48);
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const sse = (chunks) => new Response(new ReadableStream({ start(c) { for (const x of chunks) c.enqueue(new TextEncoder().encode(x)); c.close(); } }), { status: 200, headers: { "content-type": "text/event-stream", "x-arc-route-provider": "gemini", "x-arc-route-model": "gemini/gemini-3.8-flash" } });
const chunk = (delta, finish = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const completion = (message, finish = "stop") => ({ choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason: finish }], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } });

test("a Gemini conversation with tools becomes an OpenAI conversation with matching call ids", () => {
  const body = {
    systemInstruction: { parts: [{ text: "You are Echo." }] },
    contents: [
      { role: "user", parts: [{ text: "What's on this receipt?" }, { inline_data: { mime_type: "image/jpeg", data: "QUJD" } }] },
      { role: "model", parts: [{ thought: true, text: "thinking" }, { text: "Checking." }, { functionCall: { name: "get_weather", args: { place: "Paris" } }, thoughtSignature: "sig" }, { functionCall: { name: "recall_memory", args: { query: "receipt" } } }] },
      { role: "user", parts: [{ functionResponse: { name: "recall_memory", response: { items: [] } } }, { functionResponse: { name: "get_weather", response: { temp: 14 } } }] },
      { role: "user", parts: [{ inline_data: { mime_type: "audio/wav", data: "UklG" } }, { text: "voice note" }] },
    ],
    tools: [{ functionDeclarations: [{ name: "get_weather", description: "Weather", parameters: { type: "OBJECT", properties: { place: { type: "STRING", nullable: true } }, required: ["place"], propertyOrdering: ["place"] } }] }],
    toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["get_weather"] } },
    generationConfig: { temperature: 0.2, maxOutputTokens: 500, responseMimeType: "application/json", responseSchema: { type: "OBJECT", properties: { ok: { type: "BOOLEAN" } } } },
  };
  const out = toOpenAI(body, { thinking: "medium" });
  assert.deepEqual(out.messages.map((m) => m.role), ["system", "user", "assistant", "tool", "tool", "user"]);
  assert.equal(out.messages[0].content, "You are Echo.");
  assert.deepEqual(out.messages[1].content[1], { type: "image_url", image_url: { url: "data:image/jpeg;base64,QUJD" } });
  const assistant = out.messages[2];
  assert.equal(assistant.content, "Checking.", "thoughts are not sent back");
  const [weatherCall, memoryCall] = assistant.tool_calls;
  assert.equal(weatherCall.function.arguments, JSON.stringify({ place: "Paris" }));
  assert.equal(out.messages[3].tool_call_id, memoryCall.id, "results answer the call with the same name, whatever their order");
  assert.equal(out.messages[4].tool_call_id, weatherCall.id);
  assert.equal(out.messages[4].content, JSON.stringify({ temp: 14 }));
  assert.deepEqual(out.messages[5].content[0], { type: "input_audio", input_audio: { data: "UklG", format: "wav" } });
  assert.deepEqual(out.tools[0].function.parameters, { type: "object", properties: { place: { type: ["string", "null"] } }, required: ["place"] });
  assert.deepEqual(out.tool_choice, { type: "function", function: { name: "get_weather" } });
  assert.equal(out.temperature, 0.2);
  assert.equal(out.max_tokens, 500);
  assert.deepEqual(out.response_format, { type: "json_schema", json_schema: { name: "response", schema: { type: "object", properties: { ok: { type: "boolean" } } } } });
  assert.equal(out.reasoning_effort, "medium");
});

test("an ARC answer comes back in generateContent's shape, calls keeping their ids", () => {
  const data = fromOpenAI(completion({ content: "Sure.", tool_calls: [{ id: "call_9", type: "function", function: { name: "save_memory", arguments: '{"text":"milk"}' } }] }, "tool_calls"), { model: "groq/x" });
  assert.deepEqual(data.candidates[0].content.parts, [{ text: "Sure." }, { functionCall: { id: "call_9", name: "save_memory", args: { text: "milk" } } }]);
  assert.equal(data.candidates[0].finishReason, "STOP");
  assert.equal(data.usageMetadata.totalTokenCount, 10);
  assert.equal(fromOpenAI(completion({ content: "cut" }, "length")).candidates[0].finishReason, "MAX_TOKENS");
  // The id survives the next round, so ARC sees a consistent conversation.
  const next = toOpenAI({ contents: [{ role: "model", parts: data.candidates[0].content.parts }, { role: "user", parts: [{ functionResponse: { name: "save_memory", response: { ok: true } } }] }] });
  assert.equal(next.messages[0].tool_calls[0].id, "call_9");
  assert.equal(next.messages[1].tool_call_id, "call_9");
});

test("schemas: nested Gemini types become JSON Schema", () => {
  assert.deepEqual(toJsonSchema({ type: "ARRAY", items: { type: "OBJECT", properties: { n: { type: "NUMBER" } } } }), { type: "array", items: { type: "object", properties: { n: { type: "number" } } } });
});

test("generate calls ARC with the app's key, a deadline and ARC's model", async () => {
  const seen = [];
  const arc = createArc({ baseUrl: "https://arc.example/v1/", apiKey: "ARC_DEE_x_PAK_y", fetchImpl: async (url, init) => { seen.push({ url, init, body: JSON.parse(init.body) }); return json(completion({ content: "Hello." }), 200, { "x-arc-route-provider": "groq", "x-arc-route-model": "groq/llama" }); } });
  let counted = 0;
  const data = await arc.generate({ contents: [{ role: "user", parts: [{ text: "Hi" }] }] }, { modelId: "auto", onRequest: () => counted++ });
  assert.equal(seen[0].url, "https://arc.example/v1/chat/completions");
  assert.equal(seen[0].init.headers.authorization, "Bearer ARC_DEE_x_PAK_y");
  assert.equal(seen[0].init.headers["x-arc-deadline-ms"], "12000");
  assert.equal(seen[0].body.model, "auto");
  assert.equal(seen[0].body.stream, undefined);
  assert.equal(data.candidates[0].content.parts[0].text, "Hello.");
  assert.deepEqual([data.arc.provider, data.arc.model], ["groq", "groq/llama"]);
  assert.equal(counted, 1);
  assert.equal(arc.agentModel, null, "ARC does the model fallback, not Echo");
  assert.deepEqual(arc.fallbackModels, []);
});

test("a streamed ARC answer arrives piece by piece, tool-call pieces joined", async () => {
  const body = chunk({ role: "assistant", content: "Let " }) + chunk({ content: "me check." }) +
    chunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "get_", arguments: '{"pla' } }] }) +
    chunk({ tool_calls: [{ index: 0, function: { name: "weather", arguments: 'ce":"Rome"}' } }] }) + chunk({}, "tool_calls") +
    `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } })}\n\ndata: [DONE]\n\n`;
  const sent = [];
  const arc = createArc({ baseUrl: "https://arc.example", apiKey: "k", fetchImpl: async (_url, init) => { sent.push(JSON.parse(init.body)); return sse([body.slice(0, 40), body.slice(40, 90), body.slice(90)]); } });
  const pieces = [];
  const data = await arc.generateStream({ contents: [{ role: "user", parts: [{ text: "Weather?" }] }] }, { onText: (t) => pieces.push(t) });
  assert.equal(sent[0].stream, true);
  assert.deepEqual(sent[0].stream_options, { include_usage: true });
  assert.deepEqual(pieces, ["Let ", "me check."]);
  assert.deepEqual(data.candidates[0].content.parts, [{ text: "Let me check." }, { functionCall: { id: "call_1", name: "get_weather", args: { place: "Rome" } } }]);
  assert.equal(data.usageMetadata.totalTokenCount, 3);
  assert.equal(data.arc.provider, "gemini");
});

test("ARC's errors keep the kinds Phone mode understands", () => {
  const h = (o) => new Headers(o);
  assert.equal(classifyArc(401, { error: { code: "invalid_api_key" } }).kind, "auth");
  const minute = classifyArc(429, { error: { code: "provider_rate_limited" } }, h({ "retry-after": "3" }));
  assert.deepEqual([minute.kind, minute.retryMs], ["minute", 3000]);
  const none = classifyArc(503, { error: { code: "no_eligible_route" } }, h({}));
  assert.deepEqual([none.kind, none.retryMs, none.via], ["day", 600_000, "arc"]);
  assert.equal(classifyArc(502, { error: { code: "provider_error" } }).kind, "server");
  assert.equal(classifyArc(504, { error: { code: "deadline_exceeded" } }).kind, "server");
  assert.equal(classifyArc(400, { error: { code: "capability_not_supported" } }).kind, "other");
});

test("through the cloud brain, ARC's limits read as short rests and a bad key names ARC_API_KEY", async () => {
  const NOW = Date.parse("2026-10-06T10:00:00Z");
  const cloudWith = (response) => createCloud({
    gemini: createArc({ baseUrl: "https://arc.example", apiKey: "k", fetchImpl: async () => response() }),
    store: createStore({ key: deriveKeys(SECRET).store, now: () => NOW }), now: () => NOW,
  });
  const busy = cloudWith(() => json({ error: { code: "no_eligible_route", message: "No eligible route" } }, 503, { "retry-after": "120" }));
  await assert.rejects(busy.chat({ history: [], text: "Hi", context: { tz: "UTC" } }), (e) => e.kind === "quota" && e.resetsAt === NOW + 120_000);
  const bad = cloudWith(() => json({ error: { code: "invalid_api_key", message: "Invalid ARC key" } }, 401));
  await assert.rejects(bad.chat({ history: [], text: "Hi", context: { tz: "UTC" } }), (e) => e.kind === "setup" && /ARC_API_KEY/.test(e.message));
});

test("a search that needs Google's own grounding is refused rather than answered from memory", async () => {
  let called = false;
  const arc = createArc({ baseUrl: "https://arc.example", apiKey: "k", fetchImpl: async () => { called = true; return json(completion({ content: "made up" })); } });
  await assert.rejects(arc.generate({ contents: [{ role: "user", parts: [{ text: "news" }] }], tools: [{ google_search: {} }] }), (e) => e.code === "grounding_unavailable");
  assert.equal(called, false);
});

test("embeddings use one pinned model and the requested size", async () => {
  const seen = [];
  const arc = createArc({ baseUrl: "https://arc.example", apiKey: "k", fetchImpl: async (url, init) => { seen.push({ url, body: JSON.parse(init.body) }); return json({ data: [{ embedding: Array(512).fill(0.5) }] }); } });
  const v = await arc.embed("a saved note", { task: "RETRIEVAL_DOCUMENT", dims: 512 });
  assert.equal(v.length, 512);
  assert.equal(seen[0].url, "https://arc.example/v1/embeddings");
  assert.deepEqual(seen[0].body, { model: "gemini/gemini-embedding-001", input: "a saved note", dimensions: 512 });
  const short = createArc({ baseUrl: "https://arc.example", apiKey: "k", fetchImpl: async () => json({ data: [{ embedding: [1, 2] }] }) });
  await assert.rejects(short.embed("x", { dims: 512 }), /No embedding/);
});

test("a phone chat turn goes through a running ARC end to end", async () => {
  const requests = [];
  const fakeArc = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c)).on("end", () => {
      const body = JSON.parse(raw || "{}");
      requests.push({ url: req.url, auth: req.headers.authorization, body });
      if (!body.stream) {
        res.writeHead(200, { "content-type": "application/json", "x-arc-route-provider": "gemini" });
        return res.end(JSON.stringify(completion({ content: "Hello from ARC." })));
      }
      res.writeHead(200, { "content-type": "text/event-stream", "x-arc-route-provider": "gemini" });
      res.end(chunk({ role: "assistant", content: "Hello " }) + chunk({ content: "from ARC." }) + chunk({}, "stop") + "data: [DONE]\n\n");
    });
  });
  await new Promise((done) => fakeArc.listen(0, "127.0.0.1", done));
  const gemini = createArc({ baseUrl: `http://127.0.0.1:${fakeArc.address().port}/v1`, apiKey: "ARC_DEE_echo_PAK_test" });
  const relay = createRelay({ secret: SECRET, gemini });
  const server = http.createServer(relay.handler);
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { cloudPass } = await (await fetch(`${base}/phone/session`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json();
    const headers = { "x-echo-pass": cloudPass, "content-type": "application/json" };
    const thread = (await (await fetch(`${base}/cloud/conversations`, { method: "POST", headers, body: JSON.stringify({ action: "create" }) })).json()).thread;
    const ask = (text, requestId, accept) => fetch(`${base}/cloud/chat`, { method: "POST", headers: { ...headers, ...(accept ? { accept } : {}) }, body: JSON.stringify({ threadId: thread.id, text, requestId, context: { tz: "UTC" } }) });
    const plain = await ask("Hi Echo", "request-arc-1");
    assert.equal(plain.status, 200);
    assert.equal((await plain.json()).reply, "Hello from ARC.");
    const live = await ask("And streamed?", "request-arc-2", "text/event-stream");
    const events = (await live.text()).trim().split("\n\n").map((b) => b.split("\n")[0].slice(7));
    assert.deepEqual(events, ["delta", "delta", "done"], "the phone sees the answer as ARC streams it");
    assert.equal(requests.at(-1).body.stream, true);
    const chat = requests.find((r) => r.url === "/v1/chat/completions");
    assert.equal(chat.auth, "Bearer ARC_DEE_echo_PAK_test");
    assert.equal(chat.body.model, "auto");
    assert.equal(chat.body.messages[0].role, "system");
    assert.ok(chat.body.tools.length > 5, "Echo's tools are offered through ARC");
    assert.ok(chat.body.messages.some((m) => m.role === "user" && JSON.stringify(m.content).includes("Hi Echo")));
  } finally {
    server.closeAllConnections(); server.close(); relay.close?.();
    fakeArc.closeAllConnections(); fakeArc.close();
  }
});

test("through ARC, Google's remembered daily limit doesn't stop Echo; with Gemini directly it still does", async () => {
  const { quotaDay } = await import("../lib/cloud.js");
  const answer = { candidates: [{ content: { role: "model", parts: [{ text: "Hi there" }] } }] };
  for (const via of ["arc", undefined]) {
    const store = createStore({ key: Buffer.alloc(32) });
    // A limit learned from Google on an earlier day, and today's requests already past it.
    await store.setCount("qlimit", 20);
    await store.setCount(`q:${quotaDay(Date.now())}`, 25, 86400);
    const cloud = createCloud({ store, tools: {}, gemini: { via, model: "auto", generate: async () => answer } });
    if (via === "arc") {
      const out = await cloud.chat({ history: [], text: "Hello" });
      assert.match(out.reply, /Hi there/);
    } else {
      await assert.rejects(cloud.chat({ history: [], text: "Hello" }), /free Gemini limit/);
    }
  }
});
