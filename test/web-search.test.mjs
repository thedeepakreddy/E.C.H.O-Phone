/** Echo's own live web search: real Bing markup, merging, failure handling, and chat using it. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseBing, parseBingNews, parseDuckDuckGo, parseWikipedia, realUrl, wantsNews, webSearch } from "../lib/web-search.mjs";
import { deriveKeys } from "../lib/secure.js";
import { createStore } from "../lib/store.js";
import { createCloud, systemPrompt, toolDetail } from "../lib/cloud.js";

const NOW = Date.parse("2026-11-16T12:00:00Z");
const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const page = (body, type = "text/html") => ({ status: 200, headers: { "content-type": type }, body: Buffer.from(body) });

test("real Bing results and Bing News cards are read: title, page, snippet, source and date", () => {
  assert.deepEqual(parseBing(fixture("bing-results.html")).map((r) => [r.title, r.url]), [
    ["iPhone - Apple", "https://www.apple.com/iphone/"],
    ["iPhone: New Apple iPhones & Accessories - Best Buy", "https://www.bestbuy.com/site/mobile-cell-phones/iphone/pcmcat305200050000.c?id=pcmcat305200050000%2F"],
  ]);
  assert.match(parseBing(fixture("bing-results.html"))[0].snippet, /^Meet your new iPhone/);
  const news = parseBingNews(fixture("bing-news.html"), NOW);
  assert.deepEqual(news.map((r) => [r.source, r.date, r.url]), [
    ["Forbes", "2026-11-14", "https://www.forbes.com/sites/davidphelan/2026/11/14/apple-iphone-18-release-new-later-date-enters-the-schedule/"],
    ["IGN", "2026-11-16", "https://www.ign.com/articles/t-mobiles-apple-iphone-18-pro-on-us-black-friday-deal-explained"],
  ], "the news click-tracking link is unwrapped to the article; '2d' becomes a date");
});

test("tracking links become the real page; search engines' own pages are dropped", () => {
  const target = "https://example.org/a?b=1";
  assert.equal(realUrl(`https://www.bing.com/ck/a?u=a1${Buffer.from(target).toString("base64url")}`), target);
  assert.equal(realUrl(`//duckduckgo.com/l/?uddg=${encodeURIComponent(target)}`, "https://duckduckgo.com/"), target);
  assert.equal(realUrl("https://www.bing.com/search?q=x"), null);
  assert.equal(realUrl("javascript:alert(1)"), null);
  assert.deepEqual(parseDuckDuckGo('<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2F">Example</a><a class="result__snippet">Hello</a></div><div class="result result--ad"><a class="result__a" href="https://ad.example">Ad</a></div>'),
    [{ title: "Example", url: "https://example.org/", snippet: "Hello", engine: "duckduckgo" }]);
  assert.equal(parseWikipedia({ query: { search: [{ title: "Photosynthesis", snippet: "<span>Process</span> of plants", timestamp: "2026-11-14T00:00:00Z" }] } })[0].url, "https://en.wikipedia.org/wiki/Photosynthesis");
});

test("engines are asked together; results interleave, repeats drop out, and recent questions put dated news first", async () => {
  const asked = [];
  const fetchPage = async ({ url }) => {
    asked.push(new URL(url).hostname + new URL(url).pathname);
    if (url.includes("/news/search")) return page(fixture("bing-news.html"));
    if (url.includes("bing.com/search")) return page(fixture("bing-results.html"));
    if (url.includes("wikipedia")) return page(JSON.stringify({ query: { search: [{ title: "IPhone", snippet: "Apple phone" }] } }), "application/json");
    throw new Error("connection reset");
  };
  const r = await webSearch("latest iPhone news", { fetchPage, now: () => NOW });
  assert.equal(asked.length, 4);
  assert.deepEqual(r.engines, { news: "ok", bing: "ok", duckduckgo: "unavailable", wikipedia: "ok" });
  assert.deepEqual(r.results.map((x) => x.engine), ["news", "bing", "wikipedia", "news", "bing"]);
  assert.equal(r.results[0].source, "Forbes");
  assert.equal(r.results[1].source, "apple.com", "a result without a named source shows its site");
  const plain = await webSearch("what is photosynthesis", { fetchPage, now: () => NOW });
  assert.deepEqual(Object.keys(plain.engines).sort(), ["bing", "duckduckgo", "wikipedia"], "no news for a timeless question");
  assert.ok(wantsNews("who won the match today") && wantsNews("iOS 27 release date") && !wantsNews("how do plants grow"));
  const none = await webSearch("anything", { fetchPage: async () => { throw new Error("down"); }, now: () => NOW });
  assert.equal(none.status, "unavailable");
  assert.match(none.note, /Don't answer from memory/);
});

// ---- chat uses it ----
const text = (t) => ({ candidates: [{ content: { role: "model", parts: [{ text: t }] } }] });
const call = (name, args) => ({ candidates: [{ content: { role: "model", parts: [{ functionCall: { name, args } }] } }] });
const store = () => createStore({ key: deriveKeys("s".repeat(48)).store, now: () => NOW });

test("chat searches the live web itself, never Gemini's Google Search, and keeps the sources", async () => {
  const seen = [], events = [];
  const gemini = { model: "gemini-3.8-flash", generate: async (body) => { seen.push(structuredClone(body)); return seen.length === 1 ? call("web_search", { query: "iPhone 18 release date" }) : text("Apple's schedule moved, per Forbes (14 Nov 2026)."); } };
  const searchFetch = async ({ url }) => url.includes("/news/search") ? page(fixture("bing-news.html")) : url.includes("bing.com/search") ? page(fixture("bing-results.html")) : { status: 503, headers: {}, body: Buffer.from("") };
  const cloud = createCloud({ gemini, store: store(), now: () => NOW, tools: { searchFetch } });
  const r = await cloud.chat({ history: [], text: "When is the iPhone 18 coming out?", context: { tz: "UTC" }, onStream: (e) => events.push(e) });
  assert.equal(seen.length, 2, "no separate Google Search request to Gemini");
  assert.ok(!seen.some((b) => b.tools?.some((t) => t.google_search)));
  const results = seen[1].contents.at(-1).parts[0].functionResponse.response.results;
  assert.equal(results[0].source, "Forbes");
  assert.equal(r.sources[0].url, "https://www.forbes.com/sites/davidphelan/2026/11/14/apple-iphone-18-release-new-later-date-enters-the-schedule/");
  assert.deepEqual(events.find((e) => e.type === "tool"), { type: "tool", name: "web_search", detail: "iPhone 18 release date" });
  assert.match(seen[0].systemInstruction.parts[0].text, /You have live internet access/);
});

test("when no engine answers, a key with paid Google Search still can; otherwise Echo is told to say so", async () => {
  const down = async () => { throw new Error("down"); };
  const grounded = { candidates: [{ content: { role: "model", parts: [{ text: "Grounded answer" }] }, groundingMetadata: { groundingChunks: [{ web: { uri: "https://g.example", title: "G" } }] } }] };
  let n = 0;
  const gemini = { model: "m", generate: async (body) => body.tools?.some((t) => t.google_search) ? grounded : ++n === 1 ? call("web_search", { query: "x" }) : text("done") };
  const cloud = createCloud({ gemini, store: store(), now: () => NOW, tools: { searchFetch: down } });
  const r = await cloud.chat({ history: [], text: "x", context: {} });
  assert.deepEqual(r.sources.map((s) => s.url), ["https://g.example"]);
  let m = 0;
  const failing = { model: "m", generate: async (body) => { if (body.tools?.some((t) => t.google_search)) { const e = new Error("Search not on free tier"); throw Object.assign(e, { name: "GeminiError" }); } return ++m === 1 ? call("web_search", { query: "x" }) : text("done"); } };
  const seen = [];
  const cloud2 = createCloud({ gemini: { ...failing, generate: async (b) => { seen.push(structuredClone(b)); return failing.generate(b); } }, store: store(), now: () => NOW, tools: { searchFetch: down } });
  await cloud2.chat({ history: [], text: "x", context: {} });
  assert.match(JSON.stringify(seen.at(-1).contents.at(-1)), /No search engine answered just now/);
});

test("the phone's status line names the search or the site, never page text", () => {
  assert.equal(toolDetail({ name: "web_search", args: { query: "  latest   iPhone news " } }), "latest iPhone news");
  assert.equal(toolDetail({ name: "read_web_page", args: { url: "https://www.macrumors.com/2026/11/16/x" } }), "macrumors.com");
  assert.equal(toolDetail({ name: "save_memory", args: { text: "secret" } }), null);
  assert.match(systemPrompt({ tz: "UTC" }, NOW), /call web_search first, then read_web_page/);
});

test("off-topic results send a second, shorter search; a slow engine doesn't hold up the answer", async () => {
  const asked = [];
  const bing = (title, url) => `<li class="b_algo"><div class="b_algoheader"><a href="${url}"><h2>${title}</h2></a></div></li>`;
  const fetchPage = async ({ url }) => {
    const u = new URL(url);
    if (u.hostname === "html.duckduckgo.com") return new Promise(() => {}); // never answers
    if (u.hostname === "en.wikipedia.org") return page(JSON.stringify({ query: { search: [] } }), "application/json");
    asked.push(u.searchParams.get("q"));
    return page(u.searchParams.get("q").startsWith("who")
      ? bing("WON Definition & Meaning", "https://dictionary.example/won") + bing("South Korean won", "https://wiki.example/won")
      : bing("2026 FIFA World Cup final - Wikipedia", "https://en.wikipedia.org/wiki/2026_FIFA_World_Cup_final"));
  };
  const started = Date.now();
  const r = await webSearch("who won the 2026 FIFA World Cup final", { fetchPage, now: () => NOW });
  assert.ok(Date.now() - started < 4000, "the silent engine is left behind");
  assert.deepEqual(asked, ["who won the 2026 FIFA World Cup final", "won 2026 fifa world cup final"]);
  assert.equal(r.results[0].url, "https://en.wikipedia.org/wiki/2026_FIFA_World_Cup_final", "the on-topic page comes first");
  assert.equal(r.engines.duckduckgo, "slow");
});
