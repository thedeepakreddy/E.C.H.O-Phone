/* Live voice: a real conversation with Echo through Gemini Live.
   The microphone streams straight to Google over one WebSocket and Echo's
   voice streams back, so there is no record–upload–wait–read-aloud cycle and
   the user can interrupt. The relay only hands out a short-lived token (which
   seals Echo's instructions and tools), runs the tools Echo asks for, and
   saves each finished exchange. Audio is sent only while a session is open. */
(() => {
  const ENDPOINT = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained";
  const INPUT_RATE = 16000;

  /** Microphone samples (any rate, -1..1) to 16-bit PCM at 16 kHz, averaging so high tones don't alias. */
  class Downsampler {
    constructor(from, to = INPUT_RATE) {
      // A microphone slower than 16 kHz is sent as it is, at its own stated rate.
      this.rate = from > to ? to : from;
      this.step = from / this.rate;
      this.position = 0; this.sum = 0; this.count = 0;
    }
    push(frame) {
      const out = new Int16Array(Math.ceil(frame.length / this.step) + 1);
      let n = 0;
      for (let i = 0; i < frame.length; i++) {
        this.sum += frame[i]; this.count++; this.position++;
        if (this.position < this.step) continue;
        this.position -= this.step;
        const sample = Math.max(-1, Math.min(1, this.sum / this.count));
        out[n++] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
        this.sum = 0; this.count = 0;
      }
      return out.subarray(0, n);
    }
  }
  function toBase64(bytes) {
    let text = "";
    for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(text);
  }
  function fromBase64(text) {
    const raw = atob(text), bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return bytes;
  }

  /** Echo's voice: PCM pieces queued back to back on one audio clock, dropped at once when interrupted. */
  class Player {
    constructor(context) { this.context = context; this.cursor = 0; this.sources = new Set(); this.onIdle = null; }
    get playing() { return this.sources.size > 0; }
    play(bytes, rate = 24000) {
      const samples = bytes.length >> 1;
      if (!samples) return;
      const view = new DataView(bytes.buffer, bytes.byteOffset, samples * 2);
      const buffer = this.context.createBuffer(1, samples, rate), channel = buffer.getChannelData(0);
      for (let i = 0; i < samples; i++) channel[i] = view.getInt16(i * 2, true) / 0x8000;
      const source = this.context.createBufferSource();
      source.buffer = buffer; source.connect(this.context.destination);
      const at = Math.max(this.context.currentTime + .02, this.cursor);
      this.cursor = at + buffer.duration;
      this.sources.add(source);
      source.onended = () => { this.sources.delete(source); if (!this.sources.size) this.onIdle?.(); };
      source.start(at);
    }
    flush() {
      for (const source of this.sources) { source.onended = null; try { source.stop(); } catch { /* not started yet */ } }
      this.sources.clear(); this.cursor = 0;
    }
    close() { this.flush(); this.context.close?.().catch?.(() => {}); }
  }

  const readMessage = async (data) => JSON.parse(typeof data === "string" ? data : data instanceof ArrayBuffer ? new TextDecoder().decode(data) : await data.text());

  class Session {
    /**
     * acquire(onFrame, onError) → { rate, close }   the microphone
     * begin() → { token, model }                    a fresh token from the relay
     * tool({ id, name, args }) → response           a tool Echo asked for, run by the relay
     * onTurn({ user, echo, interrupted })           one finished exchange, as text
     */
    constructor({ acquire, begin, tool, onTurn, onState, onError, onCaption, onHeard,
      socket = (url) => new WebSocket(url),
      output = () => new Player(new (globalThis.AudioContext || globalThis.webkitAudioContext)()),
      connectTimeoutMs = 12000, now = Date.now }) {
      Object.assign(this, { acquire, begin, tool, onTurn, onState, onError, onCaption, onHeard, socket, output, connectTimeoutMs, now });
      this.state = "off"; this.generation = 0; this.ready = false;
    }
    get active() { return this.state !== "off"; }
    phase(state) { if (state === this.state) return; this.state = state; this.onState?.(state); }

    async start() {
      if (this.active) return;
      const generation = ++this.generation;
      const current = () => generation === this.generation;
      this.ready = false; this.reconnects = 0; this.heard = ""; this.said = ""; this.interrupted = false; this.turnOpen = false; this.expiring = false;
      this.phase("starting");
      try {
        // Made inside the tap that started this, so the phone lets it play sound later.
        this.out = this.output();
        this.out.onIdle = () => { if (current() && this.state === "speaking" && !this.turnOpen) this.phase("listening"); };
        await this.out.context?.resume?.();
        // Microphone permission and the token are asked for together; whichever fails, the other is released.
        const [mic, grant] = await Promise.allSettled([
          this.acquire((samples) => { if (current()) this.frame(samples); }, (error) => { if (current()) this.fail(error); }),
          this.begin(),
        ]);
        if (mic.status === "fulfilled") { if (!current()) return void mic.value.close(); this.mic = mic.value; }
        if (mic.status === "rejected") throw mic.reason;
        if (grant.status === "rejected") throw grant.reason;
        if (!current()) return;
        this.down = new Downsampler(this.mic.rate);
        await this.connect(grant.value, current);
        if (!current()) return;
        this.ready = true;
        this.phase("listening");
      } catch (error) { if (current()) this.fail(error); }
    }

    /** Opens the socket and waits for Google to accept the session the token describes. */
    connect(grant, current) {
      return new Promise((resolve, reject) => {
        const ws = this.socket(`${ENDPOINT}?access_token=${encodeURIComponent(grant.token)}`);
        ws.binaryType = "arraybuffer";
        let settled = false;
        const refuse = (error) => { if (settled) return; settled = true; clearTimeout(timer); try { ws.close(); } catch { /* already closed */ } reject(error); };
        const timer = setTimeout(() => refuse(new Error("Live voice took too long to connect.")), this.connectTimeoutMs);
        ws.onopen = () => ws.send(JSON.stringify({ setup: { model: `models/${grant.model}` } }));
        ws.onerror = () => refuse(new Error("Couldn't connect to live voice."));
        ws.onclose = () => {
          if (!settled) return refuse(new Error("Live voice refused the connection."));
          if (current() && this.ws === ws) this.dropped(current);
        };
        ws.onmessage = async (event) => {
          let message;
          try { message = await readMessage(event.data); } catch { return; }
          if (!current()) return;
          if (!settled) {
            if (!message.setupComplete) return;
            settled = true; clearTimeout(timer);
            this.ws = ws; this.openedAt = this.now();
            return resolve();
          }
          if (this.ws === ws) this.receive(message, current);
        };
      });
    }

    frame(samples) {
      if (!this.ready || !this.ws || this.ws.readyState !== 1 || !samples.length) return;
      const pcm = this.down.push(samples);
      if (!pcm.length) return;
      this.ws.send(JSON.stringify({ realtimeInput: { audio: { data: toBase64(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)), mimeType: `audio/pcm;rate=${this.down.rate}` } } }));
    }

    receive(message, current) {
      const content = message.serverContent;
      if (content) {
        if (content.inputTranscription?.text) { this.heard += content.inputTranscription.text; this.onHeard?.(this.heard); }
        if (content.interrupted) { this.out.flush(); this.interrupted = true; this.phase("listening"); }
        for (const part of content.modelTurn?.parts ?? []) {
          if (!part.inlineData?.data) continue;
          const rate = Number(/rate=(\d+)/.exec(part.inlineData.mimeType ?? "")?.[1]) || 24000;
          this.turnOpen = true;
          this.out.play(fromBase64(part.inlineData.data), rate);
          this.phase("speaking");
        }
        if (content.outputTranscription?.text) { this.said += content.outputTranscription.text; this.onCaption?.(this.said); }
        if (content.turnComplete) this.finishTurn(current);
      }
      if (message.toolCall?.functionCalls?.length) void this.runTools(message.toolCall.functionCalls, current);
      // Google ends a session after a while and says so first: carry on in a new one between turns.
      if (message.goAway) { this.expiring = true; if (!this.turnOpen && !this.out.playing) void this.reconnect(current); }
    }

    async runTools(calls, current) {
      if (this.state === "listening") this.phase("thinking");
      const ws = this.ws;
      const functionResponses = await Promise.all(calls.map(async (call) => {
        let response;
        try { response = await this.tool({ id: call.id, name: call.name, args: call.args ?? {} }); }
        catch { response = { error: "That didn't work just now." }; }
        return { id: call.id, name: call.name, response: response && typeof response === "object" ? response : { result: response ?? null } };
      }));
      if (current() && this.ws === ws && ws.readyState === 1) ws.send(JSON.stringify({ toolResponse: { functionResponses } }));
    }

    finishTurn(current) {
      const turn = { user: this.heard.trim(), echo: this.said.trim(), interrupted: this.interrupted };
      this.heard = ""; this.said = ""; this.interrupted = false; this.turnOpen = false;
      if (turn.echo) Promise.resolve().then(() => this.onTurn?.(turn)).catch(() => {});
      if (!current()) return;
      if (!this.out.playing && this.state !== "off") this.phase("listening");
      if (this.expiring) void this.reconnect(current);
    }

    /** A new session with a new token; the relay puts what was just said into its instructions. */
    async reconnect(current) {
      if (this.reconnecting) return;
      this.reconnecting = true; this.expiring = false;
      const old = this.ws; this.ws = null;
      try { old?.close(); } catch { /* already closed */ }
      try {
        const grant = await this.begin();
        if (!current()) return;
        await this.connect(grant, current);
      } catch (error) { if (current()) this.fail(error); }
      finally { this.reconnecting = false; }
    }
    dropped(current) {
      this.ws = null;
      // A session that had been working is resumed quietly, twice at most; one that never settled is an error.
      if (this.now() - this.openedAt > 20_000 && this.reconnects++ < 2) return void this.reconnect(current);
      this.fail(new Error("Live voice disconnected. Tap Listen to continue."));
    }

    stop() {
      if (!this.active) return;
      const current = () => false;
      // Whatever Echo had said so far is still part of the conversation.
      if (this.said.trim()) { this.interrupted = true; this.finishTurn(current); }
      ++this.generation; this.ready = false;
      const ws = this.ws; this.ws = null;
      try { ws?.close(); } catch { /* already closed */ }
      this.mic?.close(); this.mic = null;
      this.out?.close(); this.out = null;
      this.phase("off");
    }
    fail(error) {
      const beforeReady = !this.ready;
      this.stop();
      this.onError?.(Object.assign(error instanceof Error ? error : new Error(String(error)), { beforeReady }));
    }
  }
  globalThis.EchoLive = { Session, Downsampler, Player, toBase64, fromBase64, ENDPOINT };
})();
