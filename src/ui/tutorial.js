// К4: the hand that shows the first drag.
//
// This file knows nothing about rules or steps: the app tells it which two
// provinces to connect and what the lesson says right now, and it draws a
// cursor travelling from one to the other on the real map. The coordinates come
// from the very same projection the labels use, so the hand follows the camera
// when the player pans or zooms instead of pointing at yesterday's pixel.

const CURSOR =
  '<path d="M5 2.4 20.2 12.6l-7.4 1.1 3.5 6.8-3 1.6-3.5-7-4.8 3.2Z"/>';

// One loop: press, travel, release, pause. Long enough to read, short enough
// that the target province is not permanently covered by a cursor.
const LOOP_MS = 2800;
const PRESS_END = 0.16;
const TRAVEL_END = 0.64;
const RING_END = 0.9;

const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

export class TutorialUI {
  /**
   * @param {object} options
   * @param {object} options.world  the map (projectProvince is all it needs)
   * @param {() => void} [options.onSkip]  «Другая партия» in the pill
   */
  constructor({ world, onSkip } = {}) {
    this.world = world;
    this.hand = null;
    this.startedAt = 0;
    this.visible = false;

    const app = document.getElementById('app');
    const layer = document.createElement('div');
    layer.className = 'tut-layer hidden';
    layer.setAttribute('aria-hidden', 'true');
    layer.innerHTML = `
      <svg class="tut-guide" width="100%" height="100%" aria-hidden="true">
        <line data-guide x1="0" y1="0" x2="0" y2="0" />
      </svg>
      <div class="tut-ring" data-ring></div>
      <div class="tut-hand">
        <svg viewBox="0 0 24 24" width="30" height="30" fill="currentColor"
             stroke="#0a1220" stroke-width="1.1" stroke-linejoin="round" aria-hidden="true">${CURSOR}</svg>
      </div>`;
    app.appendChild(layer);
    this.layer = layer;
    this.handEl = layer.querySelector('.tut-hand');
    this.ringEl = layer.querySelector('[data-ring]');
    this.guideEl = layer.querySelector('[data-guide]');

    const bar = document.createElement('div');
    bar.className = 'tut-bar hidden';
    bar.innerHTML = `
      <span class="tut-step" data-step></span>
      <span class="tut-body">
        <span class="tut-text" data-text></span>
        <span class="tut-note" data-note></span>
      </span>
      <button type="button" class="tut-skip" data-skip>Другая партия</button>`;
    const screen = document.getElementById('screen-game');
    screen.appendChild(bar);
    this.bar = bar;
    this.textEl = bar.querySelector('[data-text]');
    this.noteEl = bar.querySelector('[data-note]');
    this.stepEl = bar.querySelector('[data-step]');
    bar.querySelector('[data-skip]').addEventListener('click', () => onSkip?.());
  }

  /** The instruction pill: «2/3 · Вам предлагают пакт» under the HUD. */
  show(step, text) {
    this.bar.classList.remove('hidden');
    this.stepEl.textContent = `${step}/3`;
    this.textEl.textContent = text;
    this.noteEl.textContent = '';
    this.noteEl.className = 'tut-note';
  }

  /**
   * The lesson narrates its own events («Провинция Бельгия взята») in the same
   * pill instead of the toast stack: two floating layers of text over a map the
   * player is only just learning to read is exactly the «события вываливаются»
   * problem of round 27.
   */
  note(text, kind = 'info') {
    if (this.bar.classList.contains('hidden')) return;
    clearTimeout(this.noteTimer);
    this.noteEl.className = `tut-note is-${kind}`;
    this.noteEl.textContent = text;
    this.noteTimer = setTimeout(() => {
      this.noteEl.textContent = '';
      this.noteEl.className = 'tut-note';
    }, 3200);
  }

  hideBar() {
    this.bar.classList.add('hidden');
  }

  /** Draws the hand from `fromId` to `toId` and keeps it there until cleared. */
  setHand(fromId, toId) {
    this.hand = { from: fromId, to: toId };
    this.startedAt = performance.now();
    this.visible = true;
    this.layer.classList.remove('hidden');
  }

  clearHand() {
    this.hand = null;
    this.visible = false;
    this.layer.classList.add('hidden');
  }

  /** A pulsing outline on a real control: the offer card or the «Приказ» button. */
  highlight(target) {
    for (const node of document.querySelectorAll('.tut-target')) node.classList.remove('tut-target');
    if (!target) return;
    const el = typeof target === 'string' ? document.querySelector(target) : target;
    el?.classList.add('tut-target');
  }

  hide() {
    this.clearHand();
    this.hideBar();
    this.highlight(null);
    document.getElementById('screen-game')?.classList.remove('is-tutorial');
  }

  /**
   * One animation frame. Called from the app loop, so the hand and the guide
   * line are recomputed from the live camera every time the map moves.
   */
  frame(now = performance.now()) {
    if (!this.hand || !this.visible) return;
    const a = this.world.projectProvince(this.hand.from);
    const b = this.world.projectProvince(this.hand.to);
    if (!a || !b) return;
    const onScreen = (p) => p.visible && p.x > -40 && p.y > -40;
    if (!onScreen(a) && !onScreen(b)) {
      // Both ends of the gesture are off screen: a cursor floating over the
      // ocean explains nothing, so it waits for the camera to come back.
      this.layer.style.opacity = '0';
      return;
    }
    this.layer.style.opacity = '1';

    const t = (((now - this.startedAt) % LOOP_MS) + LOOP_MS) % LOOP_MS / LOOP_MS;
    let x = a.x;
    let y = a.y;
    let press = 0;
    if (t < PRESS_END) {
      // «Press and hold»: the cursor settles on the province before moving.
      x = a.x;
      y = a.y;
      press = t / PRESS_END;
    } else if (t < TRAVEL_END) {
      const k = easeInOut((t - PRESS_END) / (TRAVEL_END - PRESS_END));
      x = a.x + (b.x - a.x) * k;
      y = a.y + (b.y - a.y) * k;
    } else {
      x = b.x;
      y = b.y;
    }
    const scale = 1 - press * 0.18;
    this.handEl.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) scale(${scale.toFixed(3)})`;

    // The release ripple: it is the only cue that says «let go here».
    const ring = t >= TRAVEL_END && t < RING_END ? (t - TRAVEL_END) / (RING_END - TRAVEL_END) : -1;
    if (ring >= 0) {
      const size = 22 + ring * 54;
      this.ringEl.style.opacity = String(1 - ring);
      this.ringEl.style.transform = `translate3d(${b.x}px, ${b.y}px, 0) translate(-50%, -50%) scale(${(size / 60).toFixed(3)})`;
    } else {
      this.ringEl.style.opacity = '0';
    }

    // A dashed guide between the two provinces, so the direction is obvious
    // even before the cursor gets there.
    const guideOpacity = t >= PRESS_END ? 1 : 0;
    this.guideEl.style.opacity = String(0.5 * guideOpacity);
    this.guideEl.setAttribute('x1', a.x.toFixed(1));
    this.guideEl.setAttribute('y1', a.y.toFixed(1));
    this.guideEl.setAttribute('x2', b.x.toFixed(1));
    this.guideEl.setAttribute('y2', b.y.toFixed(1));
  }
}
