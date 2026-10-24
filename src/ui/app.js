import { World } from '../render/world.js';
import { LabelLayer } from '../render/labels.js';
import { ArrowLayer } from '../render/arrows.js';
import { Game } from '../game/game.js';
import { SCENARIOS, DOCTRINES, THEATRES, getScenario, hasScenario } from '../data/scenarios.js';
import { BAL, UPGRADES, ORDERS } from '../game/balance.js';
import { assignNeutralColors } from '../data/neutral.js';
import {
  DEFAULT_RULES,
  AI_STYLE,
  AI_ECONOMY,
  NEUTRAL_STRENGTH,
  normalizeRules,
  describeRules,
  ruleOptionMatches,
} from '../game/rules.js';
import { platform } from '../platform/yandex.js';
import { sfx } from '../audio.js';
import { icon } from './icons.js';
import { offerTitle, provincesCount, nationsCount, plural } from '../game/text.js';

const SAVE_KEY = 'crowns.save.v1';
const SETTINGS_KEY = 'crowns.settings.v1';
const TIPS_KEY = 'crowns.tips.v1';
const DIFFICULTY_LEVEL = { 'Низко': 1, 'Средне': 2, 'Высоко': 3 };

const $ = (sel, root = document) => root.querySelector(sel);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const fmt = (n) => Math.round(n).toLocaleString('ru-RU');

export class App {
  constructor(maps) {
    this.maps = maps;
    this.theatre = 'europe';
    this.mapMode = 'europe';
    this.panelFolded = false;
    this.rankTab = 'nations';
    this.panelFoldTimer = null;
    this.autoFrom = null;
    this.map = maps[this.theatre];
    this.mapById = Object.fromEntries(this.map.provinces.map((p) => [p.id, p]));
    this.settings = this.#loadSettings();
    this.pendingRules = normalizeRules(this.settings.rules ?? {});

    this.world = new World($('#view'), this.map, {
      canDrag: (id) => this.#canStartDrag(id),
      onDragStart: (id) => this.#dragStart(id),
      onDrop: (from, to) => this.#dragDrop(from, to),
      onDragCancel: () => this.#dragCancel(),
      onClick: (id) => this.#click(id),
      onHover: (id) => this.#hover(id),
      onArrowPreview: (preview) => this.arrowLayer.setPreview(preview),
    });
    this.arrowLayer = new ArrowLayer($('#arrows'), this.world);
    // The drag preview asks the model for the real road through own land.
    this.world.routeProvider = (from, to) => this.game?.routeBetween(from, to) ?? null;
    this.labels = new LabelLayer($('#labels'), this.map);
    this.labels.setVisible(false);

    this.screen = 'menu';
    this.game = null;
    this.scenario = null;
    this.selectedNation = null;
    this.doctrine = 'coin';
    this.selectedProvince = null;
    this.lastSpeed = 1;
    this.preferredRatio = 0.5;
    this.pressing = false;
    this.offerSignature = '';
    this.hudTimer = 0;
    this.saveTimer = 10;
    this.colorSignature = '';
    this.armyTokens = new Map();
    this.lastBattleSound = 0;
    this.hasSave = this.#readSave() !== null;
    this.seenTips = this.#readTips();

    this.#hydrateIcons();
    this.#buildMenu();
    this.#buildDoctrines();
    this.#buildOrders();
    this.#bindUi();
    this.#bindKeyboard();

    this.showMenu();
    this.lastFrame = performance.now();
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
  }

