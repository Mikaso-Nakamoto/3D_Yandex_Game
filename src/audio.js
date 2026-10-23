// Tiny WebAudio synth: no audio assets, everything is generated on the fly.
class Sfx {
  constructor() {
    this.enabled = true;
    this.ctx = null;
    this.master = null;
  }

  setEnabled(value) {
    this.enabled = Boolean(value);
    if (this.master) this.master.gain.value = this.enabled ? 0.5 : 0;
  }

  #ensure() {
    if (!this.enabled) return null;
    try {
      if (!this.ctx) {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return null;
        this.ctx = new AudioCtx();
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.5;
        this.master.connect(this.ctx.destination);
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return this.ctx;
    } catch {
      return null;
    }
  }

  tone({ freq = 440, dur = 0.08, type = 'sine', gain = 0.05, slide = 0, delay = 0 }) {
    const ctx = this.#ensure();
    if (!ctx) return;
    const now = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, now);
    if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), now + dur);
    env.gain.setValueAtTime(0.0001, now);
    env.gain.exponentialRampToValueAtTime(Math.max(0.001, gain), now + 0.008);
    env.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    osc.connect(env);
    env.connect(this.master);
    osc.start(now);
    osc.stop(now + dur + 0.02);
  }

  click() {
    this.tone({ freq: 620, dur: 0.045, type: 'triangle', gain: 0.03 });
  }

  select() {
    this.tone({ freq: 440, dur: 0.07, type: 'sine', gain: 0.035 });
    this.tone({ freq: 660, dur: 0.07, type: 'sine', gain: 0.025, delay: 0.05 });
  }

  march() {
    this.tone({ freq: 220, dur: 0.16, type: 'sawtooth', gain: 0.022, slide: 60 });
  }

  battle() {
    this.tone({ freq: 160, dur: 0.22, type: 'square', gain: 0.03, slide: -60 });
    this.tone({ freq: 90, dur: 0.3, type: 'sawtooth', gain: 0.025, delay: 0.04 });
  }

  capture() {
    [523, 659, 784].forEach((f, i) =>
      this.tone({ freq: f, dur: 0.18, type: 'triangle', gain: 0.035, delay: i * 0.07 }),
    );
  }

  loss() {
    [330, 262, 196].forEach((f, i) =>
      this.tone({ freq: f, dur: 0.22, type: 'sine', gain: 0.04, delay: i * 0.09 }),
    );
  }

  victory() {
    [392, 523, 659, 784, 1046].forEach((f, i) =>
      this.tone({ freq: f, dur: 0.45, type: 'triangle', gain: 0.05, delay: i * 0.13 }),
    );
  }

  defeat() {
    [392, 349, 294, 220].forEach((f, i) =>
      this.tone({ freq: f, dur: 0.5, type: 'sine', gain: 0.05, delay: i * 0.16 }),
    );
  }

  coin() {
    this.tone({ freq: 880, dur: 0.06, type: 'triangle', gain: 0.03 });
    this.tone({ freq: 1320, dur: 0.08, type: 'triangle', gain: 0.025, delay: 0.05 });
  }
}

export const sfx = new Sfx();
