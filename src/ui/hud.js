import { WEAPONS, MAX_TIER } from '../systems/weapons.js';
import { fmt, fmtTime } from '../core/utils.js';

/**
 * HUD. Весь интерфейс — DOM поверх canvas: это дешевле, чем рисовать его
 * в 3D, и даёт crisp-текст на любом DPI без атласа шрифта в архиве.
 *
 * Текст обновляется только при изменении значения — иначе на мобильном
 * каждый кадр дёргает layout и ест FPS.
 */
export class Hud {
  constructor(uiRoot, callbacks = {}) {
    this.root = uiRoot;
    this.cb = callbacks;
    this._cache = {};
    this._build();
  }

  _el(tag, cls, html) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (html !== undefined) el.innerHTML = html;
    return el;
  }

  _build() {
    const hud = this._el('div', 'hud');

    /* --- Левый верх: прочность --- */
    const left = this._el('div', 'hud-left panel');
    const hpRow = this._el('div', 'hp-row');
    hpRow.appendChild(this._el('span', 'hp-label', 'Прочность'));
    this.hpValue = this._el('span', 'hp-value', '100 / 100');
    hpRow.appendChild(this.hpValue);
    left.appendChild(hpRow);
    const bar = this._el('div', 'bar');
    this.hpFill = this._el('div', 'bar-fill');
    bar.appendChild(this.hpFill);
    left.appendChild(bar);

    this.timeValue = this._el('div', 'wave-sub', '0:00');
    left.appendChild(this.timeValue);

    /* --- Центр: волна --- */
    const center = this._el('div', 'hud-center');
    this.waveTitle = this._el('div', 'wave-title', 'Волна 1');
    this.waveSub = this._el('div', 'wave-sub', 'Врагов: 0');
    center.appendChild(this.waveTitle);
    center.appendChild(this.waveSub);

    /* --- Правый верх: монеты, фраги, кнопки --- */
    const right = this._el('div', 'hud-right');
    const stats = this._el('div', 'panel stat-row');
    stats.appendChild(this._el('span', 'stat coins', '<span class="ico">⬤</span><span data-v="coins">0</span>'));
    stats.appendChild(this._el('span', 'stat kills', '<span class="ico">✕</span><span data-v="kills">0</span>'));
    right.appendChild(stats);
    this.coinsEl = stats.querySelector('[data-v="coins"]');
    this.killsEl = stats.querySelector('[data-v="kills"]');

    const btns = this._el('div');
    btns.style.cssText = 'display:flex;gap:6px;pointer-events:auto';
    this.btnSound = this._btn('🔊', 'sound', 'Звук');
    this.btnMusic = this._btn('♫', 'music', 'Музыка');
    this.btnPause = this._btn('⏸', 'pause', 'Пауза');
    btns.append(this.btnSound, this.btnMusic, this.btnPause);
    right.appendChild(btns);

    /* --- Низ: слоты оружия и перки --- */
    const bottom = this._el('div', 'hud-bottom');
    this.slotsEl = this._el('div', 'slots');
    this.perksEl = this._el('div', 'perks-row');
    bottom.appendChild(this.slotsEl);
    bottom.appendChild(this.perksEl);

    hud.append(left, center, right, bottom);
    this.root.appendChild(hud);
    this.hud = hud;

    /* --- Баннер волны --- */
    this.banner = this._el('div', 'banner');
    this.bannerBig = this._el('div', 'big');
    this.bannerSmall = this._el('div', 'small');
    this.banner.append(this.bannerBig, this.bannerSmall);
    this.root.appendChild(this.banner);

    this._slotEls = [];
    this.setVisible(false);
  }

  _btn(label, act, title) {
    const b = this._el('button', 'icon-btn', label);
    b.title = title;
    b.setAttribute('aria-label', title);
    b.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.cb[act]?.();
    });
    return b;
  }

  setVisible(on) {
    // Только opacity/visibility: pointer-events на всём контейнере HUD
    // перехватывал бы касания, нужные джойстику. Кликабельны лишь .icon-btn.
    this.hud.style.transition = 'opacity 0.25s ease';
    this.hud.style.opacity = on ? '1' : '0';
    this.hud.style.visibility = on ? 'visible' : 'hidden';
  }

  showBanner(big, small, boss = false) {
    this.bannerBig.textContent = big;
    this.bannerSmall.textContent = small;
    this.banner.classList.toggle('boss', boss);
    this.banner.classList.remove('show');
    void this.banner.offsetWidth; // перезапуск CSS-анимации
    this.banner.classList.add('show');
  }

  /** Перерисовка слотов оружия. Вызывается только при изменении состава. */
  setSlots(weapons) {
    const total = weapons.slotCount;
    while (this._slotEls.length < total) {
      const slot = this._el('div', 'slot empty');
      const glyph = this._el('div', 'glyph', '·');
      const cd = this._el('div', 'cd');
      cd.style.transform = 'scaleY(0)';
      const tier = this._el('div', 'tier');
      for (let i = 0; i < MAX_TIER; i++) tier.appendChild(this._el('i'));
      slot.append(glyph, cd, tier);
      this.slotsEl.appendChild(slot);
      this._slotEls.push({ root: slot, glyph, cd, tier, pips: [...tier.children] });
    }
    while (this._slotEls.length > total) {
      const s = this._slotEls.pop();
      s.root.remove();
    }

    for (let i = 0; i < total; i++) {
      const el = this._slotEls[i];
      const slot = weapons.slots[i];
      if (!slot) {
        el.root.classList.add('empty');
        el.root.style.color = '';
        el.glyph.textContent = '·';
        el.pips.forEach((p) => p.classList.remove('on'));
        continue;
      }
      const w = WEAPONS[slot.type];
      el.root.classList.remove('empty');
      el.root.style.color = w.css;
      el.glyph.textContent = w.glyph;
      el.root.title = `${w.name}, тир ${slot.tier}`;
      el.pips.forEach((p, k) => p.classList.toggle('on', k < slot.tier));
    }
  }

  /** Индикатор перезарядки в слотах — дешёвая, но важная обратная связь. */
  updateCooldowns(weapons) {
    for (let i = 0; i < this._slotEls.length; i++) {
      const el = this._slotEls[i];
      const slot = weapons.slots[i];
      if (!slot) {
        el.cd.style.transform = 'scaleY(0)';
        continue;
      }
      const st = slot._lastCdRatio;
      el.cd.style.transform = `scaleY(${st ? st.toFixed(2) : 0})`;
    }
  }

  flashSlot(index) {
    const el = this._slotEls[index];
    if (!el) return;
    el.root.classList.remove('merge-flash');
    void el.root.offsetWidth;
    el.root.classList.add('merge-flash');
  }

  setPerks(levels) {
    const entries = Object.entries(levels).filter(([, v]) => v > 0);
    const key = entries.map(([k, v]) => `${k}${v}`).join(',');
    if (this._cache.perks === key) return;
    this._cache.perks = key;

    this.perksEl.textContent = '';
    for (const [id, lvl] of entries) {
      const b = this._el('span', 'perk-badge');
      b.innerHTML = `${id} <b>${lvl}</b>`;
      this.perksEl.appendChild(b);
    }
  }

  /** Перки с нормальными названиями (для бейджа берём короткое имя). */
  setPerkNames(names) {
    this._perkNames = names;
  }

  update(g) {
    const hp = Math.max(0, Math.ceil(g.player.hp));
    const maxHp = Math.ceil(g.player.maxHp);
    const ratio = maxHp > 0 ? hp / maxHp : 0;

    const hpText = `${hp} / ${maxHp}`;
    if (this._cache.hp !== hpText) {
      this._cache.hp = hpText;
      this.hpValue.textContent = hpText;
      this.hpFill.style.width = `${(ratio * 100).toFixed(1)}%`;
      this.hpFill.classList.toggle('low', ratio < 0.32);
    }

    if (this._cache.coins !== g.coins) {
      this._cache.coins = g.coins;
      this.coinsEl.textContent = fmt(g.coins);
    }
    if (this._cache.kills !== g.kills) {
      this._cache.kills = g.kills;
      this.killsEl.textContent = fmt(g.kills);
    }

    const t = fmtTime(g.elapsed);
    if (this._cache.time !== t) {
      this._cache.time = t;
      this.timeValue.textContent = t;
    }

    const wt = `Волна ${g.waves.wave}`;
    if (this._cache.wave !== wt) {
      this._cache.wave = wt;
      this.waveTitle.textContent = wt;
    }

    const rem = g.waves.remaining;
    if (this._cache.rem !== rem) {
      this._cache.rem = rem;
      this.waveSub.textContent = g.waves.state === 'break' ? 'Приготовиться…' : `Врагов: ${rem}`;
    }
  }

  setSound(on) {
    this.btnSound.textContent = on ? '🔊' : '🔇';
    this.btnSound.classList.toggle('off', !on);
  }

  setMusic(on) {
    this.btnMusic.classList.toggle('off', !on);
  }
}
