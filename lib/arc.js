/**
 * Echo's brain through ARC (AI Runtime & Connectivity): one OpenAI-compatible API that holds the
 * owner's provider keys and picks a healthy, free model and key for every request.
 *
 * createArc() has the same interface as createGemini() (lib/gemini.js): Gemini-shaped request
 * bodies go in and Gemini-shaped responses come out, so lib/cloud.js and the agents work
 * unchanged. Here they are translated to and from OpenAI chat completions:
 *
 *   systemInstruction           → a system message
 *   text / inline_data parts    → text, image_url, input_audio or file content parts
 *   functionCall parts          → assistant tool_calls (the call id is kept on the part)
 *   functionResponse parts      → tool messages answering those calls
 *   functionDeclarations        → tools; functionCallingConfig → tool_choice
 *   responseMimeType/Schema     → response_format (JSON mode / JSON schema)
 *   thinking level              → reasoning_effort
 *
 * Errors become GeminiError with the same kinds, so Phone mode's messages and the switch to a
 * user's own key keep working. A Gemini key a user adds in Settings goes to Google directly; an
 * ARC key a user adds goes through this client to their own ARC workspace.
 */
import { GeminiError } from "./gemini.js";

const FINISH = { stop: "STOP", length: "MAX_TOKENS", tool_calls: "STOP", content_filter: "SAFETY", function_call: "STOP" };
const GROUNDING_TOOLS = ["google_search", "googleSearch", "google_search_retrieval", "googleSearchRetrieval", "code_execution", "codeExecution", "url_context", "urlContext"];

/** Gemini's OpenAPI-style schema (types in capitals, `nullable`) as JSON Schema. */
export function toJsonSchema(schema) {
  if (Array.isArray(schema)) return schema.map(toJsonSchema);
  if (!schema || typeof schema !== "object") return schema;
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === "propertyOrdering" || k === "nullable") continue;
    if (k === "type" && typeof v === "string") out.type = v.toLowerCase();
    else if (k === "properties" && v && typeof v === "object") out.properties = Object.fromEntries(Object.entries(v).map(([p, s]) => [p, toJsonSchema(s)]));
    else if (["items", "anyOf", "oneOf", "allOf", "not", "additionalProperties"].includes(k)) out[k] = toJsonSchema(v);
    else out[k] = v;
  }
  if (schema.nullable === true && typeof out.type === "string") out.type = [out.type, "null"];
  return out;
}

const textOf = (content) => (typeof content === "string" ? content : (content?.parts ?? []).map((p) => p?.text ?? "").join(""));

function mediaPart(data) {
  const mime = String(data.mime_type ?? data.mimeType ?? "application/octet-stream").toLowerCase();
  const b64 = String(data.data ?? "");
  if (mime.startsWith("image/")) return { type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } };
  if (mime.startsWith("audio/")) {
    const format = /mp3|mpeg/.test(mime) ? "mp3" : "wav";
    return { type: "input_audio", input_audio: { data: b64, format } };
  }
  return { type: "file", file: { file_data: `data:${mime};base64,${b64}`, filename: mime === "application/pdf" ? "document.pdf" : "attachment" } };
}

