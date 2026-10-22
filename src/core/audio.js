/**
 * Звук целиком процедурный (WebAudio). Это осознанное решение под Яндекс Игры:
 * в архиве не должно быть тяжёлых ассетов, а лимит 100 МБ — жёсткий,
 * реальная цель indie-разработчика 5–20 МБ. Синтез занимает 0 байт.
 *
 * Важно: AudioContext создаётся только после жеста пользователя — иначе браузер
 * заблокирует звук, а на iOS он вообще не заведётся.
 */

export class Audio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.musicGain = null;
    this.sfxGain = null;
    this.enabled = true;
    this.musicEnabled = true;
    this._musicTimer = null;
    this._step = 0;
    this._noiseBuf = null;
    this._suspended = false;
  }

  /** Вызывается по первому пользовательскому жесту. */
  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      this.ctx = new AC();
    } catch {
      this.ctx = null;
      return;
    }

    this.master = this.ctx.createGain();
    this.master.gain.value = this.enabled ? 0.85 : 0;
    this.master.connect(this.ctx.destination);

    this.sfxGain = this.ctx.createGain();
    this.sfxGain.gain.value = 0.9;
    this.sfxGain.connect(this.master);

    this.musicGain = this.ctx.createGain();
    this.musicGain.gain.value = this.musicEnabled ? 0.22 : 0;
    this.musicGain.connect(this.master);

    // Белый шум — основа всех «ударных» эффектов.
    const len = Math.floor(this.ctx.sampleRate * 0.5);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    this._noiseBuf = buf;
  }

  setEnabled(on) {
    this.enabled = on;
    if (this.master) this.master.gain.value = on ? 0.85 : 0;
  }

  setMusicEnabled(on) {
    this.musicEnabled = on;
    if (this.musicGain) this.musicGain.gain.value = on ? 0.22 : 0;
  }

  /**
   * Пауза звука. Критично для Яндекс Игр: на время показа рекламы и при уходе
   * со вкладки игра обязана замолчать (GameplayAPI.stop + пауза аудио).
   */
  suspend() {
    if (!this.ctx || this._suspended) return;
    this._suspended = true;
    this.stopMusic();
    this.ctx.suspend().catch(() => {});
  }

  resume() {
    if (!this.ctx || !this._suspended) return;
    this._suspended = false;
    this.ctx.resume().catch(() => {});
  }

  _env(node, t0, peak, attack, decay) {
    const g = node.gain;
    g.cancelScheduledValues(t0);
    g.setValueAtTime(0.0001, t0);
    g.exponentialRampToValueAtTime(Math.max(0.0002, peak), t0 + attack);
    g.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
  }

  _tone(freq, type, peak, attack, decay, dest, freqEnd = null, delay = 0) {
    if (!this.ctx) return;
    const t0 = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (freqEnd !== null) osc.frequency.exponentialRampToValueAtTime(Math.max(20, freqEnd), t0 + attack + decay);
    this._env(g, t0, peak, attack, decay);
    osc.connect(g);
    g.connect(dest || this.sfxGain);
    osc.start(t0);
    osc.stop(t0 + attack + decay + 0.05);
  }

  _noise(peak, attack, decay, filterFreq, filterType = 'lowpass', delay = 0, q = 1) {
    if (!this.ctx || !this._noiseBuf) return;
    const t0 = this.ctx.currentTime + delay;
    const src = this.ctx.createBufferSource();
    src.buffer = this._noiseBuf;
    const filter = this.ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.setValueAtTime(filterFreq, t0);
    filter.frequency.exponentialRampToValueAtTime(Math.max(60, filterFreq * 0.18), t0 + attack + decay);
    filter.Q.value = q;
    const g = this.ctx.createGain();
    this._env(g, t0, peak, attack, decay);
    src.connect(filter);
    filter.connect(g);
    g.connect(this.sfxGain);
    src.start(t0);
    src.stop(t0 + attack + decay + 0.05);
  }

  /* ---------- Эффекты ---------- */

  /** Выстрел: тембр зависит от типа оружия, высота — от тира. */
  shoot(kind = 0, tier = 1) {
    if (!this.ctx || !this.enabled) return;
    const base = [520, 300, 680, 880, 220, 440][kind % 6];
    const f = base * (1 + (tier - 1) * 0.07);
    this._tone(f, kind === 4 ? 'sawtooth' : 'square', 0.055, 0.004, 0.07, null, f * 0.45);
  }

  hit() {
    if (!this.ctx || !this.enabled) return;
    this._noise(0.05, 0.002, 0.05, 2600, 'bandpass', 0, 2);
  }

  kill() {
    if (!this.ctx || !this.enabled) return;
    this._noise(0.13, 0.004, 0.2, 1500, 'lowpass');
    this._tone(180, 'triangle', 0.09, 0.005, 0.18, null, 60);
  }

  explode() {
    if (!this.ctx || !this.enabled) return;
    this._noise(0.3, 0.006, 0.45, 900, 'lowpass');
    this._tone(90, 'sine', 0.22, 0.008, 0.4, null, 32);
  }

  pickup() {
    if (!this.ctx || !this.enabled) return;
    this._tone(880, 'sine', 0.07, 0.004, 0.09);
    this._tone(1320, 'sine', 0.05, 0.004, 0.1, null, null, 0.05);
  }

  coin() {
    if (!this.ctx || !this.enabled) return;
    this._tone(1180, 'square', 0.035, 0.003, 0.06);
  }

  /** Слияние оружия — восходящее арпеджио, главный «вкусный» звук игры. */
  merge(tier = 2) {
    if (!this.ctx || !this.enabled) return;
    const root = 330 * Math.pow(1.06, tier);
    [0, 4, 7, 12].forEach((semi, i) => {
      this._tone(root * Math.pow(2, semi / 12), 'triangle', 0.11, 0.006, 0.24, null, null, i * 0.055);
    });
    this._noise(0.06, 0.01, 0.3, 4000, 'highpass', 0.02);
  }

  hurt() {
    if (!this.ctx || !this.enabled) return;
    this._tone(150, 'sawtooth', 0.16, 0.004, 0.22, null, 55);
    this._noise(0.14, 0.003, 0.16, 700, 'lowpass');
  }

  heal() {
    if (!this.ctx || !this.enabled) return;
    this._tone(520, 'sine', 0.09, 0.01, 0.2, null, 780);
    this._tone(780, 'sine', 0.06, 0.01, 0.26, null, 1040, 0.07);
  }

  wave() {
    if (!this.ctx || !this.enabled) return;
    [196, 262, 330].forEach((f, i) => this._tone(f, 'sawtooth', 0.07, 0.02, 0.5, null, null, i * 0.07));
  }

  boss() {
    if (!this.ctx || !this.enabled) return;
    this._tone(70, 'sawtooth', 0.28, 0.05, 1.1, null, 44);
    this._tone(105, 'square', 0.12, 0.05, 0.9, null, 70, 0.1);
    this._noise(0.16, 0.05, 1.0, 500, 'lowpass');
  }

  gameOver() {
    if (!this.ctx || !this.enabled) return;
    [440, 349, 262, 196].forEach((f, i) => this._tone(f, 'triangle', 0.13, 0.02, 0.5, null, null, i * 0.16));
  }

  uiClick() {
    if (!this.ctx || !this.enabled) return;
    this._tone(660, 'square', 0.04, 0.003, 0.05);
  }

  /* ---------- Музыка ----------
     Минималистичный синтвейв-луп: бас + арпеджио. Один такт = 8 шагов.
     Всё на осцилляторах, никаких сэмплов. */

  startMusic() {
    if (!this.ctx) return;
    this.stopMusic();
    const bpm = 104;
    const stepDur = 60 / bpm / 2; // восьмые
    const bass = [55, 55, 82.4, 55, 65.4, 65.4, 49, 73.4];
    const arp = [220, 330, 440, 330, 262, 392, 523, 392];

    const tick = () => {
      if (!this.ctx || !this.musicEnabled) return;
      const i = this._step % 8;
      const t = this.ctx.currentTime;

      const bo = this.ctx.createOscillator();
      const bg = this.ctx.createGain();
      bo.type = 'sawtooth';
      bo.frequency.value = bass[i];
      bg.gain.setValueAtTime(0.0001, t);
      bg.gain.exponentialRampToValueAtTime(0.28, t + 0.02);
      bg.gain.exponentialRampToValueAtTime(0.0001, t + stepDur * 0.95);
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 420;
      bo.connect(lp);
      lp.connect(bg);
      bg.connect(this.musicGain);
      bo.start(t);
      bo.stop(t + stepDur);

      if (i % 2 === 0) {
        const ao = this.ctx.createOscillator();
        const ag = this.ctx.createGain();
        ao.type = 'triangle';
        ao.frequency.value = arp[i];
        ag.gain.setValueAtTime(0.0001, t);
        ag.gain.exponentialRampToValueAtTime(0.09, t + 0.01);
        ag.gain.exponentialRampToValueAtTime(0.0001, t + stepDur * 1.6);
        ao.connect(ag);
        ag.connect(this.musicGain);
        ao.start(t);
        ao.stop(t + stepDur * 1.8);
      }

      if ((i === 0 || i === 5) && this._noiseBuf) {
        const src = this.ctx.createBufferSource();
        src.buffer = this._noiseBuf;
        const g = this.ctx.createGain();
        const hp = this.ctx.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.value = 6000;
        g.gain.setValueAtTime(0.06, t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
        src.connect(hp);
        hp.connect(g);
        g.connect(this.musicGain);
        src.start(t);
        src.stop(t + 0.08);
      }

      this._step++;
    };

    tick();
    this._musicTimer = setInterval(tick, stepDur * 1000);
  }

  stopMusic() {
    if (this._musicTimer) {
      clearInterval(this._musicTimer);
      this._musicTimer = null;
    }
  }
}
