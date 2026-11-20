#!/usr/bin/env node
/**
 * Smoke test: Echo Phone against a running ARC, with Echo's own ARC key.
 *
 *   ARC_BASE_URL=https://arc.example.com/v1 ARC_API_KEY=ARC_DEE_… node scripts/arc-smoke.mjs
 *
 * Checks every way Echo uses its brain — plain and streamed answers, a tool-call round, JSON
 * output, embeddings for saved memory — then a real phone chat turn through the relay
 * (lib/arc.js → ARC → a provider). Run it after deploying ARC or rotating Echo's key.
 * ARC_MODEL / ARC_EMBED_MODEL as on Render (defaults: auto, gemini/gemini-embedding-001).
 */
import http from "node:http";
import { createArc } from "../lib/arc.js";
import { createRelay } from "../server.js";

const { ARC_BASE_URL, ARC_API_KEY } = process.env;
if (!ARC_BASE_URL || !ARC_API_KEY) {
  console.error("Set ARC_BASE_URL and ARC_API_KEY (Echo's own ARC key).");
  process.exit(2);
}
const arc = createArc({
  baseUrl: ARC_BASE_URL, apiKey: ARC_API_KEY, requestTimeoutMs: 30_000,
  ...(process.env.ARC_MODEL ? { model: process.env.ARC_MODEL } : {}),
  ...(process.env.ARC_EMBED_MODEL ? { embedModel: process.env.ARC_EMBED_MODEL } : {}),
});

let failed = 0;
async function check(name, fn) {
  const started = Date.now();
  try {
    const note = await fn();
    console.log(`ok   ${name} (${Date.now() - started} ms)${note ? ` — ${note}` : ""}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}: ${e?.kind ? `[${e.kind}${e.code ? ` ${e.code}` : ""}] ` : ""}${e?.message ?? e}`);
  }
}
const user = (text) => ({ role: "user", parts: [{ text }] });
const partsOf = (data) => data?.candidates?.[0]?.content?.parts ?? [];
const textOf = (data) => partsOf(data).filter((p) => p.text).map((p) => p.text).join("");
const must = (ok, message) => { if (!ok) throw new Error(message); };

await check("models this key may use", async () => {
  const names = await arc.listModels();
  must(names.length > 0, "no models");
  return names.slice(0, 5).join(", ");
});

await check("plain answer", async () => {
  const data = await arc.generate({ systemInstruction: { parts: [{ text: "Answer in one short sentence." }] }, contents: [user("Say hello to Echo.")] });
  must(textOf(data), "empty answer");
  return `${data.arc?.model ?? "?"}: ${textOf(data).slice(0, 60)}`;
});

await check("streamed answer", async () => {
  const pieces = [];
  const data = await arc.generateStream({ contents: [user("Count from one to five in words.")] }, { onText: (t) => pieces.push(t) });
  must(pieces.length > 0 && pieces.join("") === textOf(data), "pieces don't add up to the answer");
  return `${pieces.length} pieces`;
});

await check("tool-call round", async () => {
  const tools = [{ functionDeclarations: [{ name: "get_weather", description: "Current weather for a place", parameters: { type: "OBJECT", properties: { place: { type: "STRING" } }, required: ["place"] } }] }];
  const first = await arc.generate({ contents: [user("What's the weather in Paris? Use the tool.")], tools, toolConfig: { functionCallingConfig: { mode: "ANY" } } });
  const call = partsOf(first).find((p) => p.functionCall);
  must(call, "no tool call");
  const second = await arc.generate({
    contents: [user("What's the weather in Paris? Use the tool."), { role: "model", parts: partsOf(first) },
      { role: "user", parts: [{ functionResponse: { id: call.functionCall.id, name: call.functionCall.name, response: { temp: 14, sky: "clear" } } }] }],
    tools,
  });
  must(textOf(second), "no answer after the tool result");
  return `${call.functionCall.name}(${JSON.stringify(call.functionCall.args)})`;
});

await check("JSON output", async () => {
  const data = await arc.generate({ contents: [user('Reply with {"ok": true} as JSON.')], generationConfig: { responseMimeType: "application/json" } });
  JSON.parse(textOf(data));
});

await check("embedding for saved memory", async () => {
  const v = await arc.embed("Dentist on Tuesday at 4pm", { dims: 512 });
  return `${v.length} dimensions via ${arc.embedModel}`;
});

await check("phone chat turn through the relay", async () => {
  const relay = createRelay({ secret: "smoke-".padEnd(48, "x"), gemini: arc });
  const server = http.createServer(relay.handler);
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { cloudPass } = await (await fetch(`${base}/phone/session`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json();
    const headers = { "x-echo-pass": cloudPass, "content-type": "application/json", accept: "text/event-stream" };
    const thread = (await (await fetch(`${base}/cloud/conversations`, { method: "POST", headers, body: JSON.stringify({ action: "create" }) })).json()).thread;
    const res = await fetch(`${base}/cloud/chat`, { method: "POST", headers, body: JSON.stringify({ threadId: thread.id, text: "Hi Echo, how are you?", requestId: `smoke-${Date.now()}`, context: { tz: "UTC" } }) });
    const raw = await res.text();
    must(res.ok, `relay answered ${res.status}: ${raw.slice(0, 200)}`);
    const done = raw.trim().split("\n\n").map((b) => b.split("\n")).find(([e]) => e === "event: done");
    must(done, "no finished reply");
    const reply = JSON.parse(done[1].slice(6)).reply;
    must(reply, "empty reply");
    return reply.slice(0, 60);
  } finally {
    server.closeAllConnections(); server.close(); relay.close?.();
  }
});

console.log(failed ? `\n${failed} check(s) failed` : "\nEcho Phone works through ARC.");
process.exit(failed ? 1 : 0);
