import { World } from '../render/world.js';
import { LabelLayer } from '../render/labels.js';
import { ArrowLayer } from '../render/arrows.js';
import { Game } from '../game/game.js';
import { SCENARIOS, DOCTRINES, getScenario } from '../data/scenarios.js';
import { BAL, UPGRADES, ORDERS } from '../game/balance.js';
import {
  DEFAULT_RULES,
  AI_STYLE,
  AI_ECONOMY,
  NEUTRAL_STRENGTH,
  VICTORY_SHARES,
  normalizeRules,
  describeRules,
} from '../game/rules.js';
import { platform } from '../platform/yandex.js';
import { sfx } from '../audio.js';
import { icon } from './icons.js';

const SAVE_KEY = 'crowns.save.v1';
const SETTINGS_KEY = 'crowns.settings.v1';
const DIFFICULTY_LEVEL = { 'Низко': 1, 'Средне': 2, 'Высоко': 3 };

const $ = (sel, root = document) => root.querySelector(sel);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const fmt = (n) => Math.round(n).toLocaleString('ru-RU');

export class App {
  constructor(map) {
    this.map = map;
    this.mapById = Object.fromEntries(map.provinces.map((p) => [p.id, p]));
    this.settings = this.#loadSettings();
    this.pendingRules = normalizeRules(this.settings.rules ?? {});

    this.world = new World($('#view'), map, {
      canDrag: (id) => this.#canStartDrag(id),
      onDragStart: (id) => this.#dragStart(id),
      onDrop: (from, to) => this.#dragDrop(from, to),
      onDragCancel: () => this.#dragCancel(),
      onClick: (id) => this.#click(id),
      onHover: (id) => this.#hover(id),
      onArrowPreview: (preview) => this.arrowLayer.setPreview(preview),
    });
    this.arrowLayer = new ArrowLayer($('#arrows'), this.world);
    this.labels = new LabelLayer($('#labels'), map);
    this.labels.setVisible(false);

    this.screen = 'menu';
    this.game = null;
    this.scenario = null;
    this.selectedNation = null;
    this.doctrine = 'coin';
    this.selectedProvince = null;
    this.lastSpeed = 1;
    this.hudTimer = 0;
    this.saveTimer = 10;
    this.colorSignature = '';
    this.armyTokens = new Map();
    this.lastBattleSound = 0;
    this.hasSave = this.#readSave() !== null;

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
      return { sound: raw.sound !== false, labels: raw.labels !== false, rules: raw.rules ?? null };
    } catch {
      return { sound: true, labels: true, rules: null };
    }
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
    const payload = { savedAt: Date.now(), game: this.game.serialize() };
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

  // ---------------------------------------------------------------- menu

