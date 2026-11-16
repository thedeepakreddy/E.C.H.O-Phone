/** The bundled orb engine reproduces the library's own reference geometry for every state and size. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import "../public/vendor/thinking-orbs.js";

const golden = JSON.parse(readFileSync(new URL("./thinking-orbs-golden.json", import.meta.url)));
const { MODE_FRAMES, resolvePreset, STATE_TO_MODE } = globalThis.ThinkingOrbsEngine;

test("all nine states at both sizes resolve to the library's tuning", () => {
  assert.equal(Object.keys(STATE_TO_MODE).length, 9);
  for (const [key, want] of Object.entries(golden.resolved)) {
    const [state, size] = key.split("-");
    assert.deepEqual(resolvePreset(state, Number(size)), want, key);
  }
});

test("every frame matches the reference geometry dot for dot", () => {
  const close = (a, b, label) => assert.ok(Math.abs(a - b) <= golden.tolerance, `${label}: ${a} vs ${b}`);
  for (const c of golden.cases) {
    const { mode, opts } = resolvePreset(c.state, c.size);
    const frame = MODE_FRAMES[mode](c.size, c.t, opts);
    assert.equal(frame.dots.length, c.dotCount, c.key);
    assert.equal(frame.lines.length, c.lineCount, c.key);
    frame.dots.forEach((d, i) => [d.x, d.y, d.z, d.r, d.white, d.a ?? 1].forEach((v, k) => close(v, c.dots[i * 6 + k], `${c.key} dot ${i}`)));
    frame.lines.forEach((l, i) => [l.x1, l.y1, l.x2, l.y2, l.white, l.a ?? 1, l.w].forEach((v, k) => close(v, c.lines[i * 7 + k], `${c.key} line ${i}`)));
  }
});
