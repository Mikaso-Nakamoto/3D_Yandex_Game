/**
 * Ввод: клавиатура + мышь на десктопе, виртуальный джойстик на тач-устройствах.
 *
 * Особенности платформы:
 *  - игра обязана работать и на телефоне, и на десктопе (пункт 1.20 требований);
 *  - системное контекстное меню в области игры отключается (пункт 1.6);
 *  - при уходе со вкладки / показе рекламы ввод сбрасывается, иначе игрок «залипает»
 *    с зажатой клавишей, а GameplayAPI требует честной паузы.
 */

const MOVE_KEYS = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD',
  'ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight',
  'KeyH', 'KeyJ', 'KeyK', 'KeyL', // альтернативный ромб, как в некоторых рогаликах
]);

export class Input {
  constructor(canvas, uiRoot) {
    this.canvas = canvas;
    this.uiRoot = uiRoot;

    /** Ось движения: -1..1 по X и Z. */
    this.mx = 0;
    this.mz = 0;

    this.keys = new Set();
    this.isTouch = false;
    this.enabled = true;

    this._stickEl = null;
    this._knobEl = null;
    this._stickId = null;
    this._stickOrigin = { x: 0, y: 0 };
    this._stickVec = { x: 0, y: 0 };
    this._stickRadius = 56;

    this.onPause = null; // callback
    this.onAnyInput = null; // callback — чтобы разбудить аудио после жеста

    this._bind();
  }

  _bind() {
    // Определяем тач-устройство: джойстик нужен и на планшетах, и на телефонах.
    this.isTouch =
      typeof window !== 'undefined' &&
      (window.matchMedia?.('(hover: none) and (pointer: coarse)').matches ||
        'ontouchstart' in window ||
        navigator.maxTouchPoints > 0);

    window.addEventListener('keydown', (e) => {
      this._wake();
      if (e.code === 'Escape' || e.code === 'KeyP') {
        e.preventDefault();
        this.onPause?.();
        return;
      }
      // Пробел и стрелки прокручивают страницу — гасим, пункт 1.10 требований.
      if (e.code === 'Space' || MOVE_KEYS.has(e.code)) e.preventDefault();
      if (e.repeat) return;
      this.keys.add(e.code);
    });

    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
    });

    window.addEventListener('blur', () => this.releaseAll());

    // Контекстное меню в области игры (пункт 1.6.1.8 / 1.6.2.7).
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    this.uiRoot?.addEventListener('contextmenu', (e) => e.preventDefault());

    this._buildStick();
  }

  _wake() {
    this.onAnyInput?.();
  }

  releaseAll() {
    this.keys.clear();
    this._endStick();
    this.mx = 0;
    this.mz = 0;
  }

  /* ---------- Джойстик ---------- */

  _buildStick() {
    if (!this.isTouch || !this.uiRoot) return;

    const zone = document.createElement('div');
    zone.className = 'stick-zone';
    const stick = document.createElement('div');
    stick.className = 'stick';
    const knob = document.createElement('div');
    knob.className = 'stick-knob';
    stick.appendChild(knob);
    this.uiRoot.appendChild(zone);
    this.uiRoot.appendChild(stick);
    this._stickEl = stick;
    this._knobEl = knob;

    const onStart = (e) => {
      if (!this.enabled) return;
      // Джойстик реагирует на касание в нижней половине экрана,
      // чтобы не конфликтовать с кнопками HUD.
      const t = e.changedTouches ? e.changedTouches[0] : e;
      if (t.clientY < window.innerHeight * 0.28) return;
      if (this._stickId !== null) return;
      this._wake();
      this._stickId = e.changedTouches ? t.identifier : 'mouse';
      this._stickOrigin.x = t.clientX;
      this._stickOrigin.y = t.clientY;
      stick.style.left = `${t.clientX}px`;
      stick.style.top = `${t.clientY}px`;
      stick.classList.add('on');
      e.preventDefault();
    };

    const onMove = (e) => {
      if (this._stickId === null) return;
      const t = this._findTouch(e);
      if (!t) return;
      let dx = t.clientX - this._stickOrigin.x;
      let dy = t.clientY - this._stickOrigin.y;
      const len = Math.hypot(dx, dy);
      const max = this._stickRadius;
      if (len > max) {
        dx = (dx / len) * max;
        dy = (dy / len) * max;
      }
      this._stickVec.x = dx / max;
      this._stickVec.y = dy / max;
      knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
      e.preventDefault();
    };

    const onEnd = (e) => {
      if (this._stickId === null) return;
      const t = this._findTouch(e);
      if (e.changedTouches && t && t.identifier !== this._stickId) return;
      this._endStick();
    };

    zone.addEventListener('touchstart', onStart, { passive: false });
    zone.addEventListener('touchmove', onMove, { passive: false });
    zone.addEventListener('touchend', onEnd, { passive: false });
    zone.addEventListener('touchcancel', onEnd, { passive: false });
    zone.addEventListener('mousedown', onStart);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onEnd);
  }

  _findTouch(e) {
    if (!e.changedTouches) return e;
    for (const t of e.changedTouches) {
      if (t.identifier === this._stickId) return t;
    }
    return e.changedTouches[0] ?? null;
  }

  _endStick() {
    this._stickId = null;
    this._stickVec.x = 0;
    this._stickVec.y = 0;
    if (this._stickEl) {
      this._stickEl.classList.remove('on');
      this._knobEl.style.transform = 'translate(-50%, -50%)';
    }
  }

  /* ---------- Опрос ---------- */

  update() {
    if (!this.enabled) {
      this.mx = 0;
      this.mz = 0;
      return;
    }

    let x = 0;
    let z = 0;

    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft') || this.keys.has('KeyH')) x -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight') || this.keys.has('KeyL')) x += 1;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp') || this.keys.has('KeyK')) z -= 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown') || this.keys.has('KeyJ')) z += 1;

    // Джойстик перекрывает клавиатуру, если он активен.
    if (this._stickId !== null) {
      x = this._stickVec.x;
      z = this._stickVec.y;
    }

    const len = Math.hypot(x, z);
    if (len > 1) {
      x /= len;
      z /= len;
    }

    // Мёртвая зона, чтобы джойстик не «дрейфовал».
    if (len < 0.14) {
      x = 0;
      z = 0;
    }

    this.mx = x;
    this.mz = z;
  }
}