  #buildMenu() {
    const list = $('#scenario-list');
    list.innerHTML = '';
    for (const scenario of SCENARIOS) {
      const level = DIFFICULTY_LEVEL[scenario.difficulty] ?? 2;
      const dots = Array.from({ length: 3 }, (_, i) => `<i class="${i < level ? 'on' : ''}"></i>`).join('');
      const card = document.createElement('button');
      card.className = 'scenario-card';
      card.type = 'button';
      card.innerHTML = `
        <div class="scenario-era">${scenario.era}</div>
        <div class="scenario-title">${scenario.title}</div>
        <div class="scenario-desc">${scenario.blurb}</div>
        <div class="scenario-meta">
          <span>${scenario.nations.length} держав</span>
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

  showMenu() {
    this.game = null;
    this.selectedProvince = null;
    this.#setScreen('menu');
    this.#clearArmies();
    this.labels.setVisible(false);
    this.world.setSelected(null);
    this.world.setAccent([]);
    this.world.setValidTargets([]);
    this.world.resetView();
    this.world.setAutoPan(true);
    const preview = getScenario('eve1939');
    this.world.setOwnership(this.#previewColors(preview));
    $('#province-panel').classList.add('hidden');
    platform.gameplayStop();
  }

  openNationSelect(scenarioId) {
    this.scenario = getScenario(scenarioId);
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
    this.world.zoomTarget = 1;
    this.world.setOwnership(this.#previewColors(this.scenario));
    this.#renderNations();
  }

  #previewColors(scenario) {
    const colors = {};
    for (const province of this.map.provinces) colors[province.id] = '#59626e';
    for (const nation of scenario.nations) {
      for (const provinceId of nation.provinces) colors[provinceId] = nation.color;
    }
    return colors;
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
          <span class="tile-sub">${nation.provinces.length} пров. · ${preview.pop.toFixed(1)} млн</span>
          <span class="tile-army">Армия ${fmt(preview.army)}</span>
        </span>`;
      item.addEventListener('click', () => this.#selectNation(nation.id, true));
      list.appendChild(item);
    }
    $('#nation-count').textContent = `${this.scenario.nations.length} держав · ${this.scenario.era}`;
    this.#renderNationDetail();
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
    const doctrine = DOCTRINES.find((d) => d.id === this.doctrine) ?? DOCTRINES[0];
    detail.innerHTML = `
      <div class="detail-head">
        <span class="detail-crest" style="--swatch:${nation.color}">${icon('flag', 22)}</span>
        <div>
          <div class="eyebrow">${this.scenario.era} · ${nation.provinces.length} провинций</div>
          <h3>${nation.name}</h3>
        </div>
      </div>
      <div class="detail-stats">
        <div class="ds"><span class="k">Население</span><span class="v">${preview.pop.toFixed(1)} млн</span></div>
        <div class="ds"><span class="k">Доход</span><span class="v gold">+${preview.income.toFixed(1)}/с</span></div>
        <div class="ds"><span class="k">Армия на старте</span><span class="v">${fmt(preview.army)}</span></div>
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
    if (focus) this.world.focusOn(nation.capital);
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
    this.selectedNation = game.state.nationId;
    this.selectedProvince = null;
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
        } else if (payload.from === game.state.nationId) {
          sfx.loss();
          this.#toast(`Потеряна ${game.provinceName(payload.provinceId)}`, 'bad');
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

  #enterGameScreen() {
    this.#setScreen('game');
    this.world.setSelected(null);
    this.world.setAccent([]);
    this.world.setValidTargets([]);
    this.world.resetView();
    this.world.setAutoPan(false);
    this.world.zoomTarget = 1;
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

  #endGame({ result }) {
    const game = this.game;
    game.state.speed = 0;
    this.#clearArmies();
    localStorage.removeItem(SAVE_KEY);
    this.hasSave = false;
    $('#btn-continue').classList.add('hidden');
    platform.gameplayStop();

    const victory = result === 'victory';
    $('#end-emblem').textContent = victory ? '♛' : '☠';
    $('#end-eyebrow').textContent = victory ? 'Европа ваша' : 'Держава пала';
    $('#end-title').textContent = victory ? 'Победа' : 'Поражение';
    $('#end-text').textContent = victory
      ? 'Половина континента признала вашу корону. Историки будут спорить о методах, но не о результате.'
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
    const targets = this.game.neighbors(provinceId).filter((id) => id !== provinceId);
    this.world.setValidTargets(targets);
    this.world.setSelected(provinceId);
    sfx.click();
  }

  #dragCancel() {
    this.world.setValidTargets([]);
    this.world.setSelected(this.selectedProvince);
  }

  #dragDrop(from, to) {
    if (!this.game) return;
    const result = this.game.sendTroops(from, to);
    if (!result.ok) {
      this.#toast(result.reason, 'bad');
      return;
    }
    sfx.march();
    this.#toast(`${fmt(result.amount)} в походе${result.sea ? ' морем' : ''}`, 'good');
    this.world.setValidTargets([]);
    this.selectedProvince = from;
    this.world.setSelected(from);
    this.#renderProvincePanel();
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
    if (!provinceId) {
      this.selectedProvince = null;
      this.world.setSelected(null);
      $('#province-panel').classList.add('hidden');
      return;
    }
    this.selectedProvince = provinceId;
    this.world.setSelected(provinceId);
    this.#renderProvincePanel();
    sfx.click();
  }

  #hover(provinceId) {
    if (this.world.dragFrom) {
      this.#tooltip(null);
      return;
    }
    if (this.screen === 'game' && this.game) {
      const province = this.game.state.provinces[provinceId];
      if (province) {
        const owner = province.owner ? this.game.state.nations[province.owner] : null;
        const defense = this.game.defenseValue(province.id);
        this.#tooltip(provinceId, {
          title: this.game.provinceName(provinceId),
          owner: owner ? owner.name : 'Нейтральная территория',
          lines: [
            `Гарнизон ${Math.round(province.garrison)}`,
            `Оборона ${Math.round(defense)}`,
            owner && owner.id !== this.game.state.nationId ? 'Можно атаковать' : 'Ваши земли',
          ],
        });
      } else {
        this.#tooltip(null);
      }
    }
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
    el.innerHTML = `
      <span class="tt-title">${content.title}</span>
      <span class="tt-owner">${content.owner}</span>
      <span class="tt-lines">${content.lines.map((line) => `<b>${line}</b>`).join('')}</span>`;
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
    $('#hud-progress-text').textContent = `${progress.owned}/${progress.total}`;
    $('#hud-progress-fill').style.width = `${(progress.share * 100).toFixed(1)}%`;

    for (const button of $('#speed-group').children) {
      const speed = Number(button.dataset.speed);
      button.classList.toggle('active', speed === game.state.speed);
    }
    this.#updateOrders();
    if (this.selectedProvince) this.#renderProvincePanel();
    if (!$('#modal-rankings').classList.contains('hidden')) this.#renderRankings();
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

  #renderProvincePanel() {
    const panel = $('#province-panel');
    if (!this.game || !this.selectedProvince) {
      panel.classList.add('hidden');
      return;
    }
    const game = this.game;
    const province = game.state.provinces[this.selectedProvince];
    if (!province) {
      panel.classList.add('hidden');
      return;
    }
    panel.classList.remove('hidden');
    const owner = province.owner ? game.state.nations[province.owner] : null;
    const isMine = province.owner === game.state.nationId;
    const max = game.maxGarrison(province.id);
    const defense = game.defenseValue(province.id);
    const share = clamp(province.garrison / Math.max(1, max), 0, 1);
    const over = Math.max(0, Math.round(province.garrison - max));
    const marching = game.troopsInTransit(province.id);
    const marchingCount = game.armiesFrom(province.id).length;
    const regen = max * BAL.reinforceShare * (1 + province.barracks * BAL.barracksReinforce);
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
        <span class="pp-swatch" style="--swatch:${owner?.color ?? '#7c8794'}"></span>
        <div class="pp-title">
          <h3 class="pp-name">${game.provinceName(province.id)}</h3>
          <div class="pp-owner">
            ${owner ? owner.name : 'Нейтральная территория'}
            ${isMine ? '<span class="pp-badge">ваша</span>' : ''}
          </div>
        </div>
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
      </div>

      <div class="pp-rows">
        <div class="pp-row"><span>Население</span><b>${province.pop.toFixed(1)} млн</b></div>
        <div class="pp-row"><span>Доход провинции</span><b class="gold">${isMine ? `+${(income * doctrineIncome).toFixed(2)} золота/с` : '—'}</b></div>
        <div class="pp-row"><span>Прирост рекрутов</span><b>${isMine ? `+${(recruits * 60).toFixed(0)}/мин` : '—'}</b></div>
        <div class="pp-row"><span>Крепость</span><b>${province.fort > 0 ? `уровень ${province.fort} из ${BAL.maxLevel}` : 'нет'}</b></div>
      </div>

      <div class="pp-section">
        <span>Развитие провинции</span>
        ${isMine ? '' : '<span class="pp-section-note">только для своих земель</span>'}
      </div>
      <div class="pp-upgrades">${upgrades}</div>
      <p class="pp-hint">${
        isMine
          ? `Перетащите войска на соседнюю провинцию, чтобы усилить её или атаковать: уйдёт ${Math.round(game.state.sendRatio * 100)}% гарнизона (${fmt(game.sendableTroops(province.id))} чел.). Можно отправлять сразу в несколько сторон — из провинции уйдёт столько отрядов, сколько вы прикажете.`
          : `Чтобы атаковать, перетащите войска сюда из своей соседней провинции. Гарнизон здесь ${fmt(province.garrison)}, оборона ${fmt(defense)}.`
      }</p>
    `;
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
        <span class="o-cost">◈ ${BAL.orderGold[order.id]}</span>
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
        hint: 'Как часто державы решаются нападать друг на друга.',
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
        key: 'victoryShare',
        title: 'Условие победы',
        hint: 'Доля провинций Европы, которую нужно контролировать.',
        options: VICTORY_SHARES.map((option) => ({ value: option.value, label: option.label })),
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
                  class="${rules[group.key] === option.value ? 'active' : ''}">${option.label}</button>`,
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
      if (key === 'victoryShare') this.#updateHud();
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
      const raw = button.dataset.value;
      const value = raw === 'true' ? true : raw === 'false' ? false : Number(raw);
      button.classList.toggle('active', rules[key] === value);
    }
  }

  #updatePauseSummary() {
    const summary = $('#pause-rules-summary');
    if (!summary) return;
    const rules = this.game ? this.game.state.rules : this.pendingRules;
    summary.textContent = describeRules(rules);
  }

  #openRankings() {
    if (!this.game) return;
    sfx.click();
    $('#modal-rankings').classList.remove('hidden');
    this.#renderRankings();
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
      }))
      .sort((a, b) => b.army - a.army || b.provinces - a.provinces);

    const totalProvinces = Object.keys(game.state.provinces).length;
    $('#rank-table').innerHTML = `
      <div class="rank-row rank-head">
        <span>Держава</span><span>Земли</span><span>Армия</span><span>Доход</span><span>Рекруты</span>
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
          <span class="rank-cell">${row.nation.alive ? `+${row.income.toFixed(1)}/с` : '—'}</span>
          <span class="rank-cell">${row.nation.alive ? `+${row.recruits.toFixed(0)}/мин` : '—'}</span>
        </div>`,
        )
        .join('')}
    `;
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
    for (const province of Object.values(provinces)) {
      colors[province.id] = province.owner
        ? this.game.state.nations[province.owner].color
        : '#59626e';
    }
    this.world.setOwnership(colors);
  }

