import { fmt, fmtTime } from '../core/utils.js';
import { MAX_TIER, MAX_SLOTS } from '../systems/weapons.js';

/**
 * Экраны: меню, пауза, выбор перка, итоги забега.
 *
 * Важная деталь под Яндекс Игры: экраны должны корректно работать и на узком
 * телефоне, и в альбоме, и на широком десктопе без системной прокрутки
 * основного экрана (пункт 1.10 требований). Скролл разрешён только внутри
 * самого экрана-оверлея.
 */
export class Screens {
  constructor(uiRoot, cb = {}) {
    this.root = uiRoot;
    this.cb = cb;
    this.current = null;
    this._build();
  }

  _el(tag, cls, html) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (html !== undefined) el.innerHTML = html;
    return el;
  }

  _screen(name) {
    const s = this._el('div', 'screen');
    s.dataset.screen = name;
    this.root.appendChild(s);
    return s;
  }

  _build() {
    /* ---------- Меню ---------- */
    this.menu = this._screen('menu');
    const menuCard = this._el('div', 'card');
    menuCard.appendChild(this._el('div', 'logo', 'Мерж<br>Арена 3D'));
    menuCard.appendChild(this._el('div', 'logo-sub', 'Выживание · Слияние оружия'));

    this.menuBest = this._el('div', 'best-line', '');
    menuCard.appendChild(this.menuBest);

    const row = this._el('div', 'btn-row');
    this.btnPlay = this._el('button', 'btn', '▶ В бой');
    row.appendChild(this.btnPlay);
    menuCard.appendChild(row);

    menuCard.appendChild(
      this._el(
        'div',
        'hint',
        `<b>Управление.</b> Движение — <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd>, стрелки или джойстик на экране.
         Оружие стреляет само по ближайшей цели.<br><br>
         <b>Цель.</b> Отбивай волны, подбирай кубы оружия.
         Два одинаковых куба одного тира сливаются в оружие тира выше —
         максимум ${MAX_TIER}-й тир, слотов ${MAX_SLOTS}.<br><br>
         После каждой волны выбирай одно улучшение из трёх. Босс приходит каждую пятую волну.`,
      ),
    );

    this.menu.appendChild(menuCard);
    this.btnPlay.addEventListener('click', () => this.cb.play?.());

    /* ---------- Пауза ---------- */
    this.pause = this._screen('pause');
    const pauseCard = this._el('div', 'card');
    pauseCard.appendChild(this._el('div', 'perk-title', 'Пауза'));
    const prow = this._el('div', 'btn-row');
    this.btnResume = this._el('button', 'btn', 'Продолжить');
    this.btnRestart = this._el('button', 'btn ghost', 'Заново');
    this.btnToMenu = this._el('button', 'btn ghost', 'В меню');
    prow.append(this.btnResume, this.btnRestart, this.btnToMenu);
    pauseCard.appendChild(prow);
    this.pause.appendChild(pauseCard);

    this.btnResume.addEventListener('click', () => this.cb.resume?.());
    this.btnRestart.addEventListener('click', () => this.cb.restart?.());
    this.btnToMenu.addEventListener('click', () => this.cb.toMenu?.());

    /* ---------- Выбор перка ---------- */
    this.perk = this._screen('perk');
    const perkCard = this._el('div', 'card');
    this.perkTitle = this._el('div', 'perk-title', 'Волна пройдена');
    this.perkNote = this._el('div', 'perk-note', 'Выбери одно улучшение');
    this.perkCards = this._el('div', 'perk-cards');
    perkCard.append(this.perkTitle, this.perkNote, this.perkCards);
    this.perk.appendChild(perkCard);

    /* ---------- Итоги ---------- */
    this.over = this._screen('over');
    const overCard = this._el('div', 'card');
    this.overTitle = this._el('div', 'perk-title', 'Мех уничтожен');
    overCard.appendChild(this.overTitle);

    this.overGrid = this._el('div', 'result-grid');
    overCard.appendChild(this.overGrid);

    this.overRecord = this._el('div', 'record-tag', 'Новый рекорд');
    this.overRecord.style.display = 'none';
    overCard.appendChild(this.overRecord);

    this.overBest = this._el('div', 'best-line', '');
    overCard.appendChild(this.overBest);

    const orow = this._el('div', 'btn-row');
    this.btnAgain = this._el('button', 'btn magenta', '↻ Ещё раз');
    this.btnMenu2 = this._el('button', 'btn ghost', 'В меню');
    orow.append(this.btnAgain, this.btnMenu2);
    overCard.appendChild(orow);

    this.over.appendChild(overCard);
    this.btnAgain.addEventListener('click', () => this.cb.restart?.());
    this.btnMenu2.addEventListener('click', () => this.cb.toMenu?.());

    this.hideAll();
  }

  hideAll() {
    for (const s of [this.menu, this.pause, this.perk, this.over]) s.classList.remove('show');
    this.current = null;
  }

  _show(screen) {
    this.hideAll();
    screen.classList.add('show');
    this.current = screen.dataset.screen;
  }

  showMenu(best) {
    if (best && best.wave > 0) {
      this.menuBest.innerHTML =
        `Рекорд: <b>волна ${best.wave}</b> · ${fmt(best.kills)} фрагов · ${fmt(best.coins)} монет · ${fmtTime(best.time)}`;
    } else {
      this.menuBest.textContent = 'Рекордов пока нет — ты будешь первым.';
    }
    this._show(this.menu);
  }

  showPause() {
    this._show(this.pause);
  }

  showPerk(choices, levels, wave, onPick) {
    this.perkTitle.textContent = `Волна ${wave} пройдена`;
    this.perkNote.textContent = 'Выбери одно улучшение';
    this.perkCards.textContent = '';

    choices.forEach((p, idx) => {
      const lvl = levels[p.id] ?? 0;
      const card = this._el('button', 'perk-card');
      card.type = 'button';
      card.innerHTML = `
        <div class="pic" style="color:${p.css}">${p.glyph}</div>
        <div class="nm">${p.name}</div>
        <div class="ds">${p.desc}</div>
        <div class="lv">${lvl > 0 ? `Уровень ${lvl}${p.max < 99 ? ` / ${p.max}` : ''}` : 'Новое'}</div>
      `;
      card.addEventListener('click', (e) => {
        e.preventDefault();
        onPick(p);
      });
      // Выбор клавишами 1–3: быстрее для опытных игроков.
      card.dataset.hotkey = String(idx + 1);
      this.perkCards.appendChild(card);
    });

    this._show(this.perk);
  }

  showGameOver(r, best, isRecord) {
    this.overTitle.textContent = r.wave >= 1 ? 'Мех уничтожен' : 'Мех уничтожен';
    this.overGrid.textContent = '';

    const items = [
      ['Волна', String(r.wave)],
      ['Фраги', fmt(r.kills)],
      ['Монеты', fmt(r.coins)],
      ['Время', fmtTime(r.time)],
      ['Макс. тир', String(r.maxTier)],
      ['Перков взято', String(r.perks)],
    ];
    for (const [k, v] of items) {
      const item = this._el('div', 'result-item');
      item.innerHTML = `<div class="k">${k}</div><div class="v">${v}</div>`;
      this.overGrid.appendChild(item);
    }

    this.overRecord.style.display = isRecord ? 'inline-block' : 'none';
    this.overBest.innerHTML = best
      ? `Лучший результат: волна <b>${best.wave}</b> · ${fmt(best.kills)} фрагов`
      : '';

    this._show(this.over);
  }
}
