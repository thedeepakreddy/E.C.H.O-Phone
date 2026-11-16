/* Echo's thinking orbs: <echo-orb state="searching" size="20">.
   A plain custom element over the thinking-orbs engine (public/vendor/thinking-orbs.js),
   doing what that library's React component does: one shared clock keeps every
   orb in phase, an orb pauses while offscreen or while the app is hidden, and
   reduced motion gets one still frame. Echo is a dark app, so the dots are
   light ink unless an ancestor says data-theme="light".

   States: working · searching · solving · listening · connecting · weaving ·
   composing · breathing · shaping. Sizes: 64 (a figure) and 20 (inline). */
(() => {
  const engine = globalThis.ThinkingOrbsEngine;
  if (!engine || typeof customElements === "undefined") return;
  const LABELS = { working: "Working", searching: "Searching", solving: "Solving", listening: "Listening", connecting: "Connecting",
    weaving: "Weaving", composing: "Writing", breathing: "Thinking", shaping: "Shaping" };
  const STATES = new Set(Object.keys(engine.STATE_TO_MODE));
  const reducedQuery = matchMedia("(prefers-reduced-motion: reduce)");

  class EchoOrb extends HTMLElement {
    static get observedAttributes() { return ["state", "size", "speed", "paused"]; }
    connectedCallback() {
      if (!this.canvas) {
        this.canvas = document.createElement("canvas");
        this.canvas.setAttribute("aria-hidden", "true");
        this.appendChild(this.canvas);
      }
      if (!this.hasAttribute("role")) this.setAttribute("role", "img");
      this.visible = true;
      this.io = new IntersectionObserver(([entry]) => { this.visible = entry.isIntersecting; this.schedule(); });
      this.io.observe(this);
      this.onEnv = () => this.setup();
      reducedQuery.addEventListener("change", this.onEnv);
      document.addEventListener("visibilitychange", this.onEnv);
      this.setup();
    }
    disconnectedCallback() {
      this.stop();
      this.io?.disconnect();
      reducedQuery.removeEventListener("change", this.onEnv);
      document.removeEventListener("visibilitychange", this.onEnv);
    }
    attributeChangedCallback() { if (this.isConnected && this.canvas) this.setup(); }
    get state() { const s = this.getAttribute("state"); return STATES.has(s) ? s : "breathing"; }
    set state(value) { if (value !== this.getAttribute("state")) this.setAttribute("state", value); }

    setup() {
      const state = this.state, size = Number(this.getAttribute("size")) === 64 ? 64 : 20;
      if (!this.hasAttribute("aria-label") || this.dataset.autoLabel) { this.setAttribute("aria-label", `${LABELS[state]}…`); this.dataset.autoLabel = "1"; }
      const dpr = Math.min(2, devicePixelRatio || 1);
      this.canvas.width = Math.round(size * dpr);
      this.canvas.height = Math.round(size * dpr);
      this.canvas.style.width = this.canvas.style.height = `${size}px`;
      this.ctx = this.canvas.getContext("2d");
      const { mode, speed, opts } = engine.resolvePreset(state, size);
      const draw = engine.MODE_DRAWS[mode], rate = speed * (Number(this.getAttribute("speed")) || 1);
      const dark = this.closest("[data-theme]")?.getAttribute("data-theme") !== "light";
      this.paint = (seconds) => {
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this.ctx.clearRect(0, 0, size, size);
        draw(this.ctx, size, seconds * rate, dark, opts);
      };
      this.still = reducedQuery.matches || this.hasAttribute("paused");
      // Reduced motion: the library's own representative still frame.
      this.paint(this.still ? 0.6 / rate : performance.now() / 1000);
      this.schedule();
    }
    schedule() {
      if (this.still || !this.visible || document.hidden) return this.stop();
      if (this.raf) return;
      const loop = () => { this.paint(performance.now() / 1000); this.raf = requestAnimationFrame(loop); };
      this.raf = requestAnimationFrame(loop);
    }
    stop() { cancelAnimationFrame(this.raf); this.raf = 0; }
  }
  if (!customElements.get("echo-orb")) customElements.define("echo-orb", EchoOrb);

  /** A new orb element: Orbs.make("searching", 20). */
  globalThis.EchoOrbs = Object.freeze({
    make(state, size = 20, label) {
      const orb = document.createElement("echo-orb");
      orb.setAttribute("state", state);
      orb.setAttribute("size", String(size));
      if (label) orb.setAttribute("aria-label", label);
      return orb;
    },
    states: [...STATES],
    /** Each specialist's way of working: Research searches, Analyse solves, Write composes, Plan shapes, Review weaves the threads together, Assist connects them. */
    forAgent(agent) {
      const key = String(agent?.profile || agent?.botId || agent?.id || agent?.name || agent || "").toLowerCase();
      return /research/.test(key) ? "searching" : /analy/.test(key) ? "solving" : /writ/.test(key) ? "composing" : /plan/.test(key) ? "shaping"
        : /review/.test(key) ? "weaving" : /assist|echo/.test(key) ? "connecting" : "working";
    },
  });
})();
