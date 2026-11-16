/** Agents reason on a stronger free model than chat, and fall back to chat's model without restarting work. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveKeys } from "../lib/secure.js";
import { createStore } from "../lib/store.js";
import { GeminiError } from "../lib/gemini.js";
import { createCloud, CloudError } from "../lib/cloud.js";

const SECRET = "s".repeat(48);
const NOW = Date.parse("2026-10-06T10:00:00Z");
const text = (t) => ({ candidates: [{ content: { role: "model", parts: [{ text: t }] } }] });
const store = () => createStore({ key: deriveKeys(SECRET).store, now: () => NOW });

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