  // ---------------------------------------------------------------- UI bindings

  #bindUi() {
    $('#btn-howto').addEventListener('click', () => {
      sfx.click();
      $('#modal-howto').classList.remove('hidden');
    });
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

    $('#btn-pause-rules').addEventListener('click', () => {
      this.rulesReturnToPause = true;
      $('#modal-pause').classList.add('hidden');
      this.#openRules();
    });
    $('#btn-continue').addEventListener('click', async () => {
      sfx.select();
      const saved = await this.#resumeFromStorage();
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
    $('#btn-pause-menu').addEventListener('click', () => this.openPause());
    $('#btn-rankings').addEventListener('click', () => this.#openRankings());

    for (const button of $('#ratio-group').children) {
      button.addEventListener('click', () => {
        const ratio = Number(button.dataset.ratio);
        if (this.game) this.game.setSendRatio(ratio);
        for (const other of $('#ratio-group').children) {
          other.classList.toggle('active', other === button);
        }
        sfx.click();
      });
    }

    $('#province-panel').addEventListener('click', (event) => {
      const close = event.target.closest('[data-close]');
      if (close) {
        this.selectedProvince = null;
        this.world.setSelected(null);
        $('#province-panel').classList.add('hidden');
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
    $('#toggle-sound').checked = this.settings.sound;
    $('#toggle-labels').checked = this.settings.labels;
    sfx.setEnabled(this.settings.sound);

    $('#btn-again').addEventListener('click', () => {
      $('#screen-end').classList.add('hidden');
      this.#restart();
    });
    $('#btn-end-menu').addEventListener('click', () => {
      $('#screen-end').classList.add('hidden');
      this.showMenu();
    });

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.save();
    });
    window.addEventListener('beforeunload', () => this.save());
    window.addEventListener('resize', () => this.arrowLayer.resize());
  }

  #bindKeyboard() {
    window.addEventListener('keydown', (event) => {
      if (this.screen !== 'game' || !this.game) return;
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
    });
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
    }
    this.world.render();
    requestAnimationFrame(this.loop);
  }
}
