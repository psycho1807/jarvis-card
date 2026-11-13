// Jarvis card – talk to Home Assistant Assist with an animated reactor ring.
// Part of the WallDock project: https://github.com/psycho1807/WallDock
// License: GPL-3.0
const JARVIS_VERSION = '1.0.0';
const JARVIS_TEXT = {
  fr: { tap: 'TOUCHEZ POUR PARLER', listen: 'JE VOUS ÉCOUTE…', think: 'JE RÉFLÉCHIS…', mic: 'Micro refusé : autorisez le micro pour cette app.', conn: 'Impossible de joindre Assist.', none: "Je n'ai rien entendu.", err: 'Erreur', q: (t) => `« ${t} »` },
  en: { tap: 'TAP TO SPEAK', listen: 'LISTENING…', think: 'THINKING…', mic: 'Microphone blocked: allow the microphone for this app.', conn: 'Cannot reach Assist.', none: "I didn't hear anything.", err: 'Error', q: (t) => `“${t}”` },
};
console.info(`%c JARVIS-CARD %c ${JARVIS_VERSION} `, 'color:#02060c;background:#3fd4ff;font-weight:700', 'color:#3fd4ff;background:#02060c');
class JarvisCard extends HTMLElement {
  setConfig(config) {
    this._config = config || {};
  }
  getCardSize() { return 12; }

  set hass(hass) {
    this._hass = hass;
    if (!this._built) this._build();
  }