  #hydrateIcons() {
    for (const node of document.querySelectorAll('[data-icon]')) {
      node.innerHTML = icon(node.dataset.icon, node.classList.contains('brand-crown') ? 34 : 16);
    }
  }

  // ---------------------------------------------------------------- settings & save

  #loadSettings() {
    try {
      const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
      return {
        sound: raw.sound !== false,
        labels: raw.labels !== false,
        tips: raw.tips !== false,
        rules: raw.rules ?? null,
      };
    } catch {
      return { sound: true, labels: true, tips: true, rules: null };
    }
  }

  #readTips() {
    try {
      const raw = JSON.parse(localStorage.getItem(TIPS_KEY) || '[]');
      return new Set(Array.isArray(raw) ? raw : []);
    } catch {
      return new Set();
    }
  }

  /**
   * A one-time tip for the first time something happens. Unlike the timed
   * onboarding toasts these are impossible to miss: they fire on the event the
   * player just caused, and they never repeat — a tip that keeps appearing is
   * noise, and noise is what the switch in the pause menu turns off.
   */
  #tip(key, text) {
    if (this.settings.tips === false) return;
    if (this.seenTips.has(key)) return;
    this.seenTips.add(key);
    try {
      localStorage.setItem(TIPS_KEY, JSON.stringify([...this.seenTips]));
    } catch {
      /* storage full or disabled: the tip is still shown once this session */
    }
    this.#toast(text, 'info');
  }

  #saveSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
    } catch {
      /* ignore */
    }
  }

  #readSave() {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed?.game ? parsed : null;
    } catch {
      return null;
    }
  }

  save() {
    if (!this.game || this.game.state.status !== 'playing') return;
    const payload = { savedAt: Date.now(), theatre: this.theatre, game: this.game.serialize() };
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(payload));
      this.hasSave = true;
      $('#btn-continue')?.classList.remove('hidden');
    } catch (error) {
      console.info('save failed', error?.message);
    }
    platform.save({ save: JSON.stringify(payload) });
  }

  async #resumeFromStorage() {
    let saved = this.#readSave();
    if (!saved) {
      const cloud = await platform.load();
      if (cloud?.save) {
        try {
          saved = JSON.parse(cloud.save);
        } catch {
          saved = null;
        }
      }
    }
    return saved;
  }

  // ---------------------------------------------------------------- theatres

  /** Switches the rendered map. Safe to call when the theatre is already active. */
  setTheatre(theatreId) {
    const id = this.maps[theatreId] ? theatreId : 'europe';
    if (id === this.theatre && this.map === this.maps[id]) return this.theatre;
    this.theatre = id;
    this.map = this.maps[id];
    this.mapById = Object.fromEntries(this.map.provinces.map((p) => [p.id, p]));
    this.world.setMap(this.map);
    this.labels.setMap(this.map);
    this.#clearArmies();
    this.selectedProvince = null;
    this.colorSignature = '';
    $('#province-panel').classList.add('hidden');
    return this.theatre;
  }

  // ---------------------------------------------------------------- menu

  #buildMenu() {
    const list = $('#scenario-list');
    list.innerHTML = '';
    for (const scenario of SCENARIOS.filter((s) => (s.theatre ?? 'europe') === this.mapMode)) {
      const level = DIFFICULTY_LEVEL[scenario.difficulty] ?? 2;
      const dots = Array.from({ length: 3 }, (_, i) => `<i class="${i < level ? 'on' : ''}"></i>`).join('');
      const card = document.createElement('button');
      card.className = 'scenario-card';
      card.type = 'button';
      card.dataset.scenario = scenario.id;
      card.innerHTML = `
        <div class="scenario-era">${scenario.era}</div>
        <div class="scenario-title">${scenario.title}</div>
        <div class="scenario-desc">${scenario.blurb}</div>
        <div class="scenario-meta">
          <span class="th-long">${THEATRES[scenario.theatre]?.title ?? 'Европа'}</span>
          <span class="th-short">${THEATRES[scenario.theatre]?.short ?? 'Европа'}</span>
          <span>${nationsCount(scenario.nations.length)}</span>
          <span class="difficulty">${dots}<span>${scenario.difficulty}</span></span>
        </div>`;
      card.addEventListener('click', () => {
        sfx.select();
        this.openNationSelect(scenario.id);
      });
      list.appendChild(card);
    }
    $('#btn-continue').classList.toggle('hidden', !this.hasSave);
  }

  /** Menu mode: the European map alone, or Europe together with North America. */
  setMapMode(mode) {
    this.mapMode = this.maps[mode] ? mode : 'europe';
    for (const button of document.querySelectorAll('#mode-switch .mode-btn')) {
      const active = button.dataset.mode === this.mapMode;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-selected', String(active));
    }
    // The background has to follow the switch: the menu used to keep showing
    // the European map while offering the Atlantic scenarios.
    this.setTheatre(this.mapMode);
    this.#frameMenuBackdrop();
    this.#buildMenu();
  }

  showMenu() {
    this.game = null;
    this.autoFrom = null;
    this.panelFolded = false;
    clearTimeout(this.panelFoldTimer);
    $('#focus-card').classList.add('hidden');
    $('#btn-focus').classList.add('hidden');
    this.selectedProvince = null;
    this.#setScreen('menu');
    this.#clearArmies();
    this.labels.setVisible(false);
    this.world.setSelected(null);
    this.world.setAccent([]);
    this.world.setValidTargets([]);
    this.setTheatre(this.mapMode);
    this.#frameMenuBackdrop();
    $('#province-panel').classList.add('hidden');
    platform.gameplayStop();
  }

  /**
   * The menu backdrop: the countries of the chosen theatre, at the same
   * apparent scale on both maps. Fitting the whole Atlantic file instead made
   * Europe shrink by half the moment the player flipped the switch.
   */
  #frameMenuBackdrop() {
    const scenario = this.scenario?.theatre === this.mapMode
      ? this.scenario
      : SCENARIOS.find((s) => (s.theatre ?? 'europe') === this.mapMode) ?? getScenario('concert');
    this.world.setOwnership(this.#previewColors(scenario));
    this.world.resetView();
    this.world.focusNation(this.#scenarioFocus(scenario), 0.9, { dense: true });
    this.world.setAutoPan(true);
  }

  /**
   * The provinces a scenario is really about. European scenarios with colonies
   * are centred on Europe; the American Civil War is centred on America. The
   * scenario says so itself (`focus`), so the rule is not guessed from counts.
   */
  #scenarioFocus(scenario) {
    const playable = scenario.nations.flatMap((n) => n.provinces).filter((id) => this.mapById[id]);
    const american = (id) => (this.mapById[id]?.centroid[0] ?? 0) < 0;
    if (scenario.focus === 'america') {
      const inAmerica = playable.filter(american);
      if (inAmerica.length) return inAmerica;
    }
    if (scenario.focus === 'europe') {
      const inEurope = playable.filter((id) => !american(id));
      if (inEurope.length) return inEurope;
    }
    return playable;
  }

  openNationSelect(scenarioId) {
    this.scenario = getScenario(scenarioId);
    this.setTheatre(this.scenario.theatre ?? 'europe');
    this.selectedNation = null;
    this.selectedProvince = null;
    this.doctrine = 'coin';
    this.#setScreen('nation');
    $('#nation-era').textContent = this.scenario.era;
    $('#nation-scenario').textContent = this.scenario.title;
    $('#province-panel').classList.add('hidden');
    this.labels.setVisible(false);
    this.world.setSelected(null);
    this.world.setAccent([]);
    this.world.resetView();
    this.world.setAutoPan(false);
    this.world.setOwnership(this.#previewColors(this.scenario));
    // Frame the countries of this scenario, not the whole map file: on the
    // Atlantic theatre the file is nearly three times wider, so «fit the map»
    // made Europe twice as small as on the Europe theatre. Scenarios that are
    // about America (the Civil War) are framed on America.
    this.world.focusNation(this.#scenarioFocus(this.scenario), 0.9, { dense: true });
    this.#renderNations();
  }

  #previewColors(scenario) {
    const colors = {};
    for (const [id, color] of this.#neutralShades()) colors[id] = color;
    for (const nation of scenario.nations) {
      for (const provinceId of nation.provinces) colors[provinceId] = nation.color;
    }
    return colors;
  }

  /**
   * One muted colour per unowned province, so the map reads as a hundred
   * countries rather than one grey «neutral territory». Cached per theatre:
   * the assignment is a graph colouring and does not change while playing.
   */
  #neutralShades() {
    if (!this.neutralShades || this.neutralShadesMap !== this.map) {
      this.neutralShades = assignNeutralColors(this.map.provinces);
      this.neutralShadesMap = this.map;
    }
    return this.neutralShades;
  }

  /**
   * Whose country a province is. For land nobody has taken the map prints the
   * country it belongs to — «Монголия», «Китай» — instead of the faceless
   * «нейтральная территория» that used to cover half the planet.
   */
  #countryName(provinceId) {
    const province = this.mapById[provinceId];
    return province?.country ?? province?.nameRu ?? this.mapById[provinceId]?.name ?? '';
  }

  /** Subtitle for a province nobody owns: country first, never «нейтральная». */
  #unownedLabel(provinceId) {
    const province = this.mapById[provinceId];
    const country = this.#countryName(provinceId);
    const name = province?.nameRu ?? province?.name ?? '';
    return country && country !== name ? `${country} · независимая` : 'независимая страна';
  }

  /** Colour of a province right now: its owner's colour or its own shade. */
  #provinceColor(province) {
    if (province.owner) return this.game.state.nations[province.owner].color;
    return this.#neutralShades().get(province.id) ?? '#4a5259';
  }

  #nationPreview(nation) {
    let pop = 0;
    let income = 0;
    let army = 0;
    let recruits = 0;
    for (const id of nation.provinces) {
      const province = this.mapById[id];
      if (!province) continue;
      pop += province.pop;
      income += BAL.incomeBase + province.pop * BAL.incomePop;
      army += (BAL.garrisonBase + province.pop * BAL.garrisonPop) * (nation.army ?? 1);
      recruits += BAL.manpowerBase + province.pop * BAL.manpowerPop;
    }
    return { pop, income, army: Math.round(army), recruits };
  }

  /**
   * How hard the nation is to play, judged by the army it can field against the
   * strongest rival on the map. Asking a newcomer to pick a one-province colony
   * without saying so was the fastest way to lose them.
   */
  #nationDifficulty(nation) {
    const previews = this.scenario.nations.map((n) => this.#nationPreview(n).army);
    const strongest = Math.max(1, ...previews);
    const share = this.#nationPreview(nation).army / strongest;
    if (share >= 0.55) return { id: 'easy', label: 'Просто', hint: 'Сильная держава: можно диктовать условия' };
    if (share >= 0.25) return { id: 'mid', label: 'Средне', hint: 'Равная борьба: решают первые минуты' };
    return { id: 'hard', label: 'Трудно', hint: 'Малая держава: придётся выживать и расти' };
  }

  #renderNations() {
    const list = $('#nation-list');
    list.innerHTML = '';
    const nations = [...this.scenario.nations].sort((a, b) => {
      const pa = this.#nationPreview(a);
      const pb = this.#nationPreview(b);
      return pb.army - pa.army;
    });
    for (const nation of nations) {
      const preview = this.#nationPreview(nation);
      const difficulty = this.#nationDifficulty(nation);
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'nation-tile';
      item.dataset.nation = nation.id;
      item.setAttribute('role', 'option');
      item.style.setProperty('--swatch', nation.color);
      item.innerHTML = `
        <span class="tile-bar"></span>
        <span class="tile-body">
          <span class="tile-name">${nation.short}</span>
          <span class="tile-sub">${nation.provinces.length} пров. · ${(preview.pop * this.#popScale()).toFixed(1)} млн</span>
          <span class="tile-army">Армия ${fmt(preview.army)}<span class="tile-diff" data-level="${difficulty.id}">${difficulty.label}</span></span>
        </span>`;
      item.addEventListener('click', () => this.#selectNation(nation.id, true));
      list.appendChild(item);
    }
    $('#nation-count').textContent = `${nationsCount(this.scenario.nations.length)} · ${this.scenario.era}`;
    this.#renderNationDetail();
  }

  /** Millions shown on screen: the era's own numbers, not the simulation units. */
  #popScale() {
    return this.scenario?.popScale ?? this.game?.scenario?.popScale ?? 1;
  }

  #renderNationDetail() {
    const detail = $('#nation-detail');
    const nation = this.scenario?.nations.find((n) => n.id === this.selectedNation);
    if (!nation) {
      detail.innerHTML = `
        <div class="detail-empty">
          <span class="detail-empty-icon">${icon('crown', 30)}</span>
          <h3>Держава не выбрана</h3>
          <p>Нажмите на страну на карте или выберите из списка. Затем задайте доктрину и начните правление.</p>
        </div>`;
      return;
    }
    const preview = this.#nationPreview(nation);
    const difficulty = this.#nationDifficulty(nation);
    const doctrine = DOCTRINES.find((d) => d.id === this.doctrine) ?? DOCTRINES[0];
    detail.innerHTML = `
      <div class="detail-scroll">
      <div class="detail-head">
        <span class="detail-crest" style="--swatch:${nation.color}">${icon('flag', 22)}</span>
        <div>
          <div class="eyebrow">${this.scenario.era} · ${provincesCount(nation.provinces.length)}</div>
          <h3>${nation.name}</h3>
        </div>
        <span class="detail-diff" data-level="${difficulty.id}" title="${difficulty.hint}">${difficulty.label}</span>
      </div>
      <div class="detail-stats">
        <div class="ds"><span class="k">Население</span><span class="v">${(preview.pop * this.#popScale()).toFixed(1)} млн</span></div>
        <div class="ds"><span class="k">Доход</span><span class="v gold">+${preview.income.toFixed(1)}/с</span></div>
        <div class="ds"><span class="k">Армия</span><span class="v">${fmt(preview.army)}</span></div>
        <div class="ds"><span class="k">Рекруты</span><span class="v">+${(preview.recruits * 60).toFixed(0)}/мин</span></div>
      </div>
      <div class="detail-doctrine">
        <div class="eyebrow">Доктрина <span class="eyebrow-note">действует всю партию</span></div>
        <div id="doctrine-list" class="doctrine-list"></div>
        <p class="doctrine-note">${doctrine.description}</p>
      </div>
      <div class="detail-rules">
        <span class="rules-label">Правила</span>
        <span class="rules-value">${describeRules(this.pendingRules)}</span>
        <button class="link-btn" data-open-rules>Изменить</button>
      </div>
      </div>
      <button id="btn-start" class="btn primary">Начать правление</button>
    `;
    this.#renderDoctrinePicker();
  }

  #renderDoctrinePicker() {
    const list = $('#doctrine-list');
    if (!list) return;
    list.innerHTML = '';
    for (const doctrine of DOCTRINES) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = `doctrine${this.doctrine === doctrine.id ? ' active' : ''}`;
      item.dataset.doctrine = doctrine.id;
      item.title = doctrine.description;
      item.innerHTML = `
        <span class="d-icon">${icon(doctrine.icon, 20)}</span>
        <span class="d-name">${doctrine.name}</span>
        <span class="d-desc">${doctrine.effectLabel ?? doctrine.description.split('.')[0]}</span>`;
      item.addEventListener('click', () => {
        this.doctrine = doctrine.id;
        sfx.click();
        this.#renderNationDetail();
      });
      list.appendChild(item);
    }
  }

  #buildDoctrines() {
    this.#renderDoctrinePicker();
  }

  #selectNation(id, focus = false) {
    this.selectedNation = id;
    const nation = this.scenario.nations.find((n) => n.id === id);
    if (!nation) return;
    sfx.click();
    for (const item of $('#nation-list').children) {
      item.classList.toggle('active', item.dataset.nation === id);
      item.setAttribute('aria-selected', String(item.dataset.nation === id));
    }
    this.world.setAccent(nation.provinces);
    // Picking from the list flies to that country: the picker shows the whole
    // theatre, so «where is it» must be answered immediately.
    if (focus) this.world.focusNation(nation.provinces, 0.5, { anchor: nation.capital });
    this.#renderNationDetail();
  }

  // ---------------------------------------------------------------- game lifecycle

  startGame() {
    if (!this.selectedNation) return;
    const rules = normalizeRules(this.pendingRules);
    const game = new Game({
      scenarioId: this.scenario.id,
      nationId: this.selectedNation,
      doctrineId: this.doctrine,
      map: this.map,
      seed: (Math.random() * 2 ** 31) | 0,
      rules,
    });
    game.setSendRatio(this.preferredRatio);
    this.#attachGame(game);
    this.pendingRules = normalizeRules(rules);
    this.#enterGameScreen();
    if (rules.startPaused) {
      this.lastSpeed = 1;
      this.setSpeed(0);
      this.#toast('Партия ждёт вашего приказа. Снимите паузу, когда будете готовы', 'info');
    }
  }

  #attachGame(game) {
    this.game = game;
    this.scenario = getScenario(game.state.scenarioId);
    this.setTheatre(this.scenario.theatre ?? 'europe');
    this.selectedNation = game.state.nationId;
    this.selectedProvince = null;
    this.preferredRatio = game.state.sendRatio;
    this.#syncRatioButtons();
    this.colorSignature = '';
    this.#clearArmies();
    $('#log').innerHTML = '';
    game.state.log.length = 0;

    game.on((type, payload) => {
      if (type === 'log') this.#addLog(payload);
      if (type === 'capture') {
        this.world.flashProvince(payload.provinceId, 1);
        if (payload.to === game.state.nationId) {
          sfx.capture();
          this.#toast(`Провинция ${game.provinceName(payload.provinceId)} взята`, 'good');
          if (this.selectedProvince === payload.provinceId) this.#renderProvincePanel();
          this.#tip(
            'capture',
            'Провинция ваша. Клик по ней — мануфактура, казармы, крепость и гарнизон',
          );
        } else if (payload.from === game.state.nationId) {
          sfx.loss();
          this.#toast(`Потеряна ${game.provinceName(payload.provinceId)}`, 'bad');
        }
      }
      if (type === 'focus' && payload.nationId === game.state.nationId) {
        this.#toast(`Фокус выполнен: ${payload.step.name} (+${payload.step.gold} золота)`, 'good');
        sfx.select();
        this.#updateFocus();
      }
      if (type === 'incoming') {
        // A marching enemy is the one event that must not be missed because
        // the log is folded: a short toast, throttled so a big war does not
        // bury the screen.
        const now = performance.now();
        if (now - (this.lastIncomingToast ?? 0) > 1200) {
          this.lastIncomingToast = now;
          const who = game.state.nations[payload.attacker]?.short ?? 'Противник';
          this.#toast(`${who}: ${fmt(payload.amount)} → ${game.provinceName(payload.to)}`, 'bad');
        }
      }
      if (type === 'passage' && payload.by === game.state.nationId && payload.broken) {
        const who = game.state.nations[payload.with]?.short ?? 'Противник';
        this.#toast(`${who}: договор о проходе расторгнут`, 'bad');
      }
      if (type === 'offer') {
        sfx.click();
        this.#renderOffers();
      }
      if (type === 'offerClosed') {
        this.#renderOffers();
        if (payload.accepted) {
          const kind = payload.offer?.kind;
          this.#toast(kind === 'tribute' ? 'Дань получена: мир с уступкой' : 'Мир заключён: перемирие', 'good');
        }
        else if (payload.expired) this.#toast('Предложение мира истекло', 'info');
      }
      if (type === 'truceBroken') {
        const victim = this.game.state.nations[payload?.with];
        const who = payload?.by && payload.by !== this.game.state.nationId ? victim?.short : null;
        if (payload?.kind === 'pact') {
          this.#toast(who ? `${who} разрывает пакт` : 'Пакт разорван — вам больше не верят', 'bad');
        } else {
          this.#toast(who ? `${who} нарушает перемирие` : 'Перемирие нарушено — усталость выросла', 'bad');
        }
      }
      if (type === 'battle') {
        const now = performance.now();
        if (now - this.lastBattleSound > 700) {
          this.lastBattleSound = now;
          sfx.battle();
        }
      }
      if (type === 'end') this.#endGame(payload);
    });
  }

  /**
   * Pixels taken by the HUD. The camera fits the map into what is left, so a
   * province is never buried under the order buttons on the right.
   */
  #syncSafeArea() {
    if (!this.world) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const bar = $('#orders-bar');
    const barRect = bar?.getBoundingClientRect();
    const usable = barRect && barRect.width > 0 && barRect.height > 0;
    // The order buttons are a row at the bottom on a desktop and a column on
    // the right on a phone; the map must stay out of whichever it is.
    const column = usable && barRect.right > vw * 0.82 && barRect.height > barRect.width * 0.7;
    const right = column ? Math.max(0, Math.round(vw - barRect.left)) : 0;
    const hud = document.querySelector('.hud-top')?.getBoundingClientRect();
    const foot = document.querySelector('.hud-bottom')?.getBoundingClientRect();
    const footTop = usable && !column ? Math.min(vh, barRect.top) : vh;
    const footInset = foot && foot.height > 0 ? vh - foot.top : vh;
    this.world.setSafeArea({
      top: hud && hud.height > 0 ? Math.round(hud.bottom) : 0,
      right,
      bottom: Math.max(0, Math.round(vh - Math.min(footTop, footInset))),
    });
  }

  #enterGameScreen() {
    this.#setScreen('game');
    // The HUD is on screen now, so the camera has to know how much room is
    // left *before* it frames the realm.
    this.#syncSafeArea();
    this.world.setSelected(null);
    this.world.setAccent([]);
    this.world.setValidTargets([]);
    this.world.resetView();
    this.world.setAutoPan(false);
    this.world.zoomTarget = 1;
    // Open on the player's own lands: centre on their middle (Britain's Canada
    // is far from London) and zoom so the realm is readable on any screen.
    if (this.game) {
      const own = Object.entries(this.game.state.provinces)
        .filter(([, p]) => p.owner === this.game.state.nationId)
        .map(([id]) => id);
      this.world.focusNation(own, 0.5, { anchor: this.game.player.capital });
    }
    requestAnimationFrame(() => this.#syncSafeArea());
    this.labels.setVisible(this.settings.labels);
    this.#syncColors(true);
    this.#updateHud();
    this.#renderProvincePanel();
    this.#updateOrders();
    $('#hint-bar').style.opacity = '1';
    setTimeout(() => {
      const hint = $('#hint-bar');
      if (hint) hint.style.opacity = '0';
    }, 14000);
    this.#onboard();

    const nation = this.game.player;
    this.#addLog({
      text: `${nation.name}: правление началось. Доктрина «${DOCTRINES.find((d) => d.id === nation.doctrine)?.name ?? ''}»`,
      kind: 'order',
      year: Math.floor(this.game.state.months / 12),
    });
    this.save();
    platform.gameplayStart();
  }

  #onboard() {
    this.onboardTimers?.forEach(clearTimeout);
    const timers = [];
    timers.push(
      setTimeout(() => {
        if (this.screen !== 'game') return;
        this.#toast('Зажмите свою провинцию и отпустите на соседней', 'info');
      }, 1200),
    );
    timers.push(
      setTimeout(() => {
        if (this.screen !== 'game') return;
        this.#toast('Клик по провинции открывает улучшения и приказы', 'info');
      }, 7000),
    );
    this.onboardTimers = timers;
  }

  #endGame({ result, reason, rival }) {
    const game = this.game;
    game.state.speed = 0;
    this.#clearArmies();
    localStorage.removeItem(SAVE_KEY);
    this.hasSave = false;
    $('#btn-continue').classList.add('hidden');
    platform.gameplayStop();

    const victory = result === 'victory';
    $('#end-emblem').textContent = victory ? '♛' : '☠';
    const theatre = THEATRES[this.scenario?.theatre ?? 'europe'];
    const atlantic = theatre?.id === 'atlantic';
    const genitive = atlantic ? 'Атлантики' : 'Европы';
    $('#end-eyebrow').textContent = victory ? (atlantic ? 'Два берега ваши' : 'Европа ваша') : 'Держава пала';
    $('#end-title').textContent = victory ? 'Победа' : 'Поражение';
    $('#end-text').textContent = victory
      ? `Каждая провинция ${genitive} под вашей короной. Полное завоевание — единственный способ победить, и у вас это получилось.`
      : reason === 'eliminated'
        ? 'Последнюю провинцию пришлось отдать. В следующий раз держите резервы в глубине и не открывайте все фронты сразу.'
        : 'Ваши земли разделили соседи. В следующий раз начните с укреплений и не открывайте все фронты сразу.';
    const stats = game.state.stats;
    $('#end-stats').innerHTML = `
      <div class="end-stat"><div class="k">Провинций</div><div class="v">${game.progress.owned}</div></div>
      <div class="end-stat"><div class="k">Захвачено</div><div class="v">${stats.captured}</div></div>
      <div class="end-stat"><div class="k">Битв</div><div class="v">${stats.battles}</div></div>
      <div class="end-stat"><div class="k">Пик империи</div><div class="v">${stats.peak}</div></div>
      <div class="end-stat"><div class="k">Потеряно</div><div class="v">${stats.lostProvinces}</div></div>
      <div class="end-stat"><div class="k">Лет правления</div><div class="v">${Math.max(1, Math.round((game.state.months - this.scenario.startYear * 12) / 12))}</div></div>
      <div class="end-stat"><div class="k">Отбито атак</div><div class="v">${stats.battlesWon ?? 0}</div></div>`;
    const score = game.score();
    $('#end-score').innerHTML = `
      <div class="score-line">
        <span class="score-label">Очки партии</span>
        <b class="score-value">${fmt(score.total)}</b>
      </div>
      <div class="score-break">
        <span>земли ${Math.round(score.share * 100)}%</span>
        <span>захваты ${fmt((stats.captured ?? 0) * 60)}</span>
        <span>оборона ${fmt((stats.battlesWon ?? 0) * 25)}</span>
        <span>скорость +${fmt(score.speedBonus)}</span>
        ${score.victory ? '<span class="good">победа +500</span>' : ''}
      </div>`;
    $('#end-board').classList.add('hidden');
    $('#end-board').innerHTML = '';
    platform.submitScore('crowns', score.total).then((submitted) => {
      if (!submitted) return;
      platform.topScores('crowns', 5).then((entries) => {
        if (!entries.length) return;
        $('#end-board').classList.remove('hidden');
        $('#end-board').innerHTML = `
          <div class="board-title">Лучшие правители</div>
          ${entries
            .map(
              (entry) =>
                `<div class="board-row ${entry.self ? 'is-self' : ''}"><span class="board-rank">${entry.rank}</span><span class="board-name">${entry.name}</span><b>${fmt(entry.score)}</b></div>`,
            )
            .join('')}`;
      });
    });
    $('#screen-end').classList.remove('hidden');
    if (victory) sfx.victory();
    else sfx.defeat();
    setTimeout(() => platform.showInterstitial(), 1600);
  }

  #restart() {
    if (!this.scenario || !this.selectedNation) return;
    this.startGame();
  }

  // ---------------------------------------------------------------- screens

  #setScreen(name) {
    this.screen = name;
    for (const id of ['menu', 'nation', 'game']) {
      $(`#screen-${id}`).classList.toggle('hidden', id !== name);
    }
  }

  /** Called when a cloud save is found after the SDK initialises. */
  enableContinue(saved) {
    if (this.hasSave || !saved?.game) return;
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(saved));
    } catch {
      return;
    }
    this.hasSave = true;
    $('#btn-continue').classList.remove('hidden');
  }

  // ---------------------------------------------------------------- map interaction

  #canStartDrag(provinceId) {
    if (this.screen !== 'game' || !this.game) return false;
    const province = this.game.state.provinces[provinceId];
    if (!province || province.owner !== this.game.state.nationId) return false;
    return this.game.state.status === 'playing';
  }

  #dragStart(provinceId) {
    if (!this.game) return;
    if (!$('#province-panel').classList.contains('hidden')) {
      this.panelFolded = true;
      clearTimeout(this.panelFoldTimer);
      this.panelFoldTimer = null;
      this.#applyPanelFold();
    }
    // Not just the neighbours: any province the column can reach through the
    // player's own land (plus the foreign provinces on its borders).
    const targets = [...this.game.routeTargets(provinceId)].filter((id) => id !== provinceId);
    this.world.setValidTargets(targets);
    this.world.setSelected(provinceId);
    sfx.click();
  }

  #dragCancel() {
    this.world.setValidTargets([]);
    this.world.setSelected(this.selectedProvince);
  }

  /**
   * March planner: only for orders that cross friendly provinces. Shows the
   * road, lets the player leave a garrison in any waypoint and sends the rest
   * on to the far end.
   */
  #openRoutePlanner(from, to, route) {
    const game = this.game;
    const waypoints = route.slice(1, -1);
    const sendable = game.sendableTroops(from);
    this.routePlanner = { from, to, route, leave: Object.fromEntries(waypoints.map((id) => [id, 0])) };
    const card = $('#route-card');
    const render = () => {
      const plan = this.routePlanner;
      if (!plan) return;
      const name = (id) => game.provinceName(id);
      const total = Math.round(game.routeTime(plan.route));
      const through = game.routeThrough(plan.route);
      const leftTotal = Object.values(plan.leave).reduce((a, b) => a + b, 0);
      const rows = plan.route
        .slice(1, -1)
        .map((id) => {
          const value = plan.leave[id] ?? 0;
          return `<div class="rc-row">
            <span>${name(id)} · оставить</span>
            <span class="rc-step">
              <button type="button" data-step="${id}" data-delta="-10" ${value <= 0 ? 'disabled' : ''}>−</button>
              <b>${value}</b>
              <button type="button" data-step="${id}" data-delta="10" ${value + 10 > sendable - leftTotal + value ? 'disabled' : ''}>+</button>
            </span>
          </div>`;
        })
        .join('');
      card.innerHTML = `
        <h4>План похода</h4>
        <div class="rc-path">${[plan.route[0], ...plan.route.slice(1)].map(name).join(' → ')}</div>
        <div class="rc-meta">${plan.route.length - 1} ${plan.route.length - 1 === 1 ? 'переход' : plan.route.length - 1 < 5 ? 'перехода' : 'переходов'} · примерно ${total} с · в колонне ${fmt(sendable)} чел.</div>
        ${
          through.length
            ? `<div class="rc-through">Транзит по праву прохода: ${through.map((id) => game.state.nations[id]?.short ?? id).join(', ')} · на чужой земле дорога медленнее на ${Math.round((BAL.passageTravelMul - 1) * 100)}%</div>`
            : ''
        }
        <div class="rc-rows">${
          rows ||
          `<div class="rc-row"><span>Промежуточных провинций нет</span><span></span></div>`
        }</div>
        <div class="rc-actions">
          <button type="button" class="btn ghost" data-rc-cancel>Отмена</button>
          <button type="button" class="btn primary" data-rc-send>Отправить${leftTotal ? ` (${fmt(sendable - leftTotal)})` : ''}</button>
        </div>`;
    };
    this.routeRender = render;
    render();
    card.classList.remove('hidden');
  }

  #closeRoutePlanner() {
    this.routePlanner = null;
    this.routeRender = null;
    $('#route-card').classList.add('hidden');
  }

  #dragDrop(from, to) {
    if (!this.game) return;
    // A long march is planned in a small sheet first: the player chooses how
    // many men stay in each province along the road. Neighbour moves stay
    // instant, as before.
    const route = this.game.neighbors(from).includes(to) ? null : this.game.routeBetween(from, to);
    if (route && route.length > 2) {
      // A new drag while a plan is open means the player changed their mind:
      // replace the old plan instead of quietly sending it.
      const same = this.routePlanner?.from === from && this.routePlanner?.to === to;
      if (!same) this.#openRoutePlanner(from, to, route);
      return;
    }
    if (this.routePlanner) this.#closeRoutePlanner();
    // Marching into the land of the nation that let us through is a betrayal:
    // it is allowed, but only after a second, deliberate drag.
    const check = this.game.canSend(from, to);
    if (check.betrayal) {
      const owner = check.betrayal;
      const name = this.game.state.nations[owner]?.short ?? 'противник';
      const now = performance.now();
      if (!(this.pendingBreak?.owner === owner && now - this.pendingBreak.at < 12000)) {
        this.pendingBreak = { owner, at: now };
        this.#toast(`Проход через ${name}: нападение отменит договор. Перетащите ещё раз`, 'bad');
        this.world.setSelected(from);
        this.#updateHud();
        return;
      }
      this.pendingBreak = null;
    }
    let result = this.game.sendTroops(from, to);
    if (!result.ok && result.needsBreak) {
      const owner = result.with;
      const name = this.game.state.nations[owner]?.short ?? 'противник';
      const now = performance.now();
      // The warning lives long enough for a deliberate second drag, but not so
      // long that some later stray drag tears up a treaty.
      if (this.pendingBreak?.owner === owner && now - this.pendingBreak.at < 12000) {
        // Second deliberate drag: the pact is torn up and the army marches.
        this.pendingBreak = null;
        this.game.breakTruce(owner);
        result = this.game.sendTroops(from, to);
      } else {
        this.pendingBreak = { owner, at: now };
        this.#toast(`Пакт: ${name}. Перетащите ещё раз, чтобы напасть`, 'bad');
        // No province card here: the warning is one line, and the card used to
        // jump out over the map on every first drag across a border.
        this.world.setSelected(from);
        this.#updateHud();
        return;
      }
    }
    if (!result.ok) {
      this.#toast(result.reason, 'bad');
      return;
    }
    sfx.march();
    const hop = result.route && result.route.length > 2 ? ` через ${result.route.length - 2} пров.` : '';
    const neighbours = (result.through ?? [])
      .map((id) => this.game.state.nations[id]?.short ?? id)
      .join(', ');
    const transit = neighbours ? ` · проход: ${neighbours}` : '';
    this.#toast(`${fmt(result.amount)} в походе${result.sea ? ' морем' : ''}${hop}${transit}`, 'good');
    this.world.setValidTargets([]);
    this.world.setSelected(from);
    // Sending troops must not pop the province card over the map every time.
    if (!document.querySelector('#province-panel').classList.contains('hidden')) this.#renderProvincePanel();
    this.#updateHud();
  }

  #click(provinceId) {
    if (this.screen === 'nation') {
      if (!provinceId) return;
      const owner = this.scenario.nations.find((n) => n.provinces.includes(provinceId));
      if (owner) this.#selectNation(owner.id, false);
      return;
    }
    if (this.screen !== 'game' || !this.game) return;
    if (this.autoFrom) {
      const from = this.autoFrom;
      if (!provinceId || provinceId === from) {
        this.autoFrom = null;
        this.#renderProvincePanel();
        return;
      }
      const result = this.game.addAuto(from, provinceId, this.#autoDefaults(from).when, this.#autoDefaults(from).keep);
      this.autoFrom = null;
      if (result.ok) {
        this.#toast(`Приказ: из «${this.game.provinceName(from)}» в «${this.game.provinceName(provinceId)}»`, 'good');
        sfx.select();
      } else {
        this.#toast(result.reason, 'bad');
      }
      this.selectedProvince = from;
      this.world.setSelected(from);
      this.#renderProvincePanel();
      this.#updateHud();
      return;
    }
    if (!provinceId) {
      this.selectedProvince = null;
      this.world.setSelected(null);
      $('#province-panel').classList.add('hidden');
      return;
    }
    if (this.selectedProvince === provinceId) {
      // A second tap on the same province is «убери это с карты».
      this.selectedProvince = null;
      this.world.setSelected(null);
      $('#province-panel').classList.add('hidden');
      sfx.click();
      return;
    }
    this.selectedProvince = provinceId;
    this.panelFolded = false;
    this.world.setSelected(provinceId);
    this.#renderProvincePanel();
    this.#armPanelFold();
    sfx.click();
  }

  #hover(provinceId) {
    this.hoveredProvince = provinceId || null;
    if (this.world.dragFrom) {
      this.#tooltip(null);
      return;
    }
    if (this.screen !== 'game' || !this.game) return;
    const game = this.game;
    const province = game.state.provinces[provinceId];
    if (!province) {
      this.#tooltip(null);
      return;
    }
    const owner = province.owner ? game.state.nations[province.owner] : null;
    const defense = game.defenseValue(province.id);
    const mine = owner?.id === game.state.nationId;
    const lines = [
      `Гарнизон ${Math.round(province.garrison)}`,
      `Оборона ${Math.round(defense)}`,
    ];
    let warn = null;
    if (!mine) {
      // «Шанс взять 0%» on its own read like a bug: a nation with far more men
      // in the neighbouring province still saw zero. Show what will actually
      // march and how many men the battle needs.
      if (owner && game.hasTruce(owner.id, game.state.nationId)) {
        warn = `Пакт: ещё ${Math.ceil(game.truceLeft(owner.id))} с. Нападение его нарушит`;
      }
      const odds = game.bestAttackOdds(province.id);
      if (!odds) {
        lines.push('Нет соседней своей провинции');
      } else {
        const share = Math.round(game.state.sendRatio * 100);
        // The denominator is the troops at home in `odds.from`, not the garrison
        // of the province under the pointer: «138 из 84» made no sense.
        const source = game.state.provinces[odds.from];
        lines.push(`Шанс взять ${Math.round(odds.chance * 100)}%`);
        lines.push(`В бой: ${fmt(odds.troops)} из ${fmt(source?.garrison ?? 0)} (${share}%)`);
        lines.push(
          odds.chance === 0
            ? `Мало: нужно хотя бы ${fmt(odds.minToWin)}`
            : `Наверняка хватит ${fmt(odds.guarantee)}`,
        );
      }
    } else {
      const over = Math.round(province.garrison - game.maxGarrison(province.id));
      lines.push(over > 0 ? `Сверх нормы +${over}` : 'Ваши земли');
    }
    this.#tooltip(provinceId, {
      title: game.provinceName(provinceId),
      owner: owner ? owner.name : this.#unownedLabel(provinceId),
      lines,
      warn,
    });
  }

  #tooltip(provinceId, content) {
    let el = $('#tooltip');
    if (!el) {
      el = document.createElement('div');
      el.id = 'tooltip';
      el.className = 'toast';
      el.style.position = 'absolute';
      el.style.zIndex = '7';
      el.style.pointerEvents = 'none';
      el.style.transform = 'translate(-50%, -140%)';
      $('#armies').appendChild(el);
    }
    if (!provinceId) {
      el.style.display = 'none';
      return;
    }
    const pos = this.world.projectProvince(provinceId);
    // «Монголия / Монголия» is noise: the country line only appears when it
    // says something the title does not.
    const showOwner = content.owner && content.owner !== content.title;
    el.innerHTML = `
      <span class="tt-title">${content.title}</span>
      ${showOwner ? `<span class="tt-owner">${content.owner}</span>` : ''}
      <span class="tt-lines">${content.lines.map((line) => `<b>${line}</b>`).join('')}</span>
      ${content.warn ? `<span class="tt-warn">${content.warn}</span>` : ''}`;
    el.classList.add('tt');
    el.style.display = 'block';
    el.style.left = `${pos.x}px`;
    el.style.top = `${pos.y}px`;
  }

  // ---------------------------------------------------------------- HUD

  #updateHud() {
    if (!this.game) return;
    const game = this.game;
    const player = game.player;
    const progress = game.progress;

    $('#hud-nation').textContent = player.short;
    $('#hud-color').style.background = player.color;
    $('#hud-color').style.color = player.color;
    $('#hud-date').textContent = game.dateLabel;
    $('#hud-gold').textContent = fmt(player.gold);
    $('#hud-income').textContent = `+${player.income.toFixed(1)}/с`;
    $('#hud-manpower').textContent = fmt(player.manpower);
    $('#hud-mp-rate').textContent = `+${((player.manpowerRate ?? 0) * 60).toFixed(0)}/мин`;
    const morale = Math.round(player.morale ?? 55);
    const exhaustion = Math.round(player.exhaustion ?? 0);
    $('#hud-morale').textContent = morale;
    $('#hud-morale-label').textContent = morale >= 65 ? 'дух высокий' : morale <= 40 ? 'дух низкий' : 'дух';
    $('#hud-exhaustion').textContent = `усталость ${exhaustion}%`;
    const spirit = $('#hud-spirit');
    spirit.classList.toggle('is-low', morale <= 40);
    spirit.classList.toggle('is-tired', exhaustion >= 45);
    this.#updateFocus();
    $('#hud-progress-text').textContent = `${progress.owned}/${progress.total}`;
    $('#hud-progress-fill').style.width = `${(progress.share * 100).toFixed(1)}%`;

    for (const button of $('#speed-group').children) {
      const speed = Number(button.dataset.speed);
      button.classList.toggle('active', speed === game.state.speed);
    }
    this.#updateOrders();
    this.#renderOffers();
    if (this.selectedProvince) this.#renderProvincePanel();
    // The hover card must agree with the current men, ratio and truces, not
    // with the moment the pointer happened to stop.
    if (this.hoveredProvince) this.#hover(this.hoveredProvince);
    if (!$('#modal-rankings').classList.contains('hidden')) this.#renderRankings();
  }

  #offerText(offer) {
    const game = this.game;
    const left = Math.max(0, Math.ceil(offer.expires - game.state.time));
    if (offer.kind === 'passage') {
      return `Право прохода: ${Math.round(BAL.passageTruce)} с их колонны могут идти через вашу землю. Решение за вами — ${left} с.`;
    }
    const pact = offer.kind === 'pact';
    if (offer.kind === 'tribute') {
      const parts = [];
      const province = offer.terms?.province;
      if (province) parts.push(`провинция «${game.provinceName(province)}»`);
      if (offer.terms?.gold > 0) parts.push(`${offer.terms.gold} золота`);
      return `Мир с уступкой: ${parts.length ? parts.join(' и ') : 'без дани'} — перемирие ${Math.round(BAL.tributeTruce)} с. Решение за вами — ${left} с.`;
    }
    return pact
      ? `Пакт о ненападении: ${Math.round(BAL.pactTruce)} с без нападений. Решение за вами — ${left} с.`
      : `Перемирие ${Math.round(BAL.peaceTruce)} с. Обе стороны теряют усталость. Решение за вами — ${left} с.`;
  }

  #renderOffers() {
    const card = $('#offer-card');
    if (!card) return;
    const game = this.game;
    const offers = game?.state?.offers ?? [];
    if (!game || !offers.length || game.state.status !== 'playing') {
      if (this.offerSignature) {
        card.classList.add('hidden');
        card.innerHTML = '';
        this.offerSignature = '';
      }
      return;
    }
    const signature = offers
      .map((offer) => `${offer.id}:${offer.kind ?? 'peace'}:${offer.terms?.province ?? ''}:${offer.terms?.gold ?? ''}`)
      .join(',');
    // Rebuilding the card under the pointer eats the click (mousedown and mouseup
    // land on different nodes), so only tick the countdowns until the set changes.
    if (signature !== this.offerSignature) {
      card.innerHTML = offers
        .map((offer) => {
          const nation = game.state.nations[offer.from];
          const pact = offer.kind === 'pact';
          const passage = offer.kind === 'passage';
          return `
          <div class="offer-row" data-offer="${offer.id}">
            <span class="offer-dot" style="--swatch:${nation?.color ?? '#888'}"></span>
            <div class="offer-text">
              <b>${offerTitle(nation?.short ?? 'Противник', offer.kind ?? 'peace')}</b>
              <span data-offer-text="${offer.id}">${this.#offerText(offer)}</span>
            </div>
            <div class="offer-actions">
              <button class="btn small primary" data-answer="1">${pact ? 'Принять пакт' : passage ? 'Пустить' : offer.kind === 'tribute' ? 'Взять дань' : 'Принять'}</button>
              <button class="btn small ghost" data-answer="0">${pact ? 'Отклонить' : passage ? 'Не пускать' : 'Воевать'}</button>
            </div>
          </div>`;
        })
        .join('');
      this.offerSignature = signature;
    } else {
      for (const offer of offers) {
        const line = card.querySelector(`[data-offer-text="${offer.id}"]`);
        if (line) line.textContent = this.#offerText(offer);
      }
    }
    card.classList.remove('hidden');
  }

  #updateOrders() {
    if (!this.game) return;
    const game = this.game;
    const state = game.state;
    for (const button of $('#orders-bar').children) {
      const kind = button.dataset.order;
      const cooldown = state.orders[`${kind}Ready`] - state.time;
      const buffActive =
        (kind === 'tax' && state.time < state.orders.taxUntil) ||
        (kind === 'march' && state.time < state.orders.marchUntil);
      const cd = button.querySelector('.o-cd');
      const cost = BAL.orderGold[kind];
      if (cooldown > 0) {
        cd.textContent = Math.ceil(cooldown);
        cd.classList.remove('hidden');
      } else {
        cd.classList.add('hidden');
      }
      button.classList.toggle('active-buff', buffActive);
      button.disabled = cooldown > 0 || game.player.gold < cost || state.status !== 'playing';
    }
  }

  /**
   * On a short landscape screen the onboarding pill sits exactly where the
   * province card opens: hide it while the card is up instead of overlapping.
   */
  #syncHint(panel = $('#province-panel')) {
    const hint = $('#hint-bar');
    if (!hint || !panel) return;
    hint.classList.toggle('muted', !panel.classList.contains('hidden'));
  }

  /**
   * «Сейчас» — the one thing the player needs to know this second: an offer
   * waiting for an answer, a column already marching at their land, or their
   * own troops on the road. Silence when nothing is happening: a permanent
   * banner becomes wallpaper and stops being read.
   */
  #nowInfo() {
    const game = this.game;
    if (!game) return null;
    const s = game.state;
    const me = s.nationId;
    const name = (id) => s.nations[id]?.short ?? '—';
    const finalTo = (a) => (a.path ? a.path[a.path.length - 1] : a.to);
    const offer = s.offers?.[0];
    if (offer) {
      const what =
        offer.kind === 'tribute'
          ? 'мир с уступкой'
          : offer.kind === 'passage'
            ? 'право прохода'
            : offer.kind === 'pact'
              ? 'пакт'
              : 'мир';
      return { text: `${name(offer.from)} предлагает ${what} — ответьте в карточке`, kind: 'warn' };
    }
    const incoming = s.armies.filter(
      (a) => a.owner !== me && s.provinces[finalTo(a)]?.owner === me && !game.hasTruce(a.owner, me),
    );
    if (incoming.length) {
      incoming.sort((a, b) => a.duration - a.t - (b.duration - b.t));
      const first = incoming[0];
      const to = finalTo(first);
      const left = Math.max(0, Math.ceil(first.duration - first.t));
      const capital = to === s.nations[me]?.capital ? ' — столица' : '';
      const more = incoming.length > 1 ? ` · ещё ${incoming.length - 1}` : '';
      return {
        text: `Колонна ${name(first.owner)} → ${game.provinceName(to)}${capital} · ${left} с${more}`,
        kind: 'warn',
      };
    }
    const mine = s.armies.filter((a) => a.owner === me);
    if (mine.length) return { text: `${plural(mine.length, 'колонна', 'колонны', 'колонн')} в пути`, kind: 'info' };
    return null;
  }

  /** Repaints the «Сейчас» line only when its text actually changes. */
  #syncNow() {
    const bar = $('#now-bar');
    if (!bar) return;
    if (this.screen !== 'game' || !this.game || this.hintTimer) {
      if (this.nowSignature) {
        bar.classList.add('hidden');
        this.nowSignature = '';
      }
      return;
    }
    const info = this.#nowInfo();
    const signature = info ? `${info.kind}:${info.text}` : '';
    if (signature === this.nowSignature) return;
    this.nowSignature = signature;
    if (!info) {
      bar.classList.add('hidden');
      return;
    }
    bar.textContent = info.text;
    bar.className = `now-bar ${info.kind}`;
    // A live status wins over the onboarding pill sitting in the same slot.
    const hint = $('#hint-bar');
    if (hint) hint.style.opacity = '0';
  }

  /** One-line instruction at the top of the map. */
  #hint(text) {
    const bar = $('#hint-bar');
    if (!bar) return;
    bar.textContent = text;
    bar.classList.add('muted');
    bar.style.opacity = '1';
    clearTimeout(this.hintTimer);
    this.hintTimer = setTimeout(() => {
      bar.style.opacity = '0';
      this.hintTimer = null;
    }, 6000);
  }

  #renderProvincePanel() {
    // Live numbers must not replace the button under the pointer mid-click.
    if (this.pressing) return;
    const panel = $('#province-panel');
    if (!this.game || !this.selectedProvince) {
      panel.classList.add('hidden');
      this.#syncHint(panel);
      return;
    }
    const game = this.game;
    const province = game.state.provinces[this.selectedProvince];
    if (!province) {
      panel.classList.add('hidden');
      this.#syncHint(panel);
      return;
    }
    panel.classList.remove('hidden');
    this.#syncHint(panel);
    const owner = province.owner ? game.state.nations[province.owner] : null;
    const isMine = province.owner === game.state.nationId;
    const max = game.maxGarrison(province.id);
    const defense = game.defenseValue(province.id);
    const share = clamp(province.garrison / Math.max(1, max), 0, 1);
    const over = Math.max(0, Math.round(province.garrison - max));
    const marching = game.troopsInTransit(province.id);
    const marchingCount = game.armiesFrom(province.id).length;
    // Above the norm the flow continues automatically, just slower; at the
    // ceiling it stops. The model owns this number so the panel cannot drift.
    const regen = game.garrisonRate(province);
    const breakdown = game.defenseBreakdown(province.id);
    const income = (BAL.incomeBase + province.pop * BAL.incomePop) * (1 + province.factory * BAL.factoryIncome);
    const doctrineIncome = 1 + (game.player.doctrine === 'coin' ? 0.3 : 0);
    const recruits = (BAL.manpowerBase + province.pop * BAL.manpowerPop) * (1 + province.factory * BAL.factoryManpower);

    const upgrades = Object.values(UPGRADES)
      .map((upgrade) => {
        const level = province[upgrade.id] ?? 0;
        const maxed = level >= BAL.maxLevel;
        const cost = maxed ? 0 : BAL.upgradeCosts[upgrade.id][level];
        const affordable = !maxed && game.player.gold >= cost;
        const pips = Array.from({ length: BAL.maxLevel }, (_, i) => `<i class="${i < level ? 'on' : ''}"></i>`).join('');
        const shortfall = !maxed && !affordable ? `не хватает ${Math.ceil(cost - game.player.gold)}` : null;
        const preview = maxed ? null : game.upgradePreview(province.id, upgrade.id);
        return `
          <button class="upg ${maxed ? 'is-max' : ''}" data-kind="${upgrade.id}"
            ${!isMine || maxed || !affordable ? 'disabled' : ''}
            title="${upgrade.description}">
            <span class="u-icon">${icon(upgrade.icon, 16)}</span>
            <span class="u-body">
              <span class="u-line">
                <span class="u-name">${upgrade.name}</span>
                <span class="u-pips">${pips}</span>
              </span>
              <span class="u-sub">${maxed ? 'максимальный уровень' : shortfall ?? preview?.text ?? upgrade.short}</span>
            </span>
            <span class="u-cost">${maxed ? '—' : `${cost} золота`}</span>
          </button>`;
      })
      .join('');

    panel.innerHTML = `
      <div class="pp-head">
        <span class="pp-swatch" style="--swatch:${owner?.color ?? this.#provinceColor(province)}"></span>
        <div class="pp-title">
          <h3 class="pp-name">${game.provinceName(province.id)}</h3>
          <div class="pp-owner">
            ${owner ? owner.name : this.#unownedLabel(province.id)}
            ${isMine ? '<span class="pp-badge">ваша</span>' : ''}
          </div>
        </div>
        <button class="pp-fold" data-fold title="Свернуть карточку" aria-label="Свернуть карточку"></button>
        <button class="pp-close" data-close title="Закрыть">✕</button>
      </div>

      <div class="pp-meter">
        <div class="meter-head">
          <span class="meter-label">Гарнизон</span>
          <span class="meter-value">${fmt(province.garrison)} <s>/ ${fmt(max)}</s></span>
        </div>
        <div class="meter ${over > 0 ? 'is-over' : ''}"><i style="width:${(share * 100).toFixed(1)}%"></i></div>
        <div class="meter-foot">
          <span>${
            over > 0
              ? `<b class="over-note">сверх нормы +${fmt(over)}</b>`
              : isMine
                ? `Пополнение +${regen.toFixed(1)}/с`
                : 'Пополнение нет'
          }</span>
          <span>Оборона <b>${fmt(defense)}</b></span>
        </div>
        ${
          marching > 0
            ? `<div class="march-note">В пути: <b>${fmt(marching)}</b> · ${marchingCount} ${marchingCount === 1 ? 'отряд' : marchingCount < 5 ? 'отряда' : 'отрядов'}</div>`
            : ''
        }
        ${
          isMine && breakdown
            ? `<div class="defense-note">${
                over > 0
                  ? `Сверх нормы ${fmt(breakdown.above)} — вполсилы (×${BAL.overstackDefense}); ${
                      province.garrison >= game.garrisonCeiling(province.id)
                        ? 'предел снабжения'
                        : game.player.manpower > 0
                          ? `набор +${regen.toFixed(2)}/с`
                          : 'нет рекрутов'
                    }. `
                  : ''
              }Крепость ×${breakdown.fortMul.toFixed(2)} · доктрина ×${breakdown.doctrineMul.toFixed(2)} · дух ×${breakdown.moraleMul.toFixed(2)}</div>`
            : ''
        }
      </div>

      <div class="pp-rows">
        ${
          !isMine
            ? (() => {
                const odds = game.bestAttackOdds(province.id);
                if (!odds) {
                  return '<div class="pp-row"><span>Штурм</span><b class="muted">нет соседней своей провинции</b></div>';
                }
                const chance = Math.round(odds.chance * 100);
                const tone = odds.chance >= 0.85 ? 'good' : odds.chance >= 0.5 ? 'warn' : 'bad';
                const grown = odds.defense > odds.defenseNow * 1.02;
                return `<div class="pp-row"><span>Шанс взять</span><b class="odds ${tone}">${chance}%</b></div>
                  <div class="pp-row"><span>Уйдёт в бой</span><b>${fmt(odds.troops)} чел. · ${game.provinceName(odds.from)}</b></div>
                  <div class="pp-row"><span>Оборона к прибытию</span><b>${fmt(odds.defense)}${
                    grown ? ` <span class="muted">(сейчас ${fmt(odds.defenseNow)})</span>` : ''
                  }</b></div>
                  <div class="pp-row"><span>${chance === 0 ? 'Хотя бы нужно' : 'Наверняка хватит'}</span><b>${fmt(
                    chance === 0 ? odds.minToWin : odds.guarantee,
                  )} чел.</b></div>
                  ${
                    chance === 0
                      ? `<div class="pp-row"><span>Доля войск</span><b class="muted">${Math.round(
                          game.state.sendRatio * 100,
                        )}% — мало, перетащите больше</b></div>`
                      : ''
                  }`;
              })()
            : ''
        }
        <div class="pp-row"><span>Население</span><b>${(province.pop * this.#popScale()).toFixed(1)} млн</b></div>
        ${
          // Income and recruits are only ever paid to the owner: on a foreign
          // province they were three rows of dashes that pushed the pact
          // button under the fold of a phone card.
          isMine
            ? `<div class="pp-row"><span>Доход провинции</span><b class="gold">+${(income * doctrineIncome).toFixed(2)} золота/с</b></div>
        <div class="pp-row"><span>Прирост рекрутов</span><b>+${(recruits * 60).toFixed(0)}/мин</b></div>`
            : ''
        }
        <div class="pp-row"><span>Крепость</span><b>${province.fort > 0 ? `уровень ${province.fort} из ${BAL.maxLevel}` : 'нет'}</b></div>
      </div>

      ${isMine ? this.#autoInline(province.id) : ''}
      ${isMine ? this.#armiesBlock(province.id) : ''}
      ${isMine ? this.#passageInline() : ''}
      ${!isMine && owner ? this.#diploBlock(owner) : ''}
      ${
        isMine
          ? `<div class="pp-section"><span>Развитие провинции</span></div>
      <div class="pp-upgrades">${upgrades}</div>
      ${this.#autoBlock(province.id)}`
          : ''
      }
      <p class="pp-hint">${
        isMine
          ? `Перетащите войска на соседнюю провинцию, чтобы усилить её или атаковать: уйдёт ${Math.round(game.state.sendRatio * 100)}% гарнизона (${fmt(game.sendableTroops(province.id))} чел.). Можно отправлять сразу в несколько сторон — из провинции уйдёт столько отрядов, сколько вы прикажете.`
          : `Оборона ${fmt(defense)}: ${fmt(breakdown.effective)} боевых войск × ${breakdown.fortMul.toFixed(2)} крепость × ${breakdown.doctrineMul.toFixed(2)} доктрина × ${breakdown.moraleMul.toFixed(2)} дух. Шанс — для доли ${Math.round(game.state.sendRatio * 100)}% и с учётом пополнения защитника в пути.`
      }</p>
    `;
    this.#markPanelOverflow(panel);
    this.#applyPanelFold(panel);
  }

  /**
   * The province card is useful for a few seconds and then only covers the map.
   * It folds down to its header when the player moves on (starts a drag, taps
   * the map, or simply stops using it), and unfolds again on any interaction.
   * That is the difference between a tool and a «шторка», which used to hang
   * over the left corner for the whole match.
   */
  #applyPanelFold(panel = $('#province-panel')) {
    if (!panel) return;
    panel.classList.toggle('is-folded', this.panelFolded);
  }

  // Only interaction restarts the countdown: the game tick re-renders the card
  // every second, and re-arming there would keep it open for the whole match.
  #armPanelFold() {
    clearTimeout(this.panelFoldTimer);
    this.panelFoldTimer = null;
    if (this.panelFolded || !this.game) return;
    // A card that fills half a phone screen gets far less patience than a
    // sidebar on a monitor.
    const touch = window.matchMedia?.('(pointer: coarse)')?.matches ?? false;
    this.panelFoldTimer = setTimeout(() => {
      if (!this.game || this.pressing) return;
      // On a phone the last tapped element keeps a sticky :hover, so the check
      // only makes sense for real pointer devices.
      const panel = $('#province-panel');
      if (!touch && panel.matches(':hover')) {
        // Still being read: give it another chance instead of yanking it away.
        this.#armPanelFold();
        return;
      }
      this.panelFolded = true;
      this.#applyPanelFold(panel);
    }, touch ? 9000 : 18000);
  }

  #unfoldPanel() {
    if (!this.panelFolded) return;
    this.panelFolded = false;
    this.#applyPanelFold();
    this.#armPanelFold();
  }

  /** A scrolled card gets a soft bottom edge instead of a row cut in half. */
  #markPanelOverflow(panel = $('#province-panel')) {
    if (!panel) return;
    const update = () => {
      const atEnd = panel.scrollTop + panel.clientHeight >= panel.scrollHeight - 2;
      panel.classList.toggle('has-more', panel.scrollHeight > panel.clientHeight + 2 && !atEnd);
    };
    update();
    if (!panel.__hasScrollListener) {
      panel.__hasScrollListener = true;
      panel.addEventListener('scroll', update, { passive: true });
    }
  }

  /**
   * Standing orders of one province: «when this province holds N men, send
   * everything above K to the target». Compact rows, two steppers each, and one
   * button that turns the map into a target picker.
   */
  /** Sensible starting numbers: leave about half the norm, send above 80 %. */
  #autoDefaults(provinceId) {
    const norm = Math.max(20, this.game.maxGarrison(provinceId));
    return { when: Math.round(norm * 0.8), keep: Math.round(norm * 0.5) };
  }

  /**
   * One-line entry to the standing orders, shown high in the card (right under
   * the garrison numbers) so the mechanic is visible without scrolling — the
   * full block lived below three upgrade rows and never made it into the first
   * screenful on a landscape phone.
   */
  #autoInline(provinceId) {
    const game = this.game;
    if (!game) return '';
    if (this.autoFrom === provinceId) return '';
    if (game.autoOrdersFrom(provinceId).length) return '';
    return `
      <div class="pp-section pp-section-inline">
        <span>Автоотправка</span>
        <button class="pp-mini" data-auto-add="${provinceId}" title="Когда гарнизон вырастет, войска уйдут сами">+ приказ</button>
      </div>`;
  }

  #autoBlock(provinceId) {
    const game = this.game;
    if (!game) return '';
    const orders = game.autoOrdersFrom(provinceId);
    const picking = this.autoFrom === provinceId;
    if (!orders.length && !picking) return '';
    const rows = orders
      .map((order) => {
        const target = game.provinceName(order.to);
        const amount = game.autoAmount(order);
        return `<div class="pp-auto-row">
          <div class="pp-auto-head">
            <b>→ ${target}</b>
            <button class="pp-auto-del" data-auto-del="${order.id}" title="Удалить приказ">✕</button>
          </div>
          <div class="pp-auto-steps">
            <span class="pp-auto-key">когда здесь ≥</span>
            <span class="pp-step">
              <button type="button" data-auto-step="${order.id}" data-field="when" data-delta="-10">−</button>
              <b>${fmt(order.when)}</b>
              <button type="button" data-auto-step="${order.id}" data-field="when" data-delta="10">+</button>
            </span>
          </div>
          <div class="pp-auto-steps">
            <span class="pp-auto-key">оставлять</span>
            <span class="pp-step">
              <button type="button" data-auto-step="${order.id}" data-field="keep" data-delta="-10">−</button>
              <b>${fmt(order.keep)}</b>
              <button type="button" data-auto-step="${order.id}" data-field="keep" data-delta="10">+</button>
            </span>
            <span class="pp-auto-now">уйдёт ${fmt(amount)}</span>
          </div>
        </div>`;
      })
      .join('');
    return `
      <div class="pp-section"><span>Автоотправка</span></div>
      <div class="pp-auto">
        ${rows || '<p class="pp-auto-empty">Каждый раз одно и то же перетаскивание? Настройте приказ: когда гарнизон вырастет, войска уйдут сами.</p>'}
        <button class="pp-action ${picking ? 'danger' : ''}" data-auto-add="${provinceId}">
          ${picking ? 'Выберите провинцию на карте…' : 'Добавить приказ'}
        </button>
      </div>`;
  }

  /**
   * Diplomacy for a foreign province: a pact you can offer, or the pact you
   * already have and the price of breaking it. Kept to one line of text and one
   * small button — no half-screen dialog.
   */
  #diploBlock(owner) {
    const game = this.game;
    const me = game.state.nationId;
    if (owner.id === me) return '';
    const left = Math.ceil(game.truceLeft(owner.id));
    const passage = Math.ceil(game.passageLeft(owner.id, me));
    const fought = game.hasFoughtRecently(owner.id, me);
    const waitPact = Math.ceil((owner.pactAskedUntil ?? 0) - game.state.time);
    const waitPass = Math.ceil((owner.passageAskedUntil ?? 0) - game.state.time);
    const word = (value) =>
      value >= 0.6 ? 'Скорее согласятся' : value >= 0.38 ? 'Могут согласиться' : value >= 0.22 ? 'Вряд ли согласятся' : 'Почти наверняка откажут';
    const pactRow = left > 0
      ? `<div class="pp-pact"><i></i>Пакт о ненападении · ещё ${left} с</div>
         <div class="pp-diplo-row">
           <button class="pp-action danger" data-break="${owner.id}">Нарушить пакт</button>
           <span class="pp-diplo-hint">Нападение нарушит договор. Это запомнят.</span>
         </div>`
      : `<div class="pp-diplo-row">
           <button class="pp-action" data-pact="${owner.id}" ${waitPact > 0 ? 'disabled' : ''}>
             ${fought ? 'Предложить мир' : 'Предложить пакт'}
           </button>
           <span class="pp-diplo-hint">${waitPact > 0 ? `Ответят через ${waitPact} с` : word(game.pactOutlook(owner.id))}</span>
         </div>`;
    const passRow = passage > 0
      ? `<div class="pp-pact pass"><i></i>Право прохода · ещё ${passage} с</div>
         <p class="pp-warn soft">Ваши колонны могут идти через землю ${owner.short}. Нападение отменит проход.</p>`
      : `<div class="pp-diplo-row">
           <button class="pp-action" data-passage="${owner.id}" ${waitPass > 0 ? 'disabled' : ''}>Попросить проход</button>
           <span class="pp-diplo-hint">${
             waitPass > 0
               ? `Ответят через ${waitPass} с`
               : game.hasWar(owner.id, me)
                 ? 'Сначала нужен мир'
                 : word(game.passageOutlook(owner.id))
           }</span>
         </div>`;
    const oath = game.player.oathbreaks ?? 0;
    return `
      <div class="pp-diplo">
        ${pactRow}
        ${passRow}
        ${oath > 0 ? `<p class="pp-warn soft">Нарушено договоров: ${oath} — вам верят меньше.</p>` : ''}
      </div>`;
  }

  /**
   * Columns that left this province and are still on the road. A march that
   * turns out to be a mistake can be called back from here instead of being a
   * decision made once and paid for in full.
   */
  #armiesBlock(provinceId) {
    const game = this.game;
    if (!game) return '';
    const columns = game.armiesFrom(provinceId).filter((army) => !army.returning);
    if (!columns.length) return '';
    const rows = columns
      .map(
        (army) => `<div class="pp-army-row">
          <span class="pp-army-to">→ ${game.provinceName(army.to)}</span>
          <span class="pp-army-meta">${fmt(army.troops)} чел. · ${Math.ceil(army.left)} с${army.sea ? ' · морем' : ''}</span>
          <button class="pp-mini danger" data-recall="${army.id}">Отозвать</button>
        </div>`,
      )
      .join('');
    return `
      <div class="pp-section"><span>В пути</span></div>
      <div class="pp-armies">${rows}</div>`;
  }

  /** Rights of passage that involve the player, shown on their own province. */
  #passageInline() {
    const game = this.game;
    const me = game.state.nationId;
    const mine = game.passagesOf(me); // they let our columns through
    const theirs = game.passagesGrantedBy(me); // we let their columns through
    if (!mine.length && !theirs.length) return '';
    const name = (id) => game.state.nations[id]?.short ?? id;
    const rows = [
      ...mine.map(({ id, left }) => `<span class="pp-pass-tag" title="Ваши войска могут идти через эту страну">→ ${name(id)} · ${Math.ceil(left)} с</span>`),
      ...theirs.map(({ id, left }) => `<span class="pp-pass-tag back" title="Их войска могут идти через вашу землю">← ${name(id)} · ${Math.ceil(left)} с</span>`),
    ];
    return `
      <div class="pp-passages">
        <span class="pp-pass-label">Право прохода</span>
        <div class="pp-pass-list">${rows.join('')}</div>
      </div>`;
  }

  /** HUD chip and card for the historical focus (a HOI-like national goal). */
  #updateFocus() {
    const game = this.game;
    const chip = $('#btn-focus');
    if (!game) {
      chip.classList.add('hidden');
      return;
    }
    chip.classList.remove('hidden');
    const focus = game.focusOf();
    const progress = game.focusProgress();
    const label = $('#hud-focus');
    if (!focus) {
      label.textContent = 'Фокус выполнен';
      chip.classList.add('is-done');
    } else {
      label.textContent = focus.name;
      chip.classList.remove('is-done');
    }
    if (!$('#focus-card').classList.contains('hidden')) this.#renderFocusCard();
    chip.title = focus
      ? `Фокус ${progress.step} из ${progress.total}: ${focus.name} — взять ${game.provinceName(focus.target)}`
      : 'Все исторические задачи выполнены';
  }

  #renderFocusCard() {
    const game = this.game;
    const card = $('#focus-card');
    if (!game) return;
    const focus = game.focusOf();
    const progress = game.focusProgress();
    const chain = game.player.focus?.chain ?? [];
    const dots = chain
      .map((step, index) => `<span class="fc-dot ${index < progress.done ? 'on' : ''}"></span>`)
      .join('');
    if (!focus) {
      card.innerHTML = `
        <div class="fc-head"><span class="fc-eyebrow">Исторический фокус</span></div>
        <h4>Все задачи выполнены</h4>
        <div class="fc-target">Держава добилась всего, что намечала. Дальше — только карта.</div>
        <div class="fc-chain">${dots}</div>
        <div class="fc-actions"><button type="button" class="btn ghost" data-fc-close>Понятно</button></div>`;
      return;
    }
    const target = game.state.provinces[focus.target];
    const holder = target?.owner ? game.state.nations[target.owner]?.short : 'нейтральная';
    card.innerHTML = `
      <div class="fc-head">
        <span class="fc-eyebrow">Исторический фокус</span>
        <span class="fc-step">${progress.step} из ${progress.total}</span>
      </div>
      <h4>${focus.name}</h4>
      <div class="fc-target">Взять <b>${game.provinceName(focus.target)}</b> — сейчас ${holder}.</div>
      <div class="fc-reward"><span>Награда: <b>+${focus.gold} золота</b></span><span><b>+${focus.morale} духа</b></span></div>
      <div class="fc-chain">${dots}</div>
      <div class="fc-actions"><button type="button" class="btn ghost" data-fc-close>Скрыть</button></div>`;
  }

  #buildOrders() {
    const bar = $('#orders-bar');
    bar.innerHTML = '';
    for (const order of Object.values(ORDERS)) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'order';
      button.dataset.order = order.id;
      button.title = order.description;
      button.innerHTML = `
        <span class="o-icon">${icon(order.icon, 16)}</span>
        <span class="o-name">${order.name}</span>
        <span class="o-cost">${BAL.orderGold[order.id]} золота</span>
        <span class="o-cd hidden"></span>`;
      button.addEventListener('click', () => this.#castOrder(order.id));
      bar.appendChild(button);
    }
  }

  #castOrder(kind) {
    if (!this.game) return;
    const result = this.game.castOrder(kind);
    if (!result.ok) {
      this.#toast(result.reason, 'bad');
      return;
    }
    sfx.coin();
    this.#updateHud();
  }

  /**
   * The log can be tucked away. The choice is remembered, because a player who
   * folded it once does not want it unfolding on the next match.
   */
  #wireLogDock() {
    const dock = $('#log-dock');
    const toggle = $('#log-toggle');
    if (!dock || !toggle) return;
    // The log is part of the game the player likes, so it starts open. The pill
    // stays for anyone who wants the corner back, and the choice sticks.
    let collapsed = false;
    try {
      const saved = localStorage.getItem('crowns.logCollapsed');
      if (saved !== null) collapsed = saved === '1';
    } catch {
      collapsed = false;
    }
    const apply = (value) => {
      dock.classList.toggle('is-collapsed', value);
      toggle.setAttribute('aria-expanded', String(!value));
      toggle.title = value ? 'Показать журнал событий' : 'Свернуть журнал событий';
    };
    apply(collapsed);
    toggle.addEventListener('click', () => {
      const next = !dock.classList.contains('is-collapsed');
      apply(next);
      try {
        localStorage.setItem('crowns.logCollapsed', next ? '1' : '0');
      } catch {
        /* storage may be unavailable in private mode */
      }
      sfx.click();
    });
  }

  // ---------------------------------------------------------------- log & toasts

  #addLog(entry) {
    const line = document.createElement('div');
    line.className = `log-line ${entry.kind ?? 'info'}`;
    const year = document.createElement('span');
    year.className = 't';
    year.textContent = entry.year ?? '';
    const text = document.createElement('span');
    text.className = 'x';
    text.textContent = entry.text;
    line.append(year, text);
    const log = $('#log');
    log.prepend(line);
    while (log.children.length > 7) log.lastChild.remove();
  }

  #toast(text, kind = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast ${kind}`;
    toast.textContent = text;
    $('#toasts').appendChild(toast);
    setTimeout(() => {
      toast.style.transition = 'opacity .3s ease';
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 320);
    }, 1900);
  }

  // ---------------------------------------------------------------- armies

  #armyTotal(nationId) {
    const game = this.game;
    let total = 0;
    for (const province of Object.values(game.state.provinces)) {
      if (province.owner === nationId) total += province.garrison;
    }
    for (const army of game.state.armies) if (army.owner === nationId) total += army.troops;
    return total;
  }

  // ---------------------------------------------------------------- rules

  #rulesTarget() {
    return this.screen === 'game' && this.game ? this.game.state.rules : this.pendingRules;
  }

  #rulesGroups() {
    const onOff = (key, onLabel, offLabel) => [
      { value: true, label: onLabel },
      { value: false, label: offLabel },
    ];
    return [
      {
        key: 'aiStyle',
        title: 'Агрессивность ИИ',
        // The player must know what the switch actually does: it changes both
        // the tempo of AI decisions and the odds those decisions accept.
        hint: 'Спокойный ИИ думает реже и идёт в бой только с явным перевесом. Жёсткий думает чаще и нападает даже при почти равных силах — карта делится быстрее, а соседи наглее.',
        options: Object.entries(AI_STYLE).map(([value, cfg]) => ({ value, label: cfg.label })),
      },
      {
        key: 'peaceUntilFirstWar',
        title: 'Мир до вашей войны',
        hint: 'ИИ не нападёт на вас, пока вы первым не атакуете соседа. Войны между ИИ продолжаются.',
        options: onOff('peaceUntilFirstWar', 'Включён', 'Выключен'),
      },
      {
        key: 'aiPassive',
        title: 'ИИ совсем не воюет',
        hint: 'Песочница: державы только развиваются и обороняются. Никто ни на кого не нападает.',
        options: onOff('aiPassive', 'Да', 'Нет'),
      },
      {
        key: 'aiEconomy',
        title: 'Экономика ИИ',
        hint: 'Скорость накопления золота и рекрутов у компьютерных держав.',
        options: Object.entries(AI_ECONOMY).map(([value, cfg]) => ({ value, label: cfg.label })),
      },
      {
        key: 'neutrals',
        title: 'Нейтральные провинции',
        hint: 'Размер гарнизонов у ничейных земель. Применяется при старте партии.',
        options: Object.entries(NEUTRAL_STRENGTH).map(([value, cfg]) => ({ value, label: cfg.label })),
      },
      {
        key: 'startPaused',
        title: 'Старт на паузе',
        hint: 'Партия начнётся остановленной: сначала осмотритесь, потом включайте время. Только для новой партии.',
        options: onOff('startPaused', 'Да', 'Нет'),
      },
    ];
  }

  #openRules() {
    sfx.click();
    this.#renderRules();
    $('#modal-rules').classList.remove('hidden');
    this.#syncModalScroll('#modal-rules');
  }

  /**
   * Long modals fade their last line while there is more to read. The mask is
   * driven from real geometry so a modal that fits shows no fade at all.
   */
  #syncModalScroll(id) {
    const root = $(id);
    const body = root?.querySelector('.modal-body');
    if (!body) return;
    body.scrollTop = 0;
    const sync = () => {
      const more = body.scrollHeight - body.clientHeight - body.scrollTop > 6;
      body.classList.toggle('has-more', more);
    };
    body.__sync = sync;
    sync();
  }

  #renderRules() {
    const rules = this.#rulesTarget();
    const live = this.screen === 'game' && Boolean(this.game);
    $('#rules-sub').textContent = live
      ? 'Изменения применяются сразу и сохраняются вместе с партией.'
      : 'Эти правила определяют, насколько агрессивно ведёт себя ИИ и как считается победа.';
    $('#rules-list').innerHTML = this.#rulesGroups()
      .map(
        (group) => `
        <div class="rules-row">
          <div class="rules-text">
            <span class="rules-title">${group.title}</span>
            <span class="rules-hint">${group.hint}</span>
          </div>
          <div class="segmented rules-seg" data-key="${group.key}">
            ${group.options
              .map(
                (option) => `
                <button type="button" data-value="${String(option.value)}"
                  class="${ruleOptionMatches(rules, group.key, option.value) ? 'active' : ''}">${option.label}</button>`,
              )
              .join('')}
          </div>
        </div>`,
      )
      .join('');
  }

  #setRule(key, rawValue) {
    let value = rawValue;
    if (rawValue === 'true' || rawValue === 'false') value = rawValue === 'true';
    else if (!Number.isNaN(Number(rawValue)) && rawValue !== '') value = Number(rawValue);

    if (this.screen === 'game' && this.game) {
      this.game.setRules({ [key]: value });
      this.pendingRules = normalizeRules(this.game.state.rules);
      this.save();
      this.#updatePauseSummary();
    } else {
      this.pendingRules = normalizeRules({ ...this.pendingRules, [key]: value });
      this.#renderNationDetail();
    }
    this.settings.rules = this.pendingRules;
    this.#saveSettings();
    this.#markRuleActive(key);
    sfx.click();
  }

  /** Updates selection in place: no re-render, so scroll and focus survive. */
  #markRuleActive(key) {
    const rules = this.#rulesTarget();
    const group = document.querySelector(`.rules-seg[data-key="${key}"]`);
    if (!group) return;
    for (const button of group.querySelectorAll('button[data-value]')) {
      button.classList.toggle('active', ruleOptionMatches(rules, key, button.dataset.value));
    }
  }

  #updatePauseSummary() {
    const summary = $('#pause-rules-summary');
    if (!summary) return;
    const rules = this.game ? this.game.state.rules : this.pendingRules;
    summary.textContent = describeRules(rules);
  }

  /** Pact / peace with one nation, from the province card or the diplomacy list. */
  #askPact(nationId) {
    const result = this.game.proposePact(nationId);
    const name = this.game.state.nations[nationId]?.short ?? 'противник';
    if (!result.ok) this.#toast(result.reason, 'bad');
    else if (result.accepted) {
      this.#toast(result.kind === 'peace' ? `Мир с ${name}` : `Пакт с ${name}`, 'good');
      sfx.select();
      this.#tip('pact', 'Договоры и войны — в «Державах», вкладка «Переговоры»');
    } else this.#toast(`${name}: отказ. Сила и усталость решают — попробуйте позже`, 'bad');
    this.#afterDiplomacy();
  }

  /** Right of passage: the answer is a real treaty with a timer. */
  #askPassage(nationId) {
    const result = this.game.requestPassage(nationId);
    const name = this.game.state.nations[nationId]?.short ?? 'противник';
    if (!result.ok) this.#toast(result.reason, 'bad');
    else if (result.accepted) {
      this.#toast(`${name}: право прохода на ${Math.round(BAL.passageTruce)} с`, 'good');
      sfx.select();
    } else this.#toast(`${name}: проход не дали`, 'bad');
    this.#afterDiplomacy();
  }

  /** «Отдайте землю и мир»: a treaty the player dictates from a won war. */
  #askDemand(nationId) {
    const game = this.game;
    const name = game.state.nations[nationId]?.short ?? 'противник';
    const target = game.demandTarget(nationId);
    const provinceName = target ? game.provinceName(target) : null;
    const result = game.demandPeace(nationId);
    if (!result.ok) {
      this.#toast(result.reason, 'bad');
      return;
    }
    if (result.accepted) {
      const gold = result.gold > 0 ? ` и ${result.gold} золота` : '';
      this.#toast(`${name} уступает провинцию «${provinceName ?? '?'}»${gold} — мир`, 'good');
      sfx.select();
    } else {
      this.#toast(`${name}: отказ — ${Math.round(result.chance * 100)}% было мало, укрепитесь и спросите снова`, 'bad');
    }
    this.#afterDiplomacy();
  }

  #afterDiplomacy() {
    this.#renderProvincePanel();
    this.#updateHud();
    if (!$('#modal-rankings').classList.contains('hidden')) this.#renderRankings();
  }

  #openRankings() {
    if (!this.game) return;
    sfx.click();
    $('#modal-rankings').classList.remove('hidden');
    this.#applyRankTab();
    this.#renderRankings();
  }

  /** «Державы» and «Переговоры» are tabs: both lists do not fit one screen. */
  #applyRankTab() {
    const tab = this.rankTab ?? 'nations';
    for (const button of document.querySelectorAll('#rank-tabs [data-rank-tab]')) {
      button.classList.toggle('active', button.dataset.rankTab === tab);
      button.setAttribute('aria-selected', String(button.dataset.rankTab === tab));
    }
    for (const pane of document.querySelectorAll('#modal-rankings [data-rank-pane]')) {
      pane.classList.toggle('hidden', pane.dataset.rankPane !== tab);
    }
  }

  #renderRankings() {
    if (!this.game) return;
    const game = this.game;
    const playerId = game.state.nationId;
    const rows = Object.values(game.state.nations)
      .map((nation) => ({
        nation,
        army: this.#armyTotal(nation.id),
        provinces: game.provinceCount(nation.id),
        income: nation.income ?? 0,
        recruits: (nation.manpowerRate ?? 0) * 60,
        morale: Math.round(nation.morale ?? 55),
        exhaustion: Math.round(nation.exhaustion ?? 0),
      }))
      .sort((a, b) => b.army - a.army || b.provinces - a.provinces);

    const totalProvinces = Object.keys(game.state.provinces).length;
    $('#rank-table').innerHTML = `
      <div class="rank-row rank-head">
        <span>Держава</span><span>Земли</span><span>Армия</span><span>Дух</span><span>Усталость</span><span>Доход</span><span>Рекруты</span>
      </div>
      ${rows
        .map(
          (row) => `
        <div class="rank-row ${row.nation.id === playerId ? 'is-player' : ''} ${row.nation.alive ? '' : 'is-dead'}">
          <span class="rank-nation">
            <i class="rank-swatch" style="--swatch:${row.nation.color}"></i>
            <span class="rank-name">${row.nation.short}${row.nation.id === playerId ? '<em>вы</em>' : ''}</span>
          </span>
          <span class="rank-cell">
            <b>${row.provinces}</b>
            <span class="rank-bar"><i style="width:${((row.provinces / totalProvinces) * 100).toFixed(0)}%"></i></span>
          </span>
          <span class="rank-cell"><b>${fmt(row.army)}</b></span>
          <span class="rank-cell ${row.morale <= 40 ? 'is-bad' : row.morale >= 65 ? 'is-good' : ''}">${row.nation.alive ? row.morale : '—'}</span>
          <span class="rank-cell ${row.exhaustion >= 55 ? 'is-bad' : ''}">${row.nation.alive ? `${row.exhaustion}%` : '—'}</span>
          <span class="rank-cell">${row.nation.alive ? `+${row.income.toFixed(1)}/с` : '—'}</span>
          <span class="rank-cell">${row.nation.alive ? `+${row.recruits.toFixed(0)}/мин` : '—'}</span>
        </div>`,
        )
        .join('')}
    `;
    this.#renderDiplomacy();
  }

  #renderDiplomacy() {
    const block = $('#diplo-block');
    if (!block || !this.game) return;
    const game = this.game;
    const player = game.player;
    const name = (id) => game.state.nations[id]?.short ?? id;
    const clock = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
    const wars = game
      .warsOf(player.id)
      .map((war) => `<span class="diplo-tag war">${name(war.id)} · ${clock(war.left)}</span>`);
    const truces = game
      .trucesOf(player.id)
      .sort((a, b) => a.left - b.left)
      .map(
        (truce) => `<span class="diplo-tag is-pact">${name(truce.id)} · ${Math.ceil(truce.left)} с</span>`,
      );
    const passages = game
      .passagesOf(player.id)
      .map((pass) => `<span class="diplo-tag pass">${name(pass.id)} · ${Math.ceil(pass.left)} с</span>`);
    const morale = Math.round(player.morale ?? 55);
    const exhaustion = Math.round(player.exhaustion ?? 0);
    const incomePenalty = Math.round(exhaustion * BAL.exhaustionIncome);
    const oath = player.oathbreaks ?? 0;
    const trust = Math.max(0, 100 - oath * 17);
    // A compact strip instead of five label rows: on a landscape phone the rows
    // ate the whole visible part of the dialog and the negotiation list — the
    // reason the player opened the screen — fell below the fold.
    block.innerHTML = `
      <div class="diplo-brief">
        <span class="db-spirit"><em>Дух</em> <b class="${morale <= 40 ? 'is-bad' : morale >= 65 ? 'is-good' : ''}">${morale}</b> <i>${morale >= 50 ? '+' : ''}${((game.moraleModifier(player.id) - 1) * 100).toFixed(0)}% к бою</i></span>
        <span class="db-wear"><em>Усталость</em> <b class="${exhaustion >= 55 ? 'is-bad' : ''}">${exhaustion}%</b> <i>${incomePenalty > 0 ? `доход −${incomePenalty}%` : 'без штрафа'}</i></span>
        <span class="db-trust"><em>Доверие</em> <b class="${oath ? 'is-bad' : 'is-good'}">${trust}%</b> <i>${oath ? `нарушено договоров: ${oath}` : 'слово держите'}</i></span>
      </div>
      <div class="diplo-line">
        <em>Войны</em>
        <span class="diplo-tags">${wars.length ? wars.join('') : '<span class="diplo-empty">нет — мирное время</span>'}</span>
      </div>
      <div class="diplo-line">
        <em>Договоры</em>
        <span class="diplo-tags">${[...truces, ...passages].join('') || '<span class="diplo-empty">нет</span>'}</span>
      </div>`;
    const nations = $('#diplo-nations');
    if (nations) nations.innerHTML = this.#diploNations();
  }

  /**
   * The negotiation screen: every living nation, its current relation with the
   * player, and the two things one can ask for. This replaced a lonely «Пакт»
   * button inside a province card — the player had no way to see who is at war
   * with whom, how long a treaty lasts, or why nobody signs.
   */
  #diploNations() {
    const game = this.game;
    const me = game.state.nationId;
    const rows = Object.values(game.state.nations)
      .filter((nation) => nation.id !== me && nation.alive)
      .sort((a, b) => game.provinceCount(b.id) - game.provinceCount(a.id))
      .map((nation) => {
        const war = game.warSince(nation.id, me);
        const truce = game.truceLeft(nation.id);
        const passage = game.passageLeft(nation.id, me);
        const pactWait = Math.ceil((nation.pactAskedUntil ?? 0) - game.state.time);
        const passWait = Math.ceil((nation.passageAskedUntil ?? 0) - game.state.time);
        const chips = [];
        if (war != null) {
          const left = Math.max(0, game.state.time - war);
          chips.push(`<span class="dn-chip is-war">война ${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, '0')}</span>`);
        }
        if (truce > 0) chips.push(`<span class="dn-chip is-pact">${truce >= 200 ? 'пакт' : 'мир'} ${Math.ceil(truce)} с</span>`);
        if (passage > 0) chips.push(`<span class="dn-chip is-pass">проход ${Math.ceil(passage)} с</span>`);
        if (!chips.length) chips.push('<span class="dn-chip is-none">нейтралитет</span>');
        const pactLabel = war != null ? 'Мир' : 'Пакт';
        const passBlocked = passage > 0 || war != null || passWait > 0;
        const power = Math.round(game.armyTotal(nation.id));
        return `
          <div class="dn-row">
            <span class="dn-nation">
              <i class="rank-swatch" style="--swatch:${nation.color}"></i>
              <b>${nation.short}</b>
              <em>${power} чел.</em>
            </span>
            <span class="dn-state">${chips.join('')}</span>
            <span class="dn-actions">
              <button class="dn-btn" data-rank-pact="${nation.id}" ${truce > 0 || pactWait > 0 ? 'disabled' : ''}>
                ${truce > 0 ? 'Пакт' : pactLabel}
              </button>
              <button class="dn-btn" data-rank-passage="${nation.id}" ${passBlocked ? 'disabled' : ''}>Проход</button>
              ${
                war != null
                  ? `<button class="dn-btn is-demand" data-rank-demand="${nation.id}" ${game.demandOutlook(nation.id) > 0 ? '' : 'disabled'} title="Мир за одну пограничную провинцию">
                      <span class="dn-long">Мир за землю</span><span class="dn-short">Земля</span>${
                        game.demandOutlook(nation.id) > 0 ? ` <em>${Math.round(game.demandOutlook(nation.id) * 100)}%</em>` : ''
                      }
                    </button>`
                  : ''
              }
            </span>
          </div>`;
      });
    if (!rows.length) return '';
    return `
      <div class="dn-block">
        <div class="dn-head"><span>Переговоры</span><em>пакт — не воевать · проход — ходить через землю</em></div>
        ${rows.join('')}
      </div>`;
  }

  #syncArmies() {
    if (!this.game) return;
    this.arrowLayer.setArmies(
      this.game.state.armies.map((army) => ({
        ...army,
        isPlayer: army.owner === this.game.state.nationId,
      })),
      this.game.state.nations,
    );
    // Several armies can leave the same province: fan them out near the origin.
    const fanIndex = new Map();
    for (const army of this.game.state.armies) {
      const list = fanIndex.get(army.from) ?? [];
      list.push(army.id);
      fanIndex.set(army.from, list);
    }

    const seen = new Set();
    for (const army of this.game.state.armies) {
      seen.add(army.id);
      let token = this.armyTokens.get(army.id);
      if (!token) {
        token = document.createElement('div');
        token.className = `army-token${army.sea ? ' sea' : ''}`;
        token.style.setProperty('--token-color', this.game.state.nations[army.owner]?.color ?? '#d9b45a');
        $('#armies').appendChild(token);
        this.armyTokens.set(army.id, token);
      }
      const from = this.mapById[army.from]?.centroid ?? [0, 0];
      const to = this.mapById[army.to]?.centroid ?? [0, 0];
      const t = clamp(army.t / army.duration, 0, 1);
      const x = from[0] + (to[0] - from[0]) * t;
      const z = from[1] + (to[1] - from[1]) * t;
      const pos = this.world.projectPoint(x, z, 0.35);
      const lift = 16;

      // Perpendicular fan offset, fading out as the army leaves its home province.
      const ids = fanIndex.get(army.from) ?? [];
      const index = ids.indexOf(army.id);
      const spread = ids.length > 1 ? (index - (ids.length - 1) / 2) * 16 : 0;
      const angle = Math.atan2(to[1] - from[1], to[0] - from[0]);
      const offX = Math.cos(angle + Math.PI / 2) * spread * (1 - t);
      const offY = Math.sin(angle + Math.PI / 2) * spread * (1 - t) * 0.6;

      token.style.display = pos.visible ? 'flex' : 'none';
      token.style.transform = `translate(-50%, -50%) translate(${pos.x + offX}px, ${pos.y - lift + offY}px)`;
      token.textContent = fmt(army.troops);
    }
    for (const [id, token] of this.armyTokens) {
      if (!seen.has(id)) {
        token.remove();
        this.armyTokens.delete(id);
      }
    }
  }

  #clearArmies() {
    for (const token of this.armyTokens.values()) token.remove();
    this.armyTokens.clear();
    this.arrowLayer.setArmies([], {});
  }

  // ---------------------------------------------------------------- colors

  #syncColors(force = false) {
    if (!this.game) return;
    const provinces = this.game.state.provinces;
    const signature = Object.keys(provinces)
      .sort()
      .map((id) => provinces[id].owner ?? '-')
      .join('');
    if (!force && signature === this.colorSignature) return;
    this.colorSignature = signature;
    const colors = {};
    for (const province of Object.values(provinces)) colors[province.id] = this.#provinceColor(province);
    this.world.setOwnership(colors);
  }

  // ---------------------------------------------------------------- UI bindings

  #bindUi() {
    // The AI settings were only reachable after picking a nation, which made
    // «Агрессивность ИИ» look like it kept disappearing. The menu has its own
    // way in now, and the rules modal works without a selected nation.
    $('#btn-menu-rules').addEventListener('click', () => this.#openRules());
    $('#btn-howto').addEventListener('click', () => {
      sfx.click();
      $('#modal-howto').classList.remove('hidden');
      this.#syncModalScroll('#modal-howto');
    });
    for (const body of document.querySelectorAll('.modal-body')) {
      body.addEventListener('scroll', () => body.__sync?.(), { passive: true });
      body.addEventListener('scroll', () => {
        const atEnd = body.scrollTop + body.clientHeight >= body.scrollHeight - 2;
        body.classList.toggle('no-more', atEnd);
      }, { passive: true });
      new ResizeObserver(() => {
        body.__sync?.();
        body.classList.toggle('no-more', body.scrollHeight <= body.clientHeight + 2);
      }).observe(body);
    }
    for (const button of document.querySelectorAll('[data-close]')) {
      button.addEventListener('click', () => {
        sfx.click();
        const id = button.dataset.close;
        $(`#${id}`).classList.add('hidden');
        if (id === 'modal-rules' && this.rulesReturnToPause) {
          this.rulesReturnToPause = false;
          $('#modal-pause').classList.remove('hidden');
          this.#updatePauseSummary();
        }
      });
    }
    $('#btn-back').addEventListener('click', () => {
      sfx.click();
      this.showMenu();
    });
    $('#nation-detail').addEventListener('click', (event) => {
      if (event.target.closest('[data-open-rules]')) {
        this.#openRules();
        return;
      }
      const button = event.target.closest('#btn-start');
      if (!button || button.disabled) return;
      sfx.select();
      this.startGame();
    });

    $('#rules-list').addEventListener('click', (event) => {
      const button = event.target.closest('button[data-value]');
      if (!button) return;
      const group = button.closest('.rules-seg');
      if (!group) return;
      this.#setRule(group.dataset.key, button.dataset.value);
    });

    $('#btn-rules-reset').addEventListener('click', () => {
      if (this.screen === 'game' && this.game) {
        this.game.setRules(DEFAULT_RULES);
        this.pendingRules = normalizeRules(DEFAULT_RULES);
        this.save();
        this.#updateHud();
        this.#updatePauseSummary();
      } else {
        this.pendingRules = normalizeRules(DEFAULT_RULES);
        this.#renderNationDetail();
      }
      this.settings.rules = this.pendingRules;
      this.#saveSettings();
      for (const group of this.#rulesGroups()) this.#markRuleActive(group.key);
      sfx.click();
    });

    $('#btn-pause-rankings').addEventListener('click', () => this.#openRankings());
    $('#btn-pause-rules').addEventListener('click', () => {
      this.rulesReturnToPause = true;
      $('#modal-pause').classList.add('hidden');
      this.#openRules();
    });
    for (const button of document.querySelectorAll('#mode-switch .mode-btn')) {
      button.addEventListener('click', () => {
        sfx.select();
        this.setMapMode(button.dataset.mode);
      });
    }
    $('#btn-continue').addEventListener('click', async () => {
      sfx.select();
      let saved = await this.#resumeFromStorage();
      // Saves made before the Atlantic map existed (or from a removed
      // scenario) cannot be restored: drop them instead of failing mid-load.
      if (saved && !hasScenario(saved?.game?.state?.scenarioId)) {
        saved = null;
        try {
          localStorage.removeItem(SAVE_KEY);
        } catch {
          /* ignore */
        }
      }
      // Old saves have no theatre field: fall back to the scenario it belongs to.
      const theatre = saved?.theatre ?? getScenario(saved?.game?.state?.scenarioId)?.theatre ?? 'europe';
      this.setTheatre(theatre);
      const game = saved ? Game.deserialize(saved.game, this.map) : null;
      if (!game) {
        this.#toast('Сохранение не найдено', 'bad');
        this.hasSave = false;
        $('#btn-continue').classList.add('hidden');
        return;
      }
      this.#attachGame(game);
      this.#enterGameScreen();
    });

    for (const button of $('#speed-group').children) {
      button.addEventListener('click', () => {
        const speed = Number(button.dataset.speed);
        this.setSpeed(speed);
      });
    }
    $('#offer-card').addEventListener('click', (event) => {
      const button = event.target.closest('[data-answer]');
      if (!button || !this.game) return;
      const row = button.closest('[data-offer]');
      if (!row) return;
      const offerId = Number(row.dataset.offer);
      const result = this.game.answerPeace(offerId, button.dataset.answer === '1');
      if (!result.ok) this.#toast(result.reason ?? 'Не получилось', 'bad');
      this.#renderOffers();
    });
    this.#wireLogDock();
    $('#btn-pause-menu').addEventListener('click', () => this.openPause());
    $('#btn-rankings').addEventListener('click', () => this.#openRankings());
    $('#rank-tabs').addEventListener('click', (event) => {
      const button = event.target.closest('[data-rank-tab]');
      if (!button) return;
      this.rankTab = button.dataset.rankTab;
      this.#applyRankTab();
      sfx.click();
    });
    // Delegated: the negotiation list is rebuilt on every tick of the modal.
    $('#diplo-nations').addEventListener('click', (event) => {
      if (!this.game) return;
      const pact = event.target.closest('[data-rank-pact]');
      if (pact) {
        if (!pact.disabled) this.#askPact(pact.dataset.rankPact);
        return;
      }
      const passage = event.target.closest('[data-rank-passage]');
      if (passage) {
        if (!passage.disabled) this.#askPassage(passage.dataset.rankPassage);
        return;
      }
      const demand = event.target.closest('[data-rank-demand]');
      if (demand) {
        if (!demand.disabled) this.#askDemand(demand.dataset.rankDemand);
      }
    });

    for (const button of $('#ratio-group').children) {
      button.addEventListener('click', () => {
        const ratio = Number(button.dataset.ratio);
        this.preferredRatio = ratio;
        if (this.game) this.game.setSendRatio(ratio);
        this.#syncRatioButtons();
        if (this.selectedProvince) this.#renderProvincePanel();
        if (this.hoveredProvince) this.#hover(this.hoveredProvince);
        sfx.click();
      });
    }

    $('#btn-focus').addEventListener('click', () => {
      const card = $('#focus-card');
      if (card.classList.contains('hidden')) {
        this.#renderFocusCard();
        card.classList.remove('hidden');
        // The HUD may wrap to two rows on a narrow screen: the card starts
        // below it instead of guessing a fixed offset.
        const hud = $('.hud-top')?.getBoundingClientRect();
        if (hud) card.style.top = `${Math.round(hud.bottom + 10)}px`;
        sfx.click();
      } else {
        card.classList.add('hidden');
      }
    });

    $('#focus-card').addEventListener('click', (event) => {
      if (event.target.closest('[data-fc-close]')) $('#focus-card').classList.add('hidden');
    });

    $('#route-card').addEventListener('click', (event) => {
      if (event.target.closest('[data-rc-cancel]')) {
        this.#closeRoutePlanner();
        return;
      }
      const step = event.target.closest('[data-step]');
      if (step && this.routePlanner) {
        const id = step.dataset.step;
        const delta = Number(step.dataset.delta);
        const plan = this.routePlanner;
        const totalLeft = Object.values(plan.leave).reduce((a, b) => a + b, 0);
        const sendable = this.game.sendableTroops(plan.from);
        const next = Math.max(0, Math.min(plan.leave[id] + delta, sendable - (totalLeft - plan.leave[id])));
        plan.leave[id] = Math.round(next);
        this.routeRender?.();
        return;
      }
      if (event.target.closest('[data-rc-send]') && this.routePlanner) {
        const plan = this.routePlanner;
        const result = this.game.sendTroops(plan.from, plan.to, this.game.state.sendRatio, { leave: plan.leave });
        this.#closeRoutePlanner();
        if (!result.ok) {
          this.#toast(result.reason, 'bad');
          return;
        }
        sfx.march();
        const kept = Object.values(plan.leave).reduce((a, b) => a + b, 0);
        const via = (result.through ?? []).map((id) => this.game.state.nations[id]?.short ?? id).join(', ');
        this.#toast(
          `${fmt(result.amount - kept)} в походе через ${plan.route.length - 2} пров.${via ? ` (${via})` : ''}${kept ? `, ${fmt(kept)} остаётся` : ''}`,
          'good',
        );
        this.world.setValidTargets([]);
        this.world.setSelected(plan.from);
        this.#updateHud();
      }
    });

    $('#province-panel').addEventListener('click', (event) => {
      if (event.target.closest('[data-fold]')) {
        this.panelFolded = !this.panelFolded;
        this.#applyPanelFold();
        this.#armPanelFold();
        sfx.click();
        return;
      }
      if (this.panelFolded) {
        // A folded header works as a tab: tap it to open the card again.
        this.#unfoldPanel();
        return;
      }
      this.#armPanelFold();
      const close = event.target.closest('[data-close]');
      if (close) {
        this.selectedProvince = null;
        this.world.setSelected(null);
        $('#province-panel').classList.add('hidden');
        return;
      }
      const autoAdd = event.target.closest('[data-auto-add]');
      if (autoAdd && this.game) {
        const id = autoAdd.dataset.autoAdd;
        this.autoFrom = this.autoFrom === id ? null : id;
        if (this.autoFrom) {
          this.#hint(`Выберите провинцию, куда отправлять войска из «${this.game.provinceName(id)}»`);
          this.#armPanelFold();
        }
        this.#renderProvincePanel();
        sfx.click();
        return;
      }
      const autoDel = event.target.closest('[data-auto-del]');
      if (autoDel && this.game) {
        this.game.removeAuto(Number(autoDel.dataset.autoDel));
        this.#renderProvincePanel();
        sfx.click();
        return;
      }
      const autoStep = event.target.closest('[data-auto-step]');
      if (autoStep && this.game) {
        const order = this.game.autoOrders().find((o) => o.id === Number(autoStep.dataset.autoStep));
        if (order) {
          const delta = Number(autoStep.dataset.delta);
          const next = { ...order };
          if (autoStep.dataset.field === 'when') next.when = Math.max(order.keep + 10, order.when + delta);
          else next.keep = Math.max(10, Math.min(order.when - 10, order.keep + delta));
          this.game.addAuto(order.from, order.to, next.when, next.keep);
          this.#renderProvincePanel();
          this.#armPanelFold();
        }
        return;
      }
      const pactButton = event.target.closest('[data-pact]');
      if (pactButton && this.game) {
        if (pactButton.disabled) return;
        this.#askPact(pactButton.dataset.pact);
        return;
      }
      const recallButton = event.target.closest('[data-recall]');
      if (recallButton && this.game) {
        const result = this.game.recallArmy(Number(recallButton.dataset.recall));
        if (!result.ok) this.#toast(result.reason, 'bad');
        else {
          this.#toast(`Колонна возвращается: ${fmt(result.troops)} чел.`, 'info');
          sfx.click();
        }
        this.#renderProvincePanel();
        this.#updateHud();
        return;
      }
      const passageButton = event.target.closest('[data-passage]');
      if (passageButton && this.game) {
        if (passageButton.disabled) return;
        this.#askPassage(passageButton.dataset.passage);
        return;
      }
      const breakButton = event.target.closest('[data-break]');
      if (breakButton && this.game) {
        const id = breakButton.dataset.break;
        const now = performance.now();
        // Two taps, one small button: nobody should tear up a treaty by accident.
        if (this.pendingBreak?.owner === id && now - this.pendingBreak.at < 12000) {
          this.pendingBreak = null;
          this.game.breakTruce(id);
          this.#toast('Пакт разорван — вам больше не верят', 'bad');
          this.#updateHud();
        } else {
          this.pendingBreak = { owner: id, at: now };
          breakButton.textContent = 'Точно нарушить?';
          breakButton.classList.add('is-armed');
          setTimeout(() => {
            const again = document.querySelector(`#province-panel [data-break="${id}"]`);
            if (again && again.classList.contains('is-armed') && this.pendingBreak?.owner === id) {
              again.textContent = 'Нарушить пакт';
              again.classList.remove('is-armed');
              this.pendingBreak = null;
            }
          }, 12000);
        }
        return;
      }
      const upgrade = event.target.closest('.upg');
      if (!upgrade || !this.game) return;
      const result = this.game.upgrade(this.selectedProvince, upgrade.dataset.kind);
      if (!result.ok) this.#toast(result.reason, 'bad');
      else {
        sfx.coin();
        this.world.flashProvince(this.selectedProvince, 0.45);
        this.#renderProvincePanel();
        this.#updateHud();
        this.#tip(
          'upgrade',
          'Мануфактура — доход, казармы — рекруты, крепость — оборона. Уровень виден в карточке',
        );
      }
    });

    $('#btn-resume').addEventListener('click', () => this.closePause());
    $('#btn-restart').addEventListener('click', () => {
      $('#modal-pause').classList.add('hidden');
      this.#restart();
    });
    $('#btn-menu').addEventListener('click', () => {
      this.save();
      $('#modal-pause').classList.add('hidden');
      this.showMenu();
    });
    $('#toggle-sound').addEventListener('change', (event) => {
      this.settings.sound = event.target.checked;
      sfx.setEnabled(this.settings.sound);
      this.#saveSettings();
    });
    $('#toggle-labels').addEventListener('change', (event) => {
      this.settings.labels = event.target.checked;
      this.labels.setVisible(this.settings.labels && this.screen === 'game');
      this.#saveSettings();
    });
    $('#toggle-tips').addEventListener('change', (event) => {
      this.settings.tips = event.target.checked;
      this.#saveSettings();
    });
    $('#toggle-sound').checked = this.settings.sound;
    $('#toggle-labels').checked = this.settings.labels;
    $('#toggle-tips').checked = this.settings.tips !== false;
    sfx.setEnabled(this.settings.sound);

    $('#btn-again').addEventListener('click', () => {
      $('#screen-end').classList.add('hidden');
      this.#restart();
    });
    $('#btn-end-menu').addEventListener('click', () => {
      $('#screen-end').classList.add('hidden');
      this.showMenu();
    });

    // A live UI must not rebuild itself between pointerdown and pointerup.
    document.addEventListener('pointerdown', () => { this.pressing = true; }, true);
    const release = () => {
      if (!this.pressing) return;
      this.pressing = false;
      // Refresh after the click event has been dispatched: rebuilding the panel
      // in pointerup would replace the button before its click handler runs.
      setTimeout(() => {
        if (this.screen !== 'game' || !this.game || this.pressing) return;
        this.#updateHud();
        if (this.selectedProvince) this.#renderProvincePanel();
      }, 0);
    };
    document.addEventListener('pointerup', release, true);
    document.addEventListener('pointercancel', release, true);
    window.addEventListener('blur', release);

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.save();
    });
    window.addEventListener('beforeunload', () => this.save());
    window.addEventListener('resize', () => {
      this.arrowLayer.resize();
      this.#syncSafeArea();
    });
  }

  #bindKeyboard() {
    window.addEventListener('keydown', (event) => {
      if (this.screen !== 'game' || !this.game) return;
      // Never hijack typing (rules inputs, future chat fields).
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      if (event.code === 'Space') {
        event.preventDefault();
        this.setSpeed(this.game.state.speed === 0 ? this.lastSpeed : 0);
      } else if (event.key === '1') this.setSpeed(1);
      else if (event.key === '2') this.setSpeed(2);
      else if (event.key === '4') this.setSpeed(4);
      else if (event.key === 'Escape') this.openPause();
      else if (event.key === '+' || event.key === '=') this.world.zoomBy(1.12);
      else if (event.key === '-' || event.key === '_') this.world.zoomBy(0.89);
      else if (event.key === 'ArrowLeft' || event.key === 'a') this.world.panBy(-2, 0);
      else if (event.key === 'ArrowRight' || event.key === 'd') this.world.panBy(2, 0);
      else if (event.key === 'ArrowUp' || event.key === 'w') this.world.panBy(0, -2);
      else if (event.key === 'ArrowDown' || event.key === 's') this.world.panBy(0, 2);
      else if (event.key === 'm' || event.key === 'ь' || event.key === 'M') this.#castOrder('mobilize');
      else if (event.key === 't' || event.key === 'е' || event.key === 'T') this.#castOrder('tax');
      else if (event.key === 'f' || event.key === 'а' || event.key === 'F') this.#castOrder('march');
      else if (event.key === 'r' || event.key === 'к' || event.key === 'R') this.#openRankings();
      else if (event.key === 'Tab') {
        event.preventDefault();
        this.#cycleRatio();
      }
    });
  }

  #cycleRatio() {
    const steps = [0.25, 0.5, 0.75, 1];
    const current = this.game.state.sendRatio;
    const index = steps.findIndex((v) => Math.abs(v - current) < 0.01);
    const next = steps[(index + 1) % steps.length];
    this.game.setSendRatio(next);
    this.preferredRatio = next;
    this.#syncRatioButtons();
    this.#toast(`В поход уйдёт ${Math.round(next * 100)}% гарнизона`, 'info');
  }

  /** Keeps the highlighted button equal to the ratio the game will actually use. */
  #syncRatioButtons() {
    const ratio = this.game?.state?.sendRatio ?? this.preferredRatio;
    for (const button of $('#ratio-group').children) {
      button.classList.toggle('active', Math.abs(Number(button.dataset.ratio) - ratio) < 0.01);
    }
  }

  setSpeed(speed) {
    if (!this.game) return;
    if (speed > 0) this.lastSpeed = speed;
    this.game.setSpeed(speed);
    this.#updateHud();
  }

  openPause() {
    if (!this.game || this.screen !== 'game') return;
    if (this.game.state.speed > 0) this.lastSpeed = this.game.state.speed;
    this.game.setSpeed(0);
    this.save();
    $('#modal-pause').classList.remove('hidden');
    this.#updatePauseSummary();
    platform.gameplayStop();
    this.#updateHud();
  }

  closePause() {
    $('#modal-pause').classList.add('hidden');
    if (this.game) {
      this.setSpeed(this.lastSpeed || 1);
      platform.gameplayStart();
    }
  }

  // ---------------------------------------------------------------- frame loop

  loop(now) {
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;

    this.world.update(dt);
    this.arrowLayer.setPreview(this.world.previewArrowData);
    this.arrowLayer.draw(dt);
    if (this.game && this.screen === 'game') {
      if (this.game.state.status === 'playing') {
        this.game.update(dt * (this.game.state.speed ?? 0));
      }
      this.#syncColors();
      this.labels.update(this.world, this.game, this.selectedProvince, this.world.hovered);
      this.#syncArmies();

      this.hudTimer -= dt;
      if (this.hudTimer <= 0) {
        this.hudTimer = 0.2;
        this.#updateHud();
      }
      this.saveTimer -= dt;
      if (this.saveTimer <= 0) {
        this.saveTimer = 12;
        this.save();
      }
      this.nowTimer = (this.nowTimer ?? 0) - dt;
      if (this.nowTimer <= 0) {
        this.nowTimer = 0.5;
        this.#syncNow();
      }
    }
    this.world.render();
    requestAnimationFrame(this.loop);
  }
}