/** A Gemini generateContent body as an OpenAI chat completions body (without model/stream). */
export function toOpenAI(body = {}, { thinking } = {}) {
  const messages = [];
  const system = textOf(body.systemInstruction ?? body.system_instruction);
  if (system) messages.push({ role: "system", content: system });

  let callCount = 0;
  const pending = new Map(); // function name → ids of calls not answered yet, oldest first
  for (const turn of Array.isArray(body.contents) ? body.contents : []) {
    const parts = Array.isArray(turn?.parts) ? turn.parts : [];
    if (turn?.role === "model") {
      const text = parts.filter((p) => typeof p.text === "string" && !p.thought && !p.functionCall).map((p) => p.text).join("");
      const calls = parts.filter((p) => p.functionCall).map((p) => {
        const name = String(p.functionCall.name ?? "");
        const id = String(p.functionCall.id ?? `call_${++callCount}_${name}`.slice(0, 64));
        if (!pending.has(name)) pending.set(name, []);
        pending.get(name).push(id);
        return { id, type: "function", function: { name, arguments: JSON.stringify(p.functionCall.args ?? {}) } };
      });
      if (text || calls.length) messages.push({ role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    // A user (or "function") turn: tool results first — they must follow the assistant's calls.
    for (const p of parts.filter((x) => x.functionResponse)) {
      const name = String(p.functionResponse.name ?? "");
      const queue = pending.get(name) ?? [];
      const id = String(p.functionResponse.id ?? queue[0] ?? `call_${++callCount}_${name}`.slice(0, 64));
      const at = queue.indexOf(id);
      if (at >= 0) queue.splice(at, 1);
      messages.push({ role: "tool", tool_call_id: id, content: JSON.stringify(p.functionResponse.response ?? {}) });
    }
    const content = [];
    for (const p of parts) {
      if (p.functionResponse || p.thought) continue;
      if (typeof p.text === "string") content.push({ type: "text", text: p.text });
      else if (p.inline_data || p.inlineData) content.push(mediaPart(p.inline_data ?? p.inlineData));
    }
    if (!content.length) continue;
    messages.push({ role: "user", content: content.every((c) => c.type === "text") ? content.map((c) => c.text).join("\n") : content });
  }

  const out = { messages };
  const declarations = [];
  for (const tool of Array.isArray(body.tools) ? body.tools : []) {
    for (const d of tool?.functionDeclarations ?? tool?.function_declarations ?? []) {
      declarations.push({
        type: "function",
        function: {
          name: d.name,
          ...(d.description ? { description: d.description } : {}),
          parameters: toJsonSchema(d.parametersJsonSchema ?? d.parameters ?? { type: "object", properties: {} }),
        },
      });
    }
  }
  if (declarations.length) out.tools = declarations;
  const fcc = body.toolConfig?.functionCallingConfig ?? body.tool_config?.function_calling_config;
  if (declarations.length && fcc) {
    const mode = String(fcc.mode ?? "AUTO").toUpperCase();
    const allowed = fcc.allowedFunctionNames ?? fcc.allowed_function_names ?? [];
    if (mode === "NONE") out.tool_choice = "none";
    else if (mode === "ANY") out.tool_choice = allowed.length === 1 ? { type: "function", function: { name: allowed[0] } } : "required";
    else out.tool_choice = "auto";
  }

  const g = body.generationConfig ?? body.generation_config ?? {};
  if (typeof g.temperature === "number") out.temperature = g.temperature;
  if (typeof g.topP === "number") out.top_p = g.topP;
  if (Number.isInteger(g.maxOutputTokens)) out.max_tokens = g.maxOutputTokens;
  if (Array.isArray(g.stopSequences) && g.stopSequences.length) out.stop = g.stopSequences.slice(0, 4);
  if (typeof g.seed === "number") out.seed = g.seed;
  if (String(g.responseMimeType ?? "").toLowerCase() === "application/json") {
    const schema = g.responseJsonSchema ?? g.responseSchema;
    out.response_format = schema
      ? { type: "json_schema", json_schema: { name: "response", schema: toJsonSchema(schema) } }
      : { type: "json_object" };
  }
  const level = thinking ?? g.thinkingConfig?.thinkingLevel;
  if (["low", "medium", "high"].includes(level)) out.reasoning_effort = level;
  return out;
}

/** An OpenAI chat completion (or the joined stream) in generateContent's shape. */
export function fromOpenAI(data, route = {}) {
  const choice = data?.choices?.[0] ?? {};
  const message = choice.message ?? {};
  const parts = [];
  if (typeof message.content === "string" && message.content) parts.push({ text: message.content });
  for (const call of message.tool_calls ?? []) {
    let args = {};
    try { args = call.function?.arguments ? JSON.parse(call.function.arguments) : {}; } catch { args = {}; }
    parts.push({ functionCall: { id: call.id, name: call.function?.name, args } });
  }
  const u = data?.usage;
  return {
    candidates: [{ ...(parts.length ? { content: { role: "model", parts } } : {}), finishReason: FINISH[choice.finish_reason] ?? (choice.finish_reason ? "OTHER" : "STOP") }],
    ...(u ? { usageMetadata: { promptTokenCount: u.prompt_tokens, candidatesTokenCount: u.completion_tokens, totalTokenCount: u.total_tokens } } : {}),
    ...(route.model ? { modelVersion: route.model } : {}),
    arc: route,
  };
}

function retryMsOf(headers) {
  const v = headers?.get?.("retry-after");
  if (!v) return 0;
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000);
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : 0;
}

/** ARC's error envelope as a GeminiError of the kind Phone mode already understands. */
export function classifyArc(status, data, headers) {
  const err = data?.error ?? {};
  const code = String(err.code ?? "");
  const message = String(err.message ?? `ARC HTTP ${status}`);
  const extra = { via: "arc", code };
  if (status === 401 || status === 403) return new GeminiError("auth", message, extra);
  if (status === 429) return new GeminiError("minute", message, { ...extra, retryMs: retryMsOf(headers) });
  // Every owner key ARC may use is out of quota, cooling down or unhealthy. Nothing has been
  // done yet, so a user's own key can take over safely: treat it like a used-up daily limit,
  // but only for a short rest — ARC recovers as soon as a key does.
  if (status === 503 && code === "no_eligible_route") return new GeminiError("day", message, { ...extra, limit: null, retryMs: retryMsOf(headers) || 10 * 60_000 });
  if (status >= 500) return new GeminiError("server", message, extra);
  if (status === 400 && /content|safety|policy/i.test(code + message) && /block|filter|policy/i.test(message)) return new GeminiError("blocked", message, extra);
  return new GeminiError("other", message, extra);
}

function routeOf(res) {
  const h = (n) => res.headers.get(n) ?? undefined;
  return { provider: h("x-arc-route-provider"), model: h("x-arc-route-model"), attempts: Number(h("x-arc-route-attempts")) || undefined, requestId: h("x-request-id") };
}

export function createArc({
  baseUrl, apiKey, model = "auto", embedModel = "gemini/gemini-embedding-001",
  fetchImpl = fetch, requestTimeoutMs = 12_000,
}) {
  if (!baseUrl || !apiKey) throw new Error("createArc needs ARC_BASE_URL and ARC_API_KEY.");
  const base = String(baseUrl).replace(/\/+$/, "").replace(/\/v1$/, "") + "/v1";
  const headers = { authorization: `Bearer ${apiKey}`, "content-type": "application/json", "x-arc-deadline-ms": String(requestTimeoutMs) };

  function requestBody(body, modelId, thinking, stream) {
    const hasDeclarations = (body.tools ?? []).some((t) => (t?.functionDeclarations ?? t?.function_declarations ?? []).length);
    const grounding = (body.tools ?? []).some((t) => GROUNDING_TOOLS.some((k) => t && k in t));
    // Google Search grounding exists only on Google's own API. Refuse rather than let a model
    // answer from memory as if it had searched; Echo then reports that the search failed.
    if (grounding && !hasDeclarations) throw new GeminiError("other", "Search grounding isn't available through ARC.", { via: "arc", code: "grounding_unavailable" });
    const out = { model: modelId && modelId !== "auto" ? modelId : model, ...toOpenAI(body, { thinking }) };
    if (stream) { out.stream = true; out.stream_options = { include_usage: true }; }
    return JSON.stringify(out);
  }

  async function post(path, payload, signal, timeoutMs = requestTimeoutMs) {
    signal?.throwIfAborted();
    const deadline = AbortSignal.timeout(timeoutMs);
    const attemptSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    try {
      return { res: await fetchImpl(`${base}${path}`, { method: "POST", headers, body: payload, signal: attemptSignal }), attemptSignal, deadline };
    } catch (e) {
      if (signal?.aborted) throw signal.reason ?? e;
      throw new GeminiError("server", deadline.aborted ? "ARC didn't answer in time." : `ARC is unreachable: ${e?.message ?? e}`, { via: "arc" });
    }
  }

  async function failure(res) {
    const data = await res.json().catch(() => ({}));
    return classifyArc(res.status, data, res.headers);
  }

  async function generate(body, { modelId, onRequest = () => {}, signal, thinking } = {}) {
    const payload = requestBody(body, modelId, thinking, false);
    onRequest();
    const { res, attemptSignal } = await post("/chat/completions", payload, signal);
    if (!res.ok) throw await failure(res);
    try { return fromOpenAI(await res.json(), routeOf(res)); }
    catch (e) {
      if (attemptSignal.aborted) throw signal?.aborted ? signal.reason : new GeminiError("server", "ARC didn't answer in time.", { via: "arc" });
      throw new GeminiError("other", "ARC returned an unreadable response.", { via: "arc" });
    }
  }

  /**
   * Streamed: `onText` gets each piece of the answer as it arrives. The timeout bounds the wait
   * for the first byte and then each silence between pieces, not the whole answer.
   */
  async function generateStream(body, { modelId, onRequest = () => {}, signal, thinking, onText = () => {} } = {}) {
    const payload = requestBody(body, modelId, thinking, true);
    onRequest();
    const idle = new AbortController();
    let timer;
    const arm = () => { clearTimeout(timer); timer = setTimeout(() => idle.abort(new DOMException("ARC stopped sending.", "TimeoutError")), requestTimeoutMs); };
    arm();
    const both = signal ? AbortSignal.any([signal, idle.signal]) : idle.signal;
    let res;
    try {
      try { res = await fetchImpl(`${base}/chat/completions`, { method: "POST", headers, body: payload, signal: both }); }
      catch (e) {
        if (signal?.aborted) throw signal.reason ?? e;
        throw new GeminiError("server", idle.signal.aborted ? "ARC didn't answer in time." : `ARC is unreachable: ${e?.message ?? e}`, { via: "arc" });
      }
      if (!res.ok) throw await failure(res);
      if (!res.body) throw new GeminiError("other", "ARC returned an unreadable response.", { via: "arc" });
      const route = routeOf(res);
      let text = "", finish = null, usage = null;
      const calls = [];
      const take = (line) => {
        if (!line.startsWith("data:")) return;
        const raw = line.slice(5).trim();
        if (!raw || raw === "[DONE]") return;
        let chunk;
        try { chunk = JSON.parse(raw); } catch { throw new GeminiError("other", "ARC returned an unreadable response.", { via: "arc" }); }
        if (chunk?.error) throw classifyArc(Number(chunk.error.status) || 502, chunk);
        if (chunk.usage) usage = chunk.usage;
        const c = chunk.choices?.[0];
        if (!c) return;
        if (c.finish_reason) finish = c.finish_reason;
        const d = c.delta ?? {};
        if (typeof d.content === "string" && d.content) { text += d.content; onText(d.content); }
        for (const t of d.tool_calls ?? []) {
          const i = Number.isInteger(t.index) ? t.index : calls.length;
          calls[i] ??= { id: undefined, type: "function", function: { name: "", arguments: "" } };
          if (t.id) calls[i].id = t.id;
          if (t.function?.name) calls[i].function.name += t.function.name;
          if (t.function?.arguments) calls[i].function.arguments += t.function.arguments;
        }
      };
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        for (;;) {
          let step;
          try { step = await reader.read(); }
          catch (e) {
            if (signal?.aborted) throw signal.reason ?? e;
            throw new GeminiError("server", idle.signal.aborted ? "ARC stopped sending." : "ARC's stream broke off.", { via: "arc" });
          }
          if (step.done) break;
          arm();
          buffer += decoder.decode(step.value, { stream: true });
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop();
          for (const line of lines) take(line);
        }
        take(buffer + decoder.decode());
      } finally { reader.cancel().catch(() => {}); }
      const message = { content: text || null, tool_calls: calls.filter(Boolean) };
      return fromOpenAI({ choices: [{ message, finish_reason: finish }], usage }, route);
    } finally { clearTimeout(timer); }
  }

  /**
   * A text's meaning as numbers, for search by meaning. Pinned to one model (Gemini's, by
   * default) so vectors saved earlier stay comparable with new ones: ARC never swaps an
   * explicitly named model for another.
   */
  async function embed(text, { dims = 512, onRequest = () => {} } = {}) {
    onRequest();
    const { res } = await post("/embeddings", JSON.stringify({ model: embedModel, input: String(text).slice(0, 8000), dimensions: dims }), undefined, 15_000);
    if (!res.ok) throw await failure(res);
    const data = await res.json().catch(() => ({}));
    const values = data?.data?.[0]?.embedding;
    if (!Array.isArray(values) || values.length !== dims || !values.every(Number.isFinite)) throw new GeminiError("other", "No embedding came back.", { via: "arc" });
    return values;
  }

  /** The model names this ARC key may use. */
  async function listModels() {
    const res = await fetchImpl(`${base}/models`, { headers: { authorization: headers.authorization }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw await failure(res);
    const data = await res.json().catch(() => ({}));
    return (Array.isArray(data.data) ? data.data : []).map((m) => String(m?.id ?? "")).filter(Boolean);
  }

  // ARC does the model and key fallback itself, so Echo's own model rotation is off.
  return { via: "arc", model, embedModel, agentModel: null, generate, generateStream, embed, listModels, browseModel: null, browseModels: [], fallbackModels: [] };
}