  _build() {
    this._built = true;
    this._mode = 'idle';
    this._level = 0;
    this._smooth = 0;
    this._convId = null;
    const root = this.shadowRoot || this.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        :host { display:block; }
        .wrap { position:relative; min-height:calc(100vh - var(--header-height, 56px) - env(safe-area-inset-bottom)); background:#02060c;
          display:flex; flex-direction:column; align-items:center; justify-content:center; padding:24px 28px; box-sizing:border-box;
          font-family:-apple-system, Roboto, sans-serif; -webkit-user-select:none; user-select:none; cursor:pointer; text-align:center; }
        .title { color:#3fd4ff; font-weight:700; font-size:13px; letter-spacing:.5em; }
        canvas { width:min(70vw, 300px); height:min(70vw, 300px); margin:18px 0; }
        .status { color:#7f9bc4; font-size:15px; letter-spacing:.15em; min-height:20px; }
        .q { color:#b0c4e0; font-style:italic; font-size:18px; margin-top:16px; line-height:1.3; }
        .a { color:#fff; font-size:21px; margin-top:12px; line-height:1.35; text-shadow:0 0 10px rgba(63,212,255,.5); max-width:640px; }
      </style>
      <div class="wrap">
        <div class="title"></div>
        <canvas></canvas>
        <div class="status"></div>
        <div class="q"></div>
        <div class="a"></div>
      </div>`;
    this._wrap = root.querySelector('.wrap');
    this._canvas = root.querySelector('canvas');
    this._status = root.querySelector('.status');
    this._q = root.querySelector('.q');
    this._a = root.querySelector('.a');
    root.querySelector('.title').textContent = this._config.title || 'J.A.R.V.I.S.';
    this._player = new Audio();
    this._player.setAttribute('playsinline', '');
    this._wrap.addEventListener('click', () => this._tap());
    this._setStatus(this._t('tap'));
    this._t0 = performance.now();
    const loop = () => { this._draw(); this._raf = requestAnimationFrame(loop); };
    loop();
  }

  connectedCallback() {
    if (!this._built && this._hass) this._build();
  }

  _t(k) {
    const lang = ((this._hass && (this._hass.locale && this._hass.locale.language || this._hass.language)) || 'en').slice(0, 2);
    return (JARVIS_TEXT[lang] || JARVIS_TEXT.en)[k];
  }

  disconnectedCallback() {
    this._stopMic();
    if (this._raf) cancelAnimationFrame(this._raf);
    this._built = false;
    if (this.shadowRoot) this.shadowRoot.innerHTML = '';
  }

  _setStatus(t) { this._status.textContent = t; }

  _tap() {
    // iOS : le son et le micro doivent être débloqués par un toucher
    if (!this._unlocked) {
      this._unlocked = true;
      this._player.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
      this._player.play().catch(() => {});
    }
    if (this._mode === 'listening') { this._endAudio(); return; }
    if (this._mode === 'speaking') { this._continue = false; this._player.pause(); this._finish(); return; }
    if (this._mode === 'thinking') return;
    this._convId = null;
    this._listen();
  }

  async _listen() {
    this._mode = 'listening';
    this._q.textContent = '';
    this._a.textContent = '';
    this._setStatus(this._t('listen'));
    try {
      if (!this._stream) {
        this._stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      }
      if (!this._ctx) this._ctx = new (window.AudioContext || window.webkitAudioContext)();
      if (this._ctx.state === 'suspended') await this._ctx.resume();
    } catch (e) {
      return this._error(this._t('mic'));
    }
    this._handler = null;
    this._pending = [];
    this._audioDone = false;
    const msg = {
      type: 'assist_pipeline/run', start_stage: 'stt', end_stage: 'tts',
      input: { sample_rate: 16000 },
    };
    if (this._config.pipeline) msg.pipeline = this._config.pipeline;
    if (this._convId) msg.conversation_id = this._convId;
    try {
      this._unsub = await this._hass.connection.subscribeMessage((ev) => this._event(ev), msg);
    } catch (e) {
      return this._error(this._t('conn'));
    }
    this._startMic();
  }

  _startMic() {
    const ctx = this._ctx;
    this._src = ctx.createMediaStreamSource(this._stream);
    this._proc = ctx.createScriptProcessor(4096, 1, 1);
    const ratio = ctx.sampleRate / 16000;
    this._proc.onaudioprocess = (e) => {
      if (this._mode !== 'listening' || this._audioDone) return;
      const input = e.inputBuffer.getChannelData(0);
      let sum = 0;
      for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
      this._level = Math.min(1, Math.sqrt(sum / input.length) * 6);
      const n = Math.floor(input.length / ratio);
      const pcm = new Int16Array(n);
      for (let i = 0; i < n; i++) {
        const s = Math.max(-1, Math.min(1, input[Math.floor(i * ratio)]));
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      this._send(pcm);
    };
    this._src.connect(this._proc);
    this._proc.connect(ctx.destination);
    // Sécurité : pas plus de 15 s d'écoute
    clearTimeout(this._maxTimer);
    this._maxTimer = setTimeout(() => this._endAudio(), 15000);
  }

  _send(pcm) {
    if (this._handler === null) { this._pending.push(pcm); return; }
    const buf = new Uint8Array(1 + pcm.byteLength);
    buf[0] = this._handler;
    buf.set(new Uint8Array(pcm.buffer), 1);
    try { this._hass.connection.socket.send(buf); } catch (e) { /* connexion perdue */ }
  }

  _endAudio() {
    if (this._audioDone) return;
    this._audioDone = true;
    clearTimeout(this._maxTimer);
    this._stopProc();
    if (this._handler !== null) {
      try { this._hass.connection.socket.send(new Uint8Array([this._handler])); } catch (e) {}
    }
    if (this._mode === 'listening') { this._mode = 'thinking'; this._setStatus(this._t('think')); }
  }

  _stopProc() {
    try { this._proc && this._proc.disconnect(); this._src && this._src.disconnect(); } catch (e) {}
    this._proc = null; this._src = null; this._level = 0;
  }

  _stopMic() {
    this._stopProc();
    if (this._stream) { this._stream.getTracks().forEach((t) => t.stop()); this._stream = null; }
  }

  _event(ev) {
    const d = ev.data || {};
    switch (ev.type) {
      case 'run-start':
        this._handler = d.runner_data && d.runner_data.stt_binary_handler_id;
        if (this._handler === undefined) this._handler = null;
        if (this._handler !== null) { const p = this._pending; this._pending = []; p.forEach((x) => this._send(x)); }
        break;
      case 'stt-vad-end':
        this._endAudio();
        break;
      case 'stt-end':
        this._endAudio();
        this._q.textContent = d.stt_output && d.stt_output.text ? this._t('q')(d.stt_output.text) : '';
        break;
      case 'intent-end': {
        const out = d.intent_output || {};
        if (out.conversation_id) this._convId = out.conversation_id;
        this._continue = !!out.continue_conversation;
        const sp = out.response && out.response.speech;
        this._a.textContent = (sp && sp.plain && sp.plain.speech) || '';
        break;
      }
      case 'tts-end': {
        const url = d.tts_output && d.tts_output.url;
        if (url) this._speak(this._hass.hassUrl(url));
        break;
      }
      case 'run-end':
        this._cleanupRun();
        if (this._mode === 'thinking') this._finish();
        break;
      case 'error':
        this._cleanupRun();
        this._error(d.code === 'stt-no-text-recognized' ? this._t('none') : (d.message || this._t('err')));
        break;
    }
  }

  _cleanupRun() {
    this._endAudio();
    if (this._unsub) { const u = this._unsub; this._unsub = null; try { u(); } catch (e) {} }
  }

  _speak(url) {
    this._mode = 'speaking';
    this._setStatus('');
    this._player.onended = () => this._finish();
    this._player.onerror = () => this._finish();
    this._player.src = url;
    this._player.play().catch(() => this._finish());
  }

  _finish() {
    if (this._continue && this._mode === 'speaking') { this._continue = false; this._listen(); return; }
    this._mode = 'idle';
    this._setStatus(this._t('tap'));
  }

  _error(text) {
    this._stopProc();
    this._mode = 'error';
    this._setStatus(text);
    clearTimeout(this._errTimer);
    this._errTimer = setTimeout(() => { if (this._mode === 'error') { this._mode = 'idle'; this._setStatus(this._t('tap')); } }, 4000);
  }

  _draw() {
    const c = this._canvas;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    if (!w) return;
    if (c.width !== w * dpr) { c.width = w * dpr; c.height = h * dpr; }
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const t = (performance.now() - this._t0) / 1000;
    const cx = w / 2, cy = h / 2, R = Math.min(w, h) / 2;
    const mode = this._mode;
    const col = { listening: [63, 212, 255], thinking: [255, 179, 71], speaking: [77, 217, 255], error: [255, 59, 78], idle: [63, 212, 255] }[mode];
    const rgba = (a) => `rgba(${col[0]},${col[1]},${col[2]},${a})`;
    this._smooth += (this._level - this._smooth) * 0.3;
    const s = this._smooth;
    let energy;
    if (mode === 'listening') energy = 0.25 + s * 0.75;
    else if (mode === 'thinking') energy = 0.35 + 0.15 * Math.sin(t * 6);
    else if (mode === 'speaking') { const v = (Math.sin(t * 9) + Math.sin(t * 13.7)) / 2; energy = 0.45 + 0.35 * v * v; }
    else if (mode === 'idle') energy = 0.15 + 0.05 * Math.sin(t * 1.5);
    else energy = 0.3;

    const core = R * (0.30 + 0.12 * energy);
    const grad = g.createRadialGradient(cx, cy, 0, cx, cy, core * 2.2);
    grad.addColorStop(0, rgba(0.9)); grad.addColorStop(0.45, rgba(0.27)); grad.addColorStop(1, rgba(0));
    g.fillStyle = grad;
    g.beginPath(); g.arc(cx, cy, core * 2.2, 0, Math.PI * 2); g.fill();

    g.strokeStyle = rgba(0.35); g.lineWidth = R * 0.01;
    [0.62, 0.95].forEach((k) => { g.beginPath(); g.arc(cx, cy, R * k, 0, Math.PI * 2); g.stroke(); });

    const speed = { thinking: 220, listening: 60 + 160 * s, speaking: 90, error: 15, idle: 25 }[mode];
    g.lineCap = 'round';
    for (let i = 0; i < 3; i++) {
      const r = R * (0.72 + i * 0.1);
      g.lineWidth = R * (0.035 - i * 0.008);
      g.strokeStyle = rgba((255 - i * 60) / 255);
      const dir = i % 2 === 0 ? 1 : -1;
      const ang = ((t * speed * dir * (1 + i * 0.3)) % 360) * Math.PI / 180;
      const sweep = (50 + 40 * energy + i * 10) * Math.PI / 180;
      for (let k = 0; k < 3; k++) {
        const a0 = ang + k * 2 * Math.PI / 3;
        g.beginPath(); g.arc(cx, cy, r, a0, a0 + sweep); g.stroke();
      }
    }
    g.lineWidth = R * 0.012; g.strokeStyle = rgba(0.55);
    for (let i = 0; i < 48; i++) {
      const a = i * 2 * Math.PI / 48 + t * 0.2;
      const inner = R * 0.97, outer = R * (0.99 + (i % 4 === 0 ? 0.01 : 0));
      g.beginPath();
      g.moveTo(cx + inner * Math.cos(a), cy + inner * Math.sin(a));
      g.lineTo(cx + outer * Math.cos(a), cy + outer * Math.sin(a));
      g.stroke();
    }
  }
}
if (!customElements.get('jarvis-card')) customElements.define('jarvis-card', JarvisCard);
window.customCards = window.customCards || [];
window.customCards.push({ type: 'jarvis-card', name: 'Jarvis', description: 'Talk to Assist with an animated reactor ring (WallDock)', preview: false, documentationURL: 'https://github.com/psycho1807/jarvis-card' });
