import { World } from '../render/world.js';
import { LabelLayer } from '../render/labels.js';
import { ArrowLayer } from '../render/arrows.js';
import { Game } from '../game/game.js';
import { SCENARIOS, PLAYABLE_SCENARIOS, TUTORIAL_ID, DOCTRINES, THEATRES, getScenario, hasScenario } from '../data/scenarios.js';
import { BAL, UPGRADES, ORDERS } from '../game/balance.js';
import { assignNeutralColors } from '../data/neutral.js';
import { populationIndex } from '../data/population.js';
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
import { TutorialUI } from './tutorial.js';
import { buildGoal, goalProgressText } from '../game/goal.js';
import {
  ACHIEVEMENTS,
  achievementById,
  dailyChallenge,
  dayKey,
  describeDaily,
  earnedAchievements,
  interstitialAllowed,
  isDailyFresh,
  isUnlocked,
  normalizeStars,
  rewardedAllowed,
  starTotals,
  theatreOrder,
  unlockSource,
  unlockStars,
  untilNextDay,
} from '../game/progress.js';
import { offerTitle, provincesCount, nationsCount, plural } from '../game/text.js';

const SAVE_KEY = 'crowns.save.v1';
const SETTINGS_KEY = 'crowns.settings.v1';
const TIPS_KEY = 'crowns.tips.v1';
const DIFFICULTY_LEVEL = { 'Низко': 1, 'Средне': 2, 'Высоко': 3 };
// К2.2: the three stars, in the order `Game#score()` builds them.
const STAR_LABELS = ['цель', 'земли', 'слово'];
// К4: the lesson runs on its own rules and never writes them back into the
// player's settings. Peace until the player's own war, a quiet AI, no automatic
// helpers: the first drag and the first order must be the player's own.
const TUTORIAL_RULES = {
  aiStyle: 'calm',
  peaceUntilFirstWar: true,
  aiPassive: false,
  neutrals: 'weak',
  mode: 'goal',
  startPaused: false,
  autoPause: true,
  autoBuild: false,
  autoSend: false,
};
const TUTORIAL_DONE_TIP = 'tutorial-done';

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
    this.tutorialUI = new TutorialUI({ world: this.world, onSkip: () => this.#leaveTutorial() });

    this.screen = 'menu';
    this.game = null;
    this.scenario = null;
    this.selectedNation = null;
    this.doctrine = 'coin';
    // К3.5: the doctrine picker is folded on the nation screen — one line with
    // the current choice, the three cards on demand.
    this.doctrineOpen = false;
    this.selectedProvince = null;
    this.lastSpeed = 1;
    this.preferredRatio = 0.5;
    this.pressing = false;
    // К4: null outside the lesson; otherwise 'drag' | 'capture' | 'offer' | 'order'.
    this.tutorialPhase = null;
    this.tutorialOfferTimer = null;
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
        // Unknown keys (`played`, later the star table) must survive a save.
        ...raw,
        sound: raw.sound !== false,
        labels: raw.labels !== false,
        tips: raw.tips !== false,
        rules: raw.rules ?? null,
        // К5: the meta of the game lives next to the settings, because that is
        // where it already was (stars) and because it is small enough for one
        // localStorage key.
        stars: normalizeStars(raw.stars ?? {}),
        bestTimes: raw.bestTimes && typeof raw.bestTimes === 'object' ? raw.bestTimes : {},
        daily: raw.daily && typeof raw.daily === 'object' ? raw.daily : null,
        achievements: raw.achievements && typeof raw.achievements === 'object' ? raw.achievements : {},
        dailyDone: Number(raw.dailyDone) || 0,
      };
    } catch {
      return {
        sound: true,
        labels: true,
        tips: true,
        rules: null,
        stars: {},
        bestTimes: {},
        daily: null,
        achievements: {},
        dailyDone: 0,
      };
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

  /** К5.3: everything earned, in the shape the cloud key `meta` holds. */
  #metaPayload() {
    return {
      v: 1,
      stars: normalizeStars(this.settings.stars),
      bestTimes: this.settings.bestTimes ?? {},
      daily: this.settings.daily ?? null,
      dailyDone: Number(this.settings.dailyDone) || 0,
      achievements: this.settings.achievements ?? {},
      // К6: the same ad gate on every device — a second browser must not hand
      // a newcomer another three ad-free matches.
      matches: Number(this.settings.matches) || 0,
    };
  }

  /** Pushes the meta to Yandex. Best effort: a browser without the SDK ignores it. */
  #saveMeta() {
    platform.save({ meta: this.#metaPayload() });
  }

  /**
   * The cloud copy of the meta. Stars only go up, a record time only goes down,
   * a daily check mark survives only for its own day, achievements are a union:
   * playing on two devices must never erase one of them.
   */
  mergeCloudMeta(meta) {
    if (!meta || typeof meta !== 'object') return;
    const stars = normalizeStars({ ...(meta.stars ?? {}) });
    const merged = { ...(this.settings.stars ?? {}) };
    for (const [id, value] of Object.entries(stars)) merged[id] = Math.max(merged[id] ?? 0, value);
    this.settings.stars = normalizeStars(merged);
    for (const [id, value] of Object.entries(meta.bestTimes ?? {})) {
      const time = Number(value);
      if (!Number.isFinite(time) || time <= 0) continue;
      const current = Number(this.settings.bestTimes?.[id]) || 0;
      if (!current || time < current) this.settings.bestTimes = { ...(this.settings.bestTimes ?? {}), [id]: Math.round(time) };
    }
    if (isDailyFresh(meta.daily?.card, dayKey())) {
      const mine = this.settings.daily;
      const same = isDailyFresh(mine?.card, dayKey());
      if (!same) this.settings.daily = meta.daily;
      else if (meta.daily.done && !mine.done) this.settings.daily = { ...mine, done: true };
    }
    this.settings.dailyDone = Math.max(Number(this.settings.dailyDone) || 0, Number(meta.dailyDone) || 0);
    this.settings.matches = Math.max(Number(this.settings.matches) || 0, Number(meta.matches) || 0);
    this.settings.achievements = { ...(meta.achievements ?? {}), ...(this.settings.achievements ?? {}) };
    this.#saveSettings();
    this.#buildMenu();
  }

  /**
   * One entry point for what the cloud returned: the running match and the meta.
   * Called from main.js after the SDK has answered, before the first screen.
   */
  applyCloud(cloud) {
    if (!cloud) return;
    if (cloud.save) {
      try {
        const saved = JSON.parse(cloud.save);
        if (saved?.game) this.enableContinue(saved);
      } catch {
        /* malformed cloud save: the local one, if any, still works */
      }
    }
    if (cloud.meta) this.mergeCloudMeta(cloud.meta);
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

  /**
   * «Играть»: the recommended pairing of the chosen theatre, no questions.
   * The scenario is the first of the theatre; the nation is the strongest one
   * («Просто» on the nation screen), because the one-tap path must not drop a
   * first-timer into a one-province minor.
   */
  #playNow() {
    const scenario = PLAYABLE_SCENARIOS.find((s) => (s.theatre ?? 'europe') === this.mapMode) ?? PLAYABLE_SCENARIOS[0];
    sfx.select();
    this.scenario = scenario;
    const ranked = scenario.nations
      .map((nation) => ({ nation, army: this.#nationPreview(nation).army }))
      .sort((a, b) => b.army - a.army);
    this.selectedNation = ranked[0]?.nation.id ?? scenario.nations[0].id;
    this.setTheatre(scenario.theatre ?? 'europe');
    this.startGame();
  }

  #buildMenu() {
    const list = $('#scenario-list');
    list.innerHTML = '';
    // The lesson is a door, not a room: it is never offered as a scenario card.
    for (const scenario of PLAYABLE_SCENARIOS.filter((s) => (s.theatre ?? 'europe') === this.mapMode)) {
      const level = DIFFICULTY_LEVEL[scenario.difficulty] ?? 2;
      const dots = Array.from({ length: 3 }, (_, i) => `<i class="${i < level ? 'on' : ''}"></i>`).join('');
      const best = Math.max(0, Math.min(3, Number(this.settings.stars?.[scenario.id]) || 0));
      const starRow = best
        ? `<span class="scenario-stars" title="Лучший результат">${Array.from({ length: 3 }, (_, i) => `<span class="mini-star ${i < best ? 'is-on' : ''}">${icon('star', 12)}</span>`).join('')}</span>`
        : '';
      // К5.1: the next scenario opens for one star in the previous one. The
      // lock is drawn on the card and explained on click; a dead card with no
      // answer is how a menu loses a player.
      const unlocked = isUnlocked(scenario.id, this.settings.stars);
      const need = unlockStars(scenario.id);
      const source = unlockSource(scenario.id);
      const lockRow = unlocked
        ? ''
        : `<span class="card-lock" title="Откроется за ${need} звезду">${icon('lock', 12)}${plural(need, 'звезда', 'звезды', 'звёзд')}</span>`;
      const bestTime = Number(this.settings.bestTimes?.[scenario.id]) || 0;
      const card = document.createElement('button');
      card.className = `scenario-card${unlocked ? '' : ' is-locked'}`;
      card.type = 'button';
      card.dataset.scenario = scenario.id;
      card.setAttribute('aria-disabled', String(!unlocked));
      card.innerHTML = `
        <div class="scenario-era">${scenario.era}</div>
        ${starRow}
        ${lockRow}
        <div class="scenario-title">${scenario.title}</div>
        <div class="scenario-desc">${unlocked ? scenario.blurb : `Откроется за ${plural(need, 'звезду', 'звезды', 'звёзд')} в «${source?.title ?? 'предыдущем сценарии'}».`}</div>
        <div class="scenario-meta">
          <span class="th-long">${THEATRES[scenario.theatre]?.title ?? 'Европа'}</span>
          <span class="th-short">${THEATRES[scenario.theatre]?.short ?? 'Европа'}</span>
          <span>${nationsCount(scenario.nations.length)}</span>
          ${bestTime ? `<span class="scenario-best" title="Лучшее время выполнения цели">${this.#clockText(bestTime)}</span>` : ''}
          <span class="difficulty">${dots}<span>${scenario.difficulty}</span></span>
        </div>`;
      card.addEventListener('click', () => {
        if (!unlocked) {
          sfx.loss();
          this.#toast(`Сценарий откроется за ${plural(need, 'звезду', 'звезды', 'звёзд')} в «${source?.title ?? 'предыдущем сценарии'}»`, 'bad');
          return;
        }
        sfx.select();
        this.openNationSelect(scenario.id);
      });
      list.appendChild(card);
    }
    $('#btn-continue').classList.toggle('hidden', !this.hasSave);
    this.#buildDaily();
    this.#renderStarTotal();
  }

  /** «★ 7 из 24» in the footer: the one number that says how far you have come. */
  #renderStarTotal() {
    const node = $('#menu-stars');
    if (!node) return;
    const { earned, max } = starTotals(this.settings.stars);
    node.innerHTML = `${icon('star', 12)} ${earned} из ${max}`;
    node.title = 'Сумма звёзд по всем сценариям';
  }

  /** «1:20» — a match clock, also used for the best time on a card. */
  #clockText(seconds) {
    const total = Math.max(0, Math.round(seconds));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  }

  /**
   * К5.2: today's task. Resolved once per day and kept in the settings, so the
   * card does not change while the player is deciding, and so a reload does not
   * reroll it into something easier.
   */
  #dailyCard() {
    const today = dayKey();
    const stored = this.settings.daily;
    // One task per day and one per theatre: a world-mode player must not be
    // sent to Europe by the «Играть» button under a card that names Europe.
    const cards = isDailyFresh(stored?.card, today) && stored?.cards ? stored.cards : {};
    if (cards[this.mapMode]) return cards[this.mapMode];
    const card = dailyChallenge({ today, stars: this.settings.stars, theatre: this.mapMode });
    const fresh = {
      ...(stored ?? {}),
      // `done` is global: the day's task is done once, whichever theatre it was.
      done: isDailyFresh(stored?.card, today) ? Boolean(stored?.done) : false,
      card,
      cards: { ...cards, [this.mapMode]: card },
    };
    this.settings.daily = fresh;
    this.#saveSettings();
    return card;
  }

  #buildDaily() {
    const box = $('#menu-daily');
    if (!box) return;
    const card = this.#dailyCard();
    const done = Boolean(this.settings.daily?.done) && isDailyFresh(this.settings.daily?.card, dayKey());
    this.dailyCard = card;
    box.classList.toggle('is-done', done);
    box.innerHTML = `
      <span class="daily-icon">${icon(done ? 'check' : 'calendar', 18)}</span>
      <span class="daily-body">
        <span class="daily-title">${done ? 'Задача дня выполнена' : 'Задача дня'}</span>
        <span class="daily-text">${describeDaily(card)}</span>
        <span class="daily-where">${card.scenarioTitle} · ${THEATRES[card.theatre ?? 'europe']?.title ?? 'Европа'} · ${card.era} · ${card.nationName}${done ? ` · новая ${untilNextDay()}` : ''}</span>
      </span>
      ${done ? '' : '<button class="btn primary" type="button" data-daily-start>Играть</button>'}`;
    box.querySelector('[data-daily-start]')?.addEventListener('click', () => {
      sfx.select();
      this.#startDaily(card);
    });
  }

  /** Starts the daily match: its own aim, the scenario and nation of the card. */
  #startDaily(card) {
    const scenario = getScenario(card.scenarioId);
    if (!scenario) return;
    this.scenario = scenario;
    this.selectedNation = scenario.nations.some((n) => n.id === card.nationId) ? card.nationId : scenario.nations[0].id;
    this.doctrine = 'coin';
    this.mapMode = scenario.theatre ?? 'europe';
    this.setTheatre(this.mapMode);
    this.startGame({ goalOverride: card.goal, daily: card.date });
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
    this.tutorialPhase = null;
    clearTimeout(this.tutorialOfferTimer);
    this.tutorialUI?.hide();
    $('#screen-game')?.classList.remove('is-tutorial');
    this.autoFrom = null;
    this.panelFolded = false;
    clearTimeout(this.panelFoldTimer);
    this.#setFocusCard(false);
    $('#app')?.classList.remove('orders-open');
    // Leaving the result screen by any route (menu, restart, victory of the
    // lesson) must drop the flag that hides the toast strip.
    $('#app')?.classList.remove('has-end');
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
    // Stars earned in the match just finished belong on the scenario card the
    // player sees when they come back.
    this.#buildMenu();
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
    this.doctrineOpen = false;
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
          <span class="tile-sub">${nation.provinces.length} пров. · ${this.#popTotal(nation.provinces).toFixed(1)} млн</span>
          <span class="tile-army">Армия ${fmt(preview.army)}<span class="tile-diff" data-level="${difficulty.id}">${difficulty.label}</span></span>
        </span>`;
      item.addEventListener('click', () => this.#selectNation(nation.id, true));
      list.appendChild(item);
    }
    $('#nation-count').textContent = `${nationsCount(this.scenario.nations.length)} · ${this.scenario.era}`;
    this.#renderNationDetail();
  }

  /**
   * Millions shown on screen. The simulation's weights are not people: each
   * scenario has the population its century had (see data/population.js), and
   * the index is cached per map because it never changes during a match.
   */
  #popIndex() {
    const map = this.map;
    const id = this.scenario?.id ?? this.game?.state?.scenarioId ?? '';
    if (!map) return null;
    if (this.popCache?.id !== id || this.popCache?.map !== map) {
      this.popCache = { id, map, index: populationIndex(this.scenario ?? { id }, map) };
    }
    return this.popCache.index;
  }

  /** Population of one province, in millions. */
  #popOf(provinceId) {
    const index = this.#popIndex();
    if (!index) return 0;
    return index.get(provinceId) ?? 0;
  }

  /** Population of a nation, in millions. */
  #popTotal(provinces) {
    return provinces.reduce((sum, id) => sum + this.#popOf(id), 0);
  }

  /** The same sentence the game will use, built from scenario data. */
  #goalPreview(nation) {
    const owners = {};
    for (const n of this.scenario.nations) for (const pid of n.provinces) owners[pid] = n.id;
    const goal = buildGoal({
      scenario: this.scenario,
      nationId: nation.id,
      owners,
      mode: this.pendingRules.mode ?? 'goal',
    });
    if (this.pendingRules.mode === 'conquest') return 'Победа — вся карта. Часов нет, партия может идти долго.';
    return `${goal.text}. Дальше — «время вышло» с итогом, а не поражение.`;
  }

  /** «3 мин 20 с» / «48 с» — for the match summary. */
  #durationText(seconds) {
    const total = Math.max(0, Math.round(seconds));
    const min = Math.floor(total / 60);
    if (!min) return `${total} с`;
    return `${plural(min, 'минуту', 'минуты', 'минут')} ${total % 60} с`;
  }

  /** «Лучший результат: ★★☆» — the stars are stored per scenario. */
  #starsLine(count) {
    const stars = Math.max(0, Math.min(3, Number(count) || 0));
    if (!stars) return 'Партия ещё не сыграна';
    const row = Array.from({ length: 3 }, (_, i) => `<span class="mini-star ${i < stars ? 'is-on' : ''}">${icon('star', 12)}</span>`).join('');
    return `Лучший результат: <span class="mini-stars">${row}</span>`;
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
        <div class="ds"><span class="k">Население</span><span class="v">${this.#popTotal(nation.provinces).toFixed(1)} млн</span></div>
        <div class="ds"><span class="k">Доход</span><span class="v gold">+${preview.income.toFixed(1)}/с</span></div>
        <div class="ds"><span class="k">Армия</span><span class="v">${fmt(preview.army)}</span></div>
        <div class="ds"><span class="k">Рекруты</span><span class="v">+${(preview.recruits * 60).toFixed(0)}/мин</span></div>
      </div>
      <div class="detail-goal">
        <div class="eyebrow">Цель <span class="eyebrow-note">${this.pendingRules.mode === 'conquest' ? 'вся карта' : 'до 8 минут'}</span></div>
        <div class="goal-modes" role="group" aria-label="Режим партии">
          <button type="button" data-goal-mode="goal" class="goal-mode ${this.pendingRules.mode === 'conquest' ? '' : 'is-active'}">Цель</button>
          <button type="button" data-goal-mode="conquest" class="goal-mode ${this.pendingRules.mode === 'conquest' ? 'is-active' : ''}">Завоевание</button>
        </div>
        <p class="goal-aim">${this.#goalPreview(nation)}</p>
        <p class="goal-best">${this.#starsLine(this.settings.stars?.[this.scenario.id])}</p>
      </div>
      <div class="detail-doctrine ${this.doctrineOpen ? 'is-open' : ''}">
        <button type="button" class="doctrine-sum" data-doctrine-toggle aria-expanded="${this.doctrineOpen ? 'true' : 'false'}">
          <span class="eyebrow">Доктрина</span>
          <b>${doctrine.name}</b>
          <span class="doctrine-switch">${this.doctrineOpen ? 'скрыть' : 'сменить'}</span>
        </button>
        <div class="doctrine-body">
          <div class="eyebrow-note">действует всю партию</div>
          <div id="doctrine-list" class="doctrine-list"></div>
          <p class="doctrine-note">${doctrine.description}</p>
        </div>
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
    // The nation card scrolls on short screens. Without a hint the row cut by
    // the CTA looks like a broken layout, so the bottom fades while more is
    // below — the same «has-more» the province panel uses.
    const scroll = $('#nation-detail .detail-scroll');
    if (scroll) {
      const sync = () => {
        const atEnd = scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 2;
        scroll.classList.toggle('has-more', scroll.scrollHeight > scroll.clientHeight + 2 && !atEnd);
      };
      scroll.addEventListener('scroll', sync, { passive: true });
      new ResizeObserver(sync).observe(scroll);
      sync();
    }
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

  startGame(overrides = {}) {
    if (!this.selectedNation) return;
    // The lesson passes its own rules and leaves the player's settings alone.
    const rules = normalizeRules(overrides.rules ?? this.pendingRules);
    const game = new Game({
      scenarioId: this.scenario.id,
      nationId: this.selectedNation,
      doctrineId: this.doctrine,
      map: this.map,
      seed: (Math.random() * 2 ** 31) | 0,
      rules,
      goalOverride: overrides.goalOverride ?? null,
      daily: overrides.daily ?? null,
    });
    game.setSendRatio(this.preferredRatio);
    this.#attachGame(game);
    if (!overrides.rules) this.pendingRules = normalizeRules(rules);
    this.#enterGameScreen();
    // The opening pause is for a first look at the map. A scenario the player
    // already finished is familiar, so it starts on its own — К1.1.
    const repeat = Array.isArray(this.settings.played) && this.settings.played.includes(this.scenario.id);
    if (rules.startPaused && !repeat) {
      this.lastSpeed = 1;
      this.setSpeed(0);
      this.#toast('Партия на паузе. Нажмите «Играть», когда осмотритесь', 'info');
    } else if (this.game.state.speed === 0) {
      this.lastSpeed = 1;
      this.setSpeed(1);
    }
    if (this.game.state.tutorial) this.#beginTutorial();
  }

  #attachGame(game) {
    this.game = game;
    // К5.2: this match is played for today's task. Kept on the app as well as in
    // the save so the end screen can mark the day without asking the model.
    this.dailyActive = Boolean(game.state.daily);
    this.scenario = getScenario(game.state.scenarioId);
    this.setTheatre(this.scenario.theatre ?? 'europe');
    this.selectedNation = game.state.nationId;
    this.selectedProvince = null;
    this.preferredRatio = game.state.sendRatio;
    this.#syncRatioButtons();
    this.colorSignature = '';
    this.#clearArmies();
    $('#log').innerHTML = '';
    this.logEntries = [];
    game.state.log.length = 0;

    game.on((type, payload) => {
      if (type === 'log') this.#addLog(payload);
      if (type === 'capture') {
        this.world.flashProvince(payload.provinceId, 1);
        if (payload.to === game.state.nationId) {
          sfx.capture();
          this.#toast(`Провинция ${game.provinceName(payload.provinceId)} взята`, 'good');
          this.#tutorialEvent('capture');
          if (this.selectedProvince === payload.provinceId) this.#renderProvincePanel();
          this.#tip(
            'capture',
            'Провинция ваша. Улучшения игра покупает сама — клик по провинции, если хотите решить самому',
          );
        } else if (payload.from === game.state.nationId) {
          sfx.loss();
          this.#toast(`Потеряна ${game.provinceName(payload.provinceId)}`, 'bad');
        }
      }
      if (type === 'focusChoice' && payload.nationId === game.state.nationId) {
        // A fork in the focus chain is a choice, not a notification.
        this.#updateFocus();
        this.#autoPause(null, { force: true });
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
        // The column is on the road: give the player time to reinforce.
        // Province names stay in the nominative, so the reason is built with an
        // apposition in quotes («идёт на провинцию «Франция»»), not with a case
        // the app cannot decline.
        const paused = this.#autoPause(
          `${game.state.nations[payload.attacker]?.short ?? 'Противник'} идёт на провинцию «${game.provinceName(payload.to)}»`,
        );
        // One message, not two: the pause toast already says who is marching
        // where. The short toast stays for the marches that arrive while the
        // game is running (a second column in the same war).
        const now = performance.now();
        if (!paused && now - (this.lastIncomingToast ?? 0) > 1200) {
          this.lastIncomingToast = now;
          const who = game.state.nations[payload.attacker]?.short ?? 'Противник';
          this.#toast(`${who}: ${fmt(payload.amount)} → ${game.provinceName(payload.to)}`, 'bad');
        }
      }
      if (type === 'autoWar') {
        // К3.4: the helper may start a campaign in a capture-goal match. That
        // is the one automatic action the player must see, so it says so once.
        this.#toast(`Начался поход на ${payload.enemy ?? 'соседа'}`, 'bad');
      }
      if (type === 'passage' && payload.by === game.state.nationId && payload.broken) {
        const who = game.state.nations[payload.with]?.short ?? 'Противник';
        this.#toast(`${who}: договор о проходе расторгнут`, 'bad');
      }
      if (type === 'offer') {
        sfx.click();
        this.#renderOffers();
        // An offer has a countdown and only the player can answer it.
        this.#autoPause(null, { force: true });
        this.#tutorialEvent('offer');
      }
      if (type === 'offerClosed') {
        this.#renderOffers();
        this.#tutorialEvent('offerClosed');
        if (payload.accepted) {
          const kind = payload.offer?.kind;
          this.#toast(kind === 'tribute' ? 'Дань получена: мир с уступкой' : 'Мир заключён: перемирие', 'good');
        }
        // Expiry is written to the journal by the game; a toast for something
        // the player deliberately ignored is noise.
      }
      if (type === 'truceBroken') {
        // Only treaties of the player are news. A pact broken between two
        // computer empires used to pop up as «вам больше не верят», which was
        // both wrong and noise.
        const me = this.game.state.nationId;
        const mine = payload?.by === me || payload?.with === me;
        if (mine) {
          const other = this.game.state.nations[payload.by === me ? payload.with : payload.by];
          const who = other?.short;
          if (payload?.kind === 'pact') {
            this.#toast(who ? `${who} разрывает пакт` : 'Пакт разорван — вам больше не верят', 'bad');
          } else {
            this.#toast(who ? `${who} нарушает перемирие` : 'Перемирие нарушено — усталость выросла', 'bad');
          }
        }
      }
      if (type === 'battle') {
        const me = game.state.nationId;
        // The sound is a cue for the player's own fight; a war two continents
        // away used to rattle the speakers every second.
        const mine = payload?.attacker === me || payload?.defender === me;
        const now = performance.now();
        if (mine && now - this.lastBattleSound > 700) {
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
    // the right on a phone or a short window. The layout is a media query, so
    // the geometry test («taller than wide») missed the single «Приказ» button
    // of К3 and the map was squeezed above it as if it were a bottom bar.
    const sideColumn = window.matchMedia('(max-width: 560px), (max-height: 520px)').matches;
    const column =
      usable &&
      (sideColumn || (barRect.right > vw * 0.82 && barRect.height > barRect.width * 0.7));
    const right = column ? Math.max(0, Math.round(vw - barRect.left)) : 0;
    const hud = document.querySelector('.hud-top')?.getBoundingClientRect();
    const foot = document.querySelector('.hud-bottom')?.getBoundingClientRect();
    const footTop = usable && !column ? Math.min(vh, barRect.top) : vh;
    const footInset = foot && foot.height > 0 ? vh - foot.top : vh;
    // One number drives everything that hangs from the top: the map's safe
    // band, the goal line, the hint pill and the toasts.
    const hudBottom = hud && hud.height > 0 ? Math.round(hud.bottom) : 0;
    if (hudBottom !== this.hudBottom) {
      this.hudBottom = hudBottom;
      document.documentElement.style.setProperty('--hud-bottom', `${hudBottom}px`);
    }
    this.world.setSafeArea({
      top: hudBottom,
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

  /**
   * The opening instruction sits in the hint pill above the map and changes in
   * steps instead of stacking several «drag this» toasts on top of each other.
   * Every step is skipped once the player has already done the thing.
   */
  #onboard() {
    this.onboardTimers?.forEach(clearTimeout);
    if (this.game?.state.tutorial) return;
    const timers = [];
    timers.push(
      setTimeout(() => {
        if (this.screen !== 'game' || this.selectedProvince) return;
        this.#hint('Клик по провинции — улучшения, гарнизон и приказы');
      }, 9000),
    );
    timers.push(
      setTimeout(() => {
        if (this.screen !== 'game') return;
        this.#hint('Договоры и войны — меню паузы → «Обстановка» → «Переговоры» (клавиша R)');
      }, 20000),
    );
    this.onboardTimers = timers;
  }

  #endGame({ result, reason, rival }) {
    const game = this.game;
    // Remember that this scenario is no longer a discovery: the next run of it
    // skips the opening pause instead of asking «Играть» again.
    const played = new Set(Array.isArray(this.settings.played) ? this.settings.played : []);
    played.add(game.state.scenarioId);
    this.settings.played = [...played].slice(-20);
    // К6.3/6.4: the match counter decides when an interstitial may appear. The
    // lesson is not a match: a newcomer finishes three real ones before seeing
    // any ad at all, and after that no more than one ad per two matches.
    const adMatches = Number(this.settings.matches) || 0;
    const adLast = Number.isFinite(Number(this.settings.lastAd)) ? Number(this.settings.lastAd) : -1;
    let showAd = false;
    if (!game.state.tutorial) {
      this.settings.matches = adMatches + 1;
      showAd = interstitialAllowed({ matches: this.settings.matches, lastAd: adLast });
    }
    // A defeat that offers «второй шанс» gets no interstitial: the rewarded
    // video is the offer of this screen, and two ads on one screen is how a
    // player learns to close the tab. The interstitial waits for the next end.
    if (showAd && game.canRevive?.() && rewardedAllowed({ matches: this.settings.matches, adsEnabled: platform.hasRewarded() })) {
      showAd = false;
    }
    if (showAd) this.settings.lastAd = this.settings.matches;
    this.#saveSettings();
    game.state.speed = 0;
    // The end screen owns the window now: nothing may stay hidden behind an
    // open order list or a focus card.
    $('#app').classList.remove('orders-open');
    this.#setFocusCard(false);
    this.#clearArmies();
    localStorage.removeItem(SAVE_KEY);
    this.hasSave = false;
    $('#btn-continue').classList.add('hidden');
    platform.gameplayStop();

    // К2: a reached aim and the clock are both endings, and neither is a defeat.
    const victory = result === 'victory';
    const goalMet = result === 'goal';
    const timeout = result === 'timeout';
    const won = victory || goalMet;
    const goalText = this.game.state.goal?.text ?? '';
    const tutorial = Boolean(game.state.tutorial);
    if (tutorial) this.#markTutorialDone();
    $('#end-emblem').innerHTML = icon(timeout ? 'clock' : victory || goalMet ? 'crown' : 'sword', 36);
    const theatre = THEATRES[this.scenario?.theatre ?? 'europe'];
    const atlantic = theatre?.id === 'atlantic';
    const genitive = atlantic ? 'Атлантики' : 'Европы';
    $('#end-eyebrow').textContent = tutorial
      ? 'Обучение пройдено'
      : victory
        ? atlantic
          ? 'Два берега ваши'
          : 'Европа ваша'
        // The kicker must not repeat the heading word for word: «Время вышло»
        // over «Время вышло» read as a rendering bug.
        : goalMet || timeout
          ? 'Итог'
          : 'Держава пала';
    $('#end-title').textContent = tutorial
      ? 'Готово'
      : victory
        ? 'Победа'
        : goalMet
          ? 'Цель выполнена'
          : timeout
            ? 'Время вышло'
            : 'Поражение';
    $('#end-text').textContent = tutorial
      ? 'Армия, договор и приказ — это вся игра. Бельгия ваша. Дальше настоящая партия: игра сама покупает улучшения и шлёт излишки, вы двигаете армии и решаете, с кем воевать.'
      : victory
      ? `Каждая провинция ${genitive} под вашей короной. Полное завоевание — единственный способ победить, и у вас это получилось.`
      : goalMet
        ? `${goalText} — сделано за ${this.#durationText(this.game.state.time)}. Дальше можно взять всю карту в режиме «Завоевание».`
        : timeout
          ? `Цель «${goalText}» не достигнута: ${this.game.state.goal?.progress ?? 0} из ${this.game.state.goal?.target ?? 0}. Это не поражение — очки считаются по землям и захватам.`
          : reason === 'eliminated'
            ? 'Последнюю провинцию пришлось отдать. В следующий раз держите резервы в глубине и не открывайте все фронты сразу.'
            : 'Ваши земли разделили соседи. В следующий раз начните с укреплений и не открывайте все фронты сразу.';
    const stats = game.state.stats;
    const score = game.score();
    $('#end-stars').innerHTML = score.stars
      .map(
        (star, index) =>
          `<div class="end-star ${star.ok ? 'is-on' : ''}" title="${star.label}">${icon('star', 26)}<span class="star-label">${STAR_LABELS[index]}</span></div>`,
      )
      .join('');
    // Stars are a per-scenario record: they survive the end screen and the
    // next launch, and only ever go up.
    const starsBefore = { ...this.settings.stars };
    const stars = { ...(this.settings.stars ?? {}) };
    const bestStars = Math.max(stars[game.state.scenarioId] ?? 0, score.starCount);
    stars[game.state.scenarioId] = bestStars;
    this.settings.stars = normalizeStars(stars);
    // К5.4: the best time of the aim, in the same table as the stars. Only a
    // reached aim has a time worth keeping: «время вышло» is not a record.
    const time = game.state.time;
    const bestTime = Number(this.settings.bestTimes?.[game.state.scenarioId]) || 0;
    // A record needs a real clock behind it: a match finished in the first
    // second (a resumed save, a scripted run) must not print «Лучшее время 0:00».
    const newRecord = won && time >= 2 && (!bestTime || time < bestTime);
    if (newRecord) this.settings.bestTimes = { ...(this.settings.bestTimes ?? {}), [game.state.scenarioId]: Math.round(time) };
    // К5.2: today's task is checked off by a reached aim in the daily match.
    // The card the match was started from: same day, same scenario. `cards`
    // holds one card per theatre, `card` is the one shown last.
    const dailyState = this.settings.daily ?? {};
    const dailyCard = [dailyState.card, ...Object.values(dailyState.cards ?? {})].find(
      (card) => card && isDailyFresh(card, dayKey()) && card.scenarioId === game.state.daily?.scenarioId,
    ) ?? null;
    const dailyMatch = Boolean(game.state.daily) && Boolean(dailyCard);
    const dailyJustDone = Boolean(won && dailyMatch && !this.settings.daily?.done);
    if (dailyJustDone) {
      this.settings.daily = { ...(this.settings.daily ?? {}), card: dailyCard, done: true };
      this.settings.dailyDone = (Number(this.settings.dailyDone) || 0) + 1;
    }
    // К5.5: achievements, earned once. The SDK call is best effort; the toast is
    // the part the player actually sees.
    const fresh = earnedAchievements(
      { status: game.state.status, stats, starCount: score.starCount, daily: Boolean(won && dailyMatch) },
      this.settings.achievements ?? {},
    );
    if (fresh.length) {
      const owned = { ...(this.settings.achievements ?? {}) };
      for (const id of fresh) owned[id] = Date.now();
      this.settings.achievements = owned;
      for (const id of fresh) platform.unlockAchievement(id);
    }
    this.#saveSettings();
    // К5.3: the same table goes to the cloud, so a second browser sees the stars.
    this.#saveMeta();
    // К5.4: three tables, all of them «выше — лучше» (Yandex leaderboards sort
    // descending, so the time is submitted converted: seconds saved of two
    // hours, never a raw «who was faster» where a small number would lose).
    const totalStars = starTotals(this.settings.stars).earned;
    platform.submitScore('crowns_stars', totalStars);
    if (won) platform.submitScore('crowns_time', Math.max(0, 7200 - Math.round(time)));
    $('#end-stats').innerHTML = `
      <div class="end-stat"><div class="k">Провинций</div><div class="v">${game.progress.owned}</div></div>
      <div class="end-stat"><div class="k">Захвачено</div><div class="v">${stats.captured}</div></div>
      <div class="end-stat"><div class="k">Битв</div><div class="v">${stats.battles}</div></div>
      <div class="end-stat"><div class="k">Пик империи</div><div class="v">${stats.peak}</div></div>
      <div class="end-stat"><div class="k">Потеряно</div><div class="v">${stats.lostProvinces}</div></div>
      <div class="end-stat"><div class="k">Лет правления</div><div class="v">${Math.max(1, Math.round((game.state.months - this.scenario.startYear * 12) / 12))}</div></div>
      <div class="end-stat"><div class="k">Отбито атак</div><div class="v">${stats.battlesWon ?? 0}</div></div>`;
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
    // К5: what the match changed beyond the numbers — the task of the day, the
    // star table, a record and the scenario it just opened.
    const opened = theatreOrder(this.scenario.theatre ?? 'europe').filter(
      (s) => !isUnlocked(s.id, starsBefore) && isUnlocked(s.id, this.settings.stars),
    );
    const { earned } = starTotals(this.settings.stars);
    const pieces = [];
    if (dailyMatch) {
      pieces.push(
        dailyJustDone
          ? '<span class="is-good">Задача дня выполнена</span>'
          : '<span class="is-bad">Задача дня не выполнена — можно попробовать ещё раз</span>',
      );
    }
    pieces.push(`<span>${icon('star', 12)} ${earned} из ${starTotals(this.settings.stars).max}</span>`);
    if (newRecord) pieces.push(`<span class="is-good">Лучшее время: ${this.#clockText(time)}</span>`);
    for (const id of fresh) {
      const meta = achievementById(id);
      if (meta) pieces.push(`<span class="is-good">${icon('trophy', 12)} ${meta.title}</span>`);
    }
    for (const scenario of opened) pieces.push(`<span class="is-good">Открыт сценарий «${scenario.title}»</span>`);
    $('#end-meta').innerHTML = pieces.join('');
    $('#end-board').classList.add('hidden');
    $('#end-board').innerHTML = '';
    this.#renderBoard(score.total, totalStars);
    $('#btn-again').textContent = tutorial ? 'Дальше: настоящая партия' : 'Сыграть ещё';
    this.tutorialUI.hide();
    $('#screen-game')?.classList.remove('is-tutorial');
    $('#screen-end').classList.remove('hidden');
    // Stale match chatter («начался поход на Швецию») used to land on top of
    // the score. The result screen owns the window; its own note reports
    // anything that still needs saying.
    $('#app')?.classList.add('has-end');
    if (won) sfx.victory();
    else sfx.defeat();
    // An ad in the minute after the first tap is how a new player leaves, so
    // the first three matches are ad-free and the next ones see one ad each
    // two matches at most (К6.3/6.4).
    this.#updateReviveButton();
    if (showAd) setTimeout(() => platform.showInterstitial(), 1600);
  }

  /**
   * К6.1: the second chance, honest about its price. The button exists only
   * when the realm can actually come back, when the SDK has a rewarded video
   * and when the newcomer window is over — a dead button on a defeat screen is
   * worse than no button.
   */
  #updateReviveButton() {
    const button = $('#btn-revive');
    const note = $('#end-ad-note');
    if (!button || !note) return;
    const game = this.game;
    const ready =
      Boolean(game?.canRevive?.()) &&
      rewardedAllowed({ matches: Number(this.settings.matches) || 0, adsEnabled: platform.hasRewarded() });
    button.classList.toggle('hidden', !ready);
    note.classList.toggle('hidden', !ready);
    button.disabled = false;
    const text = button.querySelector('[data-revive-text]');
    if (text) text.textContent = 'Второй шанс';
  }

  async #offerRevive() {
    const game = this.game;
    const button = $('#btn-revive');
    if (!game || !button || button.disabled) return;
    button.disabled = true;
    const text = button.querySelector('[data-revive-text]');
    if (text) text.textContent = 'Реклама…';
    const granted = await platform.showRewarded();
    if (!granted) {
      // A refusal or a broken ad costs nothing but the try.
      button.disabled = false;
      if (text) text.textContent = 'Второй шанс';
      // The result card covers the middle of the window, so the toast would be
      // half-hidden under it: the card's own footnote says it instead.
      const note = $('#end-ad-note');
      if (note) {
        note.textContent = 'Реклама не загрузилась — второй шанс не потрачен';
        note.classList.remove('hidden');
        clearTimeout(this.adNoteTimer);
        this.adNoteTimer = setTimeout(() => {
          note.textContent = 'Реклама · один раз за партию';
          this.#updateReviveButton();
        }, 4000);
      }
      return;
    }
    const result = game.revive();
    if (!result.ok) {
      this.#toast(result.reason || 'Второй шанс недоступен', 'info');
      return;
    }
    $('#screen-end').classList.add('hidden');
    $('#app')?.classList.remove('has-end');
    this.#updateReviveButton();
    this.#resumeAfterRevive(result.provinceId);
  }

  /** Back into the match: same speed, same camera, the capital in hand. */
  #resumeAfterRevive(provinceId) {
    this.#clearArmies();
    this.hintTimer = 0;
    this.setSpeed(this.lastSpeed || 1);
    platform.gameplayStart();
    this.save();
    this.world.focusOn?.(provinceId);
    this.#toast('Столица возвращается: 25 секунд на передышку', 'good');
    this.#updateHud();
  }

  /**
   * К5.4: where the player stands, in one short line per table. The plan asks
   * for «место в топе видно на экране итогов» — not for a five-row table pushing
   * the buttons off the card, which is exactly what a full leaderboard did on a
   * laptop once the meta lines arrived.
   */
  async #renderBoard(points, stars) {
    const submit = await Promise.all([
      platform.submitScore('crowns', points),
      platform.submitScore('crowns_stars', stars),
    ]);
    if (!submit.some(Boolean)) return;
    const [byPoints, byStars] = await Promise.all([
      platform.topScores('crowns', 3),
      platform.topScores('crowns_stars', 3),
    ]);
    const line = (title, board, format) => {
      if (!board?.entries?.length) return '';
      const best = board.entries[0];
      const mine = board.selfRank ? ` · вы ${board.selfRank}-й` : '';
      return `<span>${title}: лидер ${best.name} ${format(best.score)}${mine}</span>`;
    };
    const html = [
      line('Очки партии', byPoints, (value) => fmt(value)),
      // The leader's number, not the player's: «лидер Пётр 3 из 24» is honest,
      // «лидер Пётр 9 из 24» for every match was the player's own total.
      line('Звёзды', byStars, (value) => `${fmt(value)} из ${starTotals(this.settings.stars).max}`),
    ].join('');
    if (!html) return;
    const board = $('#end-board');
    board.classList.remove('hidden');
    board.innerHTML = html;
  }

  #restart() {
    if (!this.scenario || !this.selectedNation) return;
    // «Сыграть ещё» after the lesson or the daily task starts the game, not the
    // lesson again and not the same dated aim.
    if (this.scenario.tutorial || this.dailyActive) {
      if (this.scenario.tutorial) this.#markTutorialDone();
      this.dailyActive = false;
      this.#playNow();
      return;
    }
    this.startGame();
  }

  // ---------------------------------------------------------------- обучение (К4)

  /**
   * Called once the platform has had its say (a cloud save may exist): the
   * lesson is for a player who has never seen the game, so a save or a finished
   * lesson cancels it. The flag lives in `crowns.tips.v1` next to the other
   * one-time tips, as the plan requires.
   */
  ready() {
    if (!this.#shouldTutorial()) return;
    this.#startTutorial();
  }

  #shouldTutorial() {
    if (this.seenTips.has(TUTORIAL_DONE_TIP)) return false;
    let saved = this.#readSave();
    // A save from the lesson itself (the page was reloaded mid-lesson, and
    // `beforeunload` wrote it) is not a reason to skip the teaching: the match
    // is three minutes old, so the lesson starts over instead of resuming as an
    // unexplained scenario with a clock.
    if (saved?.game?.state?.tutorial) {
      try {
        localStorage.removeItem(SAVE_KEY);
      } catch {
        /* storage may be unavailable */
      }
      saved = null;
      this.hasSave = false;
      $('#btn-continue')?.classList.add('hidden');
    }
    if (saved) return false;
    this.hasSave = false;
    if ((this.settings.played?.length ?? 0) > 0) return false;
    return hasScenario(TUTORIAL_ID);
  }

  #startTutorial() {
    this.scenario = getScenario(TUTORIAL_ID);
    this.selectedNation = 'FRA';
    this.doctrine = 'coin';
    this.mapMode = 'europe';
    this.setTheatre('europe');
    // Own rules, not the player's: a lesson must not rewrite the settings of
    // the match that follows it.
    this.startGame({ rules: TUTORIAL_RULES });
  }

  #markTutorialDone() {
    if (this.seenTips.has(TUTORIAL_DONE_TIP)) return;
    this.seenTips.add(TUTORIAL_DONE_TIP);
    try {
      localStorage.setItem(TIPS_KEY, JSON.stringify([...this.seenTips]));
    } catch {
      /* storage may be unavailable: the lesson still will not repeat this session */
    }
  }

  /** First step: the hand, the pill and the camera on both ends of the gesture. */
  #beginTutorial() {
    this.tutorialPhase = 'drag';
    this.game.setTutorialStep(1);
    $('#screen-game').classList.add('is-tutorial');
    this.tutorialUI.show(1, 'Зажмите Францию и отпустите на Бельгии');
    this.tutorialUI.note('Войска пойдут сами — бой решится по прибытии', 'info');
    this.tutorialUI.setHand('FR', 'BE');
    // A golden ring, the same one the nation picker uses: the hand shows the
    // gesture, the ring shows the destination.
    this.world.setAccent(['BE']);
    // The ordinary camera frames the realm; the lesson needs the target too, and
    // Belgium is a small country: «where do I let go» has to be answered by the
    // picture, not by the hint text on top of it.
    this.world.focusNation(['FR', 'BE', 'LU'], 0.62);
  }

  /** The three steps. Any of them may be skipped by simply doing it earlier. */
  #tutorialEvent(kind) {
    const game = this.game;
    if (!game?.state.tutorial || game.state.tutorial.done) return;
    if (this.screen !== 'game') return;
    if (kind === 'drag' && this.tutorialPhase === 'drag') {
      this.tutorialPhase = 'capture';
      this.game.setTutorialStep(1);
      this.tutorialUI.clearHand();
      this.world.setAccent([]);
      this.tutorialUI.show(1, 'Колонна в походе — дальше она дойдёт сама');
      // The offer must not depend on a battle the player may have picked badly.
      clearTimeout(this.tutorialOfferTimer);
      this.tutorialOfferTimer = setTimeout(() => this.#tutorialOffer(), 12000);
    }
    if (kind === 'capture' && this.tutorialPhase === 'capture') {
      clearTimeout(this.tutorialOfferTimer);
      this.tutorialOfferTimer = setTimeout(() => this.#tutorialOffer(), 900);
    }
    if (kind === 'offer' && this.tutorialPhase === 'offer') {
      this.tutorialUI.highlight('#offer-card .offer-row');
    }
    if (kind === 'offerClosed' && this.tutorialPhase === 'offer') {
      this.#tutorialAfterOffer();
    }
    if (kind === 'order' && this.tutorialPhase === 'order') {
      this.tutorialPhase = null;
      this.tutorialUI.hide();
      this.#markTutorialDone();
      // The aim of the lesson is checked last, so the results screen does not
      // interrupt step two of three.
      this.game.finishTutorial();
    }
  }

  /** Step two: a scripted pact offer from a neighbour who has nothing to lose. */
  #tutorialOffer() {
    clearTimeout(this.tutorialOfferTimer);
    this.tutorialOfferTimer = null;
    const game = this.game;
    if (!game?.state.tutorial || game.state.tutorial.done) return;
    if (this.tutorialPhase !== 'capture') return;
    this.tutorialPhase = 'offer';
    game.setTutorialStep(2);
    this.tutorialUI.show(2, 'Вам предлагают пакт о ненападении — решать вам');
    const neighbours = ['ESP', 'ITA', 'PRU', 'GBR'].filter((id) => game.state.nations[id]?.alive);
    const offered = neighbours.some((id) => game.offerPeace(id, 'pact').ok);
    if (!offered) this.#tutorialAfterOffer();
  }

  /** Step three: the one button the whole game is built around. */
  #tutorialAfterOffer() {
    const game = this.game;
    if (!game?.state.tutorial || game.state.tutorial.done) return;
    this.tutorialPhase = 'order';
    game.setTutorialStep(3);
    this.tutorialUI.show(3, 'Нажмите «Приказ»: игра сама выберет, что нужнее');
    this.tutorialUI.highlight('#btn-order');
    // An offer pauses the match; the lesson resumes it without a second click.
    if (game.state.speed === 0) this.setSpeed(this.lastSpeed || 1);
  }

  /** «Другая партия»: leave the lesson for the menu, and never force it again. */
  #leaveTutorial() {
    clearTimeout(this.tutorialOfferTimer);
    this.tutorialOfferTimer = null;
    this.tutorialPhase = null;
    this.tutorialUI.hide();
    $('#screen-game').classList.remove('is-tutorial');
    this.#markTutorialDone();
    this.showMenu();
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
    // On a phone the sheet takes the bottom of the window: the goals, the toasts
    // and «В поход» step aside so nothing is drawn on top of the plan.
    $('#app')?.classList.add('has-route');
  }

  #closeRoutePlanner() {
    this.routePlanner = null;
    this.routeRender = null;
    $('#route-card').classList.add('hidden');
    $('#app')?.classList.remove('has-route');
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
    this.#tutorialEvent('drag');
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
    // The hover card is a rectangle of numbers: under a treaty offer (which
    // covers the same corner of the map) it was clipped to two words, and in
    // the lesson it competes with the one instruction the player must read.
    if (this.game?.state.tutorial && !this.game.state.tutorial.done) {
      this.#tooltip(null);
      return;
    }
    if (!$('#offer-card')?.classList.contains('hidden')) {
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
    // In a goal match the bar counts the aim, not the whole map: «3 из 4» next to
    // a goal line that says the same thing is one story, while «3/43» above it
    // was a second, contradictory one.
    const goal = game.state.goal;
    const goalMatch = Boolean(goal && goal.limit > 0);
    const barShare = goalMatch ? Math.min(1, goal.progress / Math.max(1, goal.target)) : progress.share;
    $('#hud-progress-text').textContent = goalMatch
      ? `${Math.min(goal.progress, goal.target)}/${goal.target}`
      : `${progress.owned}/${progress.total}`;
    $('#hud-progress-fill').style.width = `${(barShare * 100).toFixed(1)}%`;
    $('.progress-wrap')?.classList.toggle('is-goal', goalMatch);
    $('.progress-wrap')?.setAttribute(
      'title',
      goalMatch ? `Цель партии: ${goal.text}` : 'Прогресс завоевания: сколько провинций карты ваши',
    );

    for (const button of $('#speed-group').children) {
      const speed = Number(button.dataset.speed);
      button.classList.toggle('active', speed === game.state.speed);
    }
    // Paused and not in a menu: offer one obvious way to start the clock. Any
    // open modal owns the window — the pill used to hang over «Правила» and
    // over the end screen, where there is nothing left to start.
    const paused = game.state.speed === 0
      && game.state.status === 'playing'
      && document.querySelectorAll('.modal:not(.hidden)').length === 0;
    $('#btn-speed-play').classList.toggle('hidden', !paused);
    this.#updateGoalLine();
    this.#updateOrders();
    this.#renderOffers();
    if (this.selectedProvince) this.#renderProvincePanel();
    // The hover card must agree with the current men, ratio and truces, not
    // with the moment the pointer happened to stop.
    if (this.hoveredProvince) this.#hover(this.hoveredProvince);
    if (!$('#modal-rankings').classList.contains('hidden')) this.#renderRankings();
  }

  /**
   * К2.4: «Цель: взять ещё 6 провинций · 2 из 6 · 4:12» under the HUD. Rebuilt
   * only when the string changes — the HUD runs five times a second.
   */
  #updateGoalLine() {
    const line = $('#goal-line');
    if (!line || !this.game) return;
    const goal = this.game.state.goal;
    const inMatch = Boolean(goal && goal.limit > 0 && this.game.state.status === 'playing');
    // The top strip gets crowded on a laptop, so a goal match moves the hint
    // and the toasts down once, at the start, instead of fighting for space.
    $('#screen-game').classList.toggle('has-goal', inMatch);
    // The toasts live outside the game screen, so the CSS cannot see `has-goal`
    // on it — the same flag goes on the app root as well.
    $('#app').classList.toggle('has-goal', inMatch);
    // While the clock is stopped the «Играть» pill owns this corner: two
    // floating buttons on the same pixel is how the province card got covered.
    const show = inMatch && this.game.state.speed > 0;
    line.classList.toggle('hidden', !show);
    // The hint and the toasts sit right under the goal line while it is up.
    document.documentElement.style.setProperty('--goal-extra', show ? '34px' : '0px');
    if (!show) {
      this.goalLineText = '';
      return;
    }
    const left = Math.max(0, Math.ceil(goal.limit - this.game.state.time));
    const clock = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
    // A named aim («Взять Бельгию») is already exact: «4 из 4» next to it is a
    // second sentence about the same thing.
    const progress = goal.count === false ? '' : goalProgressText(goal);
    // «Цель: взять ещё 6 провинций» — lower case after the colon.
    const aim = goal.text.charAt(0).toLowerCase() + goal.text.slice(1);
    const html = `${icon('flag', 13)}<span class="goal-aim-line">Цель: ${aim}</span><span class="goal-count">${progress}</span><span class="goal-clock">${icon('clock', 12)}${clock}</span>`;
    if (html === this.goalLineText) return;
    this.goalLineText = html;
    line.innerHTML = html;
    line.classList.toggle('is-close', left <= 60);
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

  /**
   * К6.6: the offer card is a decision, so it starts under the HUD and stops
   * above the order bar and «В поход» instead of running off the bottom edge
   * (three offers at 844×390 ended 41 px below the window). It scrolls inside
   * when the nations are many.
   */
  #fitOfferCard() {
    const card = $('#offer-card');
    if (!card || card.classList.contains('hidden')) return;
    const hud = $('.hud-top')?.getBoundingClientRect();
    // In the lesson the pill owns the slot under the HUD and the offer card
    // starts below it — otherwise the instruction «Вам предлагают пакт…»
    // disappears under the card that asks the question.
    const tutBar = $('#screen-game')?.classList.contains('is-tutorial') ? $('.tut-bar') : null;
    const tut = tutBar && !tutBar.classList.contains('hidden') ? tutBar.getBoundingClientRect() : null;
    const top = Math.round(Math.max(hud?.bottom ?? 0, tut?.bottom ?? 0) + 8);
    card.style.top = `${top}px`;
    const rect = card.getBoundingClientRect();
    let limit = window.innerHeight - 8;
    for (const sel of ['#orders-bar', '#send-ratio']) {
      const el = $(sel);
      if (!el) continue;
      if (Number(getComputedStyle(el).opacity) <= 0.02) continue;
      const box = el.getBoundingClientRect();
      if (box.top <= top) continue;
      if (rect.left < box.right && rect.right > box.left) limit = Math.min(limit, box.top - 8);
    }
    card.style.maxHeight = `${Math.max(120, Math.round(limit - top))}px`;
  }

  #renderOffers() {
    const card = $('#offer-card');
    if (!card) return;
    const game = this.game;
    const offers = game?.state?.offers ?? [];
    if (!game || !offers.length || game.state.status !== 'playing') {
      $('#app')?.classList.remove('has-offer');
      if (this.offerSignature) {
        card.classList.add('hidden');
        card.innerHTML = '';
        this.offerSignature = '';
      }
      return;
    }
    $('#app')?.classList.add('has-offer');
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
    this.#fitOfferCard();
  }

  #updateOrders() {
    if (!this.game) return;
    const game = this.game;
    const state = game.state;
    const paint = (button, kind) => {
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
    };
    for (const button of $('#order-list')?.children ?? []) {
      if (button.dataset.order) paint(button, button.dataset.order);
    }
    const ad = $('#btn-order-ad');
    if (ad) {
      const ready = Boolean(game.canSkipCooldown()) && rewardedAllowed({ matches: Number(this.settings.matches) || 0, adsEnabled: platform.hasRewarded() });
      ad.classList.toggle('hidden', !ready);
      ad.disabled = !ready;
    }

    // The big button follows the game's own advice.
    const main = $('#btn-order');
    if (!main) return;
    const advice = game.suggestOrder();
    this.orderSuggestion = advice;
    if (!advice) {
      main.disabled = true;
      return;
    }
    const order = ORDERS[advice.kind];
    const iconSlot = main.querySelector('[data-main-icon]');
    const iconName = order.icon;
    if (iconSlot.dataset.icon !== iconName) {
      iconSlot.dataset.icon = iconName;
      iconSlot.innerHTML = icon(iconName, 16);
    }
    // A narrow column gets the short name: «Всеобщая мобилизация» is a
    // paragraph on a phone, and a clipped «Военный …» names nothing.
    const compact = window.matchMedia('(max-width: 560px), (max-height: 520px)').matches;
    main.querySelector('[data-main-name]').textContent = compact ? order.shortName ?? order.name : order.name;
    const cost = `${BAL.orderGold[advice.kind]} золота`;
    main.querySelector('[data-main-sub]').textContent = advice.ready
      ? `${advice.reason} · ${cost}`
      : `через ${Math.ceil(advice.cooldown)} с · ${cost}`;
    main.querySelector('[data-main-cost]').textContent = '';
    main.disabled = !advice.ready || state.status !== 'playing';
    main.classList.toggle('is-waiting', !advice.ready);
    paint(main, advice.kind);
  }

  /**
   * On a short landscape screen the onboarding pill sits exactly where the
   * province card opens: hide it while the card is up instead of overlapping.
   */
  #syncHint(panel = $('#province-panel')) {
    const hint = $('#hint-bar');
    const open = Boolean(panel) && !panel.classList.contains('hidden');
    hint?.classList.toggle('muted', open);
    // К6.5: on a 844×390 window a toast in the middle of the screen lay down on
    // top of the province card. The screen knows the card is open, so the pills
    // step aside instead of covering the numbers the player just asked for.
    $('#screen-game')?.classList.toggle('has-panel', open && this.screen === 'game');
    // The toast stack lives outside #screen-game (it is a sibling of every
    // screen), so the flag that moves it has to sit on #app.
    $('#app')?.classList.toggle('has-panel', open && this.screen === 'game');
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
    // К6.1: the seconds bought by «второй шанс» are the one thing worth saying
    // louder than an incoming column — nobody is coming, and that is the point.
    const grace = Math.ceil((s.reviveGrace ?? 0) - s.time);
    if (grace > 0) {
      return { text: `Передышка после второго шанса · ${grace} с`, kind: 'good' };
    }
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
      // The onboarding pill may come back once nothing is happening.
      $('#hint-bar')?.classList.remove('is-replaced');
      return;
    }
    bar.textContent = info.text;
    bar.className = `now-bar ${info.kind}`;
    // A live status wins over the onboarding pill sitting in the same slot. The
    // pill is hidden in the same frame: a 0.2 s fade meant that for a moment the
    // two texts were drawn on top of each other.
    const hint = $('#hint-bar');
    if (hint) {
      hint.classList.add('is-replaced');
      hint.style.opacity = '0';
    }
  }

  /** One-line instruction at the top of the map. */
  #hint(text) {
    const bar = $('#hint-bar');
    if (!bar) return;
    // A manual hint also owns the slot: the live status must not sit on top.
    $('#now-bar')?.classList.add('hidden');
    bar.classList.remove('is-replaced');
    bar.textContent = text;
    // «muted» is the state that hides the pill under the province card, so a
    // hint has to clear it — otherwise the text was written into a hidden bar.
    bar.classList.remove('muted');
    this.#syncHint();
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
    // The same forecast the rows show, kept here so the «В поход» button can
    // name the province the column starts from.
    const odds = isMine ? null : game.bestAttackOdds(province.id);

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
            // Every owned province replenishes from its owner's recruits, not
            // only the player's: «Пополнение нет» on an enemy province was a lie.
            over > 0
              ? `<b class="over-note">сверх нормы +${fmt(over)}</b>`
              : regen > 0
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
                if (!odds) {
                  return '<div class="pp-row"><span>Штурм</span><b class="muted">нет соседней своей провинции</b></div>';
                }
                const chance = Math.round(odds.chance * 100);
                const tone = odds.chance >= 0.85 ? 'good' : odds.chance >= 0.5 ? 'warn' : 'bad';
                const grown = odds.defense > odds.defenseNow * 1.02;
                return `<div class="pp-row"><span>Шанс взять</span><b class="odds ${tone}">${chance}%</b></div>
                  <div class="pp-row"><span>Бой</span><b class="muted">решается сам при прибытии</b></div>
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
        <div class="pp-row"><span>Население</span><b>${this.#popOf(province.id).toFixed(1)} млн</b></div>
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

      ${
        !isMine && odds
          ? `<button type="button" class="btn primary wide pp-attack" data-attack="${odds.from}">
              В поход: ${fmt(odds.troops)} чел.
              <span class="pp-attack-sub">Откуда: «${game.provinceName(odds.from)}» · ${Math.round(
                game.state.sendRatio * 100,
              )}% гарнизона</span>
            </button>`
          : ''
      }
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
          : `Бой решается сам, когда колонна дойдёт: ничего нажимать не нужно. Оборона ${fmt(defense)}: ${fmt(breakdown.effective)} боевых войск × ${breakdown.fortMul.toFixed(2)} крепость × ${breakdown.doctrineMul.toFixed(2)} доктрина × ${breakdown.moraleMul.toFixed(2)} дух. Шанс — для доли ${Math.round(game.state.sendRatio * 100)}% и с учётом пополнения защитника в пути.`
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
        // К3.4: the capital order has no fixed destination — it follows the
        // front, so the card names the rule instead of a province.
        const target = order.roam ? 'на слабого соседа' : game.provinceName(order.to);
        const amount = game.autoAmount(order);
        return `<div class="pp-auto-row">
          <div class="pp-auto-head">
            <b>→ ${target}${order.roam ? '<span class="pp-auto-tag">сама</span>' : ''}</b>
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
            <span class="pp-auto-now">${amount >= 4 ? `уйдёт ${fmt(amount)}` : 'копит людей'}</span>
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
    // The lesson has no ambition chain: «Фокус выполнен» in the first seconds of
    // the game would be a lie.
    if (!game || game.state.tutorial) {
      chip.classList.add('hidden');
      return;
    }
    chip.classList.remove('hidden');
    const pending = game.focusPending();
    const focus = game.focusOf();
    const progress = game.focusProgress();
    const label = $('#hud-focus');
    if (pending) {
      // A fork is waiting: the chip says so in words and invites a click.
      label.textContent = 'Выберите фокус';
      chip.classList.remove('is-done');
      chip.classList.add('is-choice');
      if (!this.focusTipShown) {
        this.focusTipShown = true;
        this.#tip('focus', 'Фокус: выберите, куда идти, — кнопка «Выберите фокус» вверху');
      }
    } else {
      chip.classList.remove('is-choice');
      if (!focus) {
        label.textContent = 'Фокус выполнен';
        chip.classList.add('is-done');
      } else {
        label.textContent = focus.name;
        chip.classList.remove('is-done');
      }
    }
    if (!$('#focus-card').classList.contains('hidden')) this.#renderFocusCard();
    chip.title = pending
      ? 'Фокус: выберите из двух направлений'
      : focus
        ? `Фокус ${progress.step} из ${progress.total}: ${focus.name} — цель: ${game.provinceName(focus.target)}`
        : 'Все исторические задачи выполнены';
  }

  /**
   * К6.6: the focus card is an overlay, so everything that would stand under it
   * (goal line, province card) steps aside on short screens, and the card
   * itself starts under the HUD/goal line and stops above «В поход».
   */
  #setFocusCard(open) {
    const card = $('#focus-card');
    if (!card) return;
    card.classList.toggle('hidden', !open);
    $('#app').classList.toggle('has-focus', open);
    if (!open) return;
    this.#renderFocusCard();
    const hud = $('.hud-top')?.getBoundingClientRect();
    const goalEl = $('#goal-line');
    const goalVisible = goalEl && !goalEl.classList.contains('hidden')
      && Number(getComputedStyle(goalEl).opacity) > 0.02;
    const goal = goalVisible ? goalEl.getBoundingClientRect() : null;
    const top = Math.round(Math.max(hud?.bottom ?? 0, goal?.bottom ?? 0) + 8);
    card.style.top = `${top}px`;
    // The card may be taller than a 390 px window: it takes every pixel down to
    // the bottom edge (the ratio pills step aside while it is open), and only
    // stops above them where they stay on screen.
    const ratioEl = $('#send-ratio');
    const ratioShown = ratioEl && Number(getComputedStyle(ratioEl).opacity) > 0.02
      && getComputedStyle(ratioEl).visibility !== 'hidden';
    const ratio = ratioShown ? ratioEl.getBoundingClientRect() : null;
    let limit = window.innerHeight - 8;
    const rect = card.getBoundingClientRect();
    if (ratio && ratio.top > top && rect.left < ratio.right && rect.right > ratio.left) {
      limit = Math.min(limit, ratio.top - 8);
    }
    // The event log sits in the same right-hand column, at the bottom: on a
    // 600 px tall window the card reached it and the last choice was hidden
    // under the log's own header. The card stops above the log instead.
    const dock = $('#log-dock');
    const dockShown = dock && Number(getComputedStyle(dock).opacity) > 0.02;
    if (dockShown) {
      const box = dock.getBoundingClientRect();
      if (box.height > 0 && box.top > top && rect.left < box.right && rect.right > box.left) {
        limit = Math.min(limit, box.top - 8);
      }
    }
    card.style.maxHeight = `${Math.max(120, Math.round(limit - top))}px`;
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
    if (game.focusPending()) {
      // Two roads, same pay: the choice is where to fight, not what it earns.
      const options = game.focusOptions();
      const cards = options
        .map((step, index) => {
          // Russian would need the genitive of «взять» plus a declined province
          // name; a colon and a dash keep every name in the nominative.
          const holder = game.state.provinces[step.target]?.owner;
          const who = holder ? game.state.nations[holder]?.short : 'независимая';
          return `
          <button type="button" class="fc-option" data-fc-pick="${index === 0 ? 'main' : 'alt'}">
            <span class="fc-opt-name">${step.name}</span>
            <span class="fc-opt-target">Цель: <b>${game.provinceName(step.target)}</b> · сейчас — ${who}</span>
            <span class="fc-opt-reward">+${step.gold} золота · +${step.morale} духа</span>
          </button>`;
        })
        .join('');
      card.innerHTML = `
        <div class="fc-head">
          <span class="fc-eyebrow">Исторический фокус</span>
          <span class="fc-step">${progress.step} из ${progress.total}</span>
        </div>
        <h4>Куда идти дальше</h4>
        <div class="fc-options">${cards}</div>
        <div class="fc-chain">${dots}</div>
        <div class="fc-actions"><button type="button" class="btn ghost" data-fc-close>Позже</button></div>`;
      return;
    }
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
    const holder = target?.owner ? game.state.nations[target.owner]?.short : 'независимая';
    card.innerHTML = `
      <div class="fc-head">
        <span class="fc-eyebrow">Исторический фокус</span>
        <span class="fc-step">${progress.step} из ${progress.total}</span>
      </div>
      <h4>${focus.name}</h4>
      <div class="fc-target">Цель: <b>${game.provinceName(focus.target)}</b> · сейчас — ${holder}.</div>
      <div class="fc-reward"><span>Награда: <b>+${focus.gold} золота</b></span><span><b>+${focus.morale} духа</b></span></div>
      <div class="fc-chain">${dots}</div>
      <div class="fc-actions"><button type="button" class="btn ghost" data-fc-close>Скрыть</button></div>`;
  }

  /**
   * К3.3: one button instead of three. The game names the order that answers
   * the current situation («колонна врага на подходе» → мобилизация), and the
   * press is the confirmation. The three separate orders stay one tap away
   * behind «…» for players who want to choose themselves — they share the
   * cooldowns, so nothing is gained by saving the tap, only control.
   */
  #buildOrders() {
    const bar = $('#orders-bar');
    bar.innerHTML = `
      <div class="order-list hidden" id="order-list"></div>
      <div class="order-row">
        <button type="button" class="order order-main" id="btn-order">
          <span class="o-icon" data-main-icon>${icon('tax', 16)}</span>
          <span class="o-body">
            <span class="o-name" data-main-name>Приказ</span>
            <span class="o-sub" data-main-sub>что нужнее сейчас</span>
          </span>
          <span class="o-cost" data-main-cost></span>
          <span class="o-cd hidden"></span>
        </button>
        <button type="button" class="order-more" id="btn-order-more" title="Все приказы" aria-expanded="false">
          ${icon('menu', 14)}
        </button>
      </div>`;
    const list = $('#order-list');
    for (const order of Object.values(ORDERS)) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'order';
      button.dataset.order = order.id;
      // Полное имя живёт в подсказке: «Всеобщая мобилизация» в плитке 96 px
      // рвалась посередине слова, а «Мобилизация» — это тот же приказ.
      button.title = `${order.name}. ${order.description}`;
      button.innerHTML = `
        <span class="o-icon">${icon(order.icon, 16)}</span>
        <span class="o-name">${order.shortName ?? order.name}</span>
        <span class="o-cost">${BAL.orderGold[order.id]} золота</span>
        <span class="o-cd hidden"></span>`;
      button.addEventListener('click', () => {
        this.#castOrder(order.id);
        this.#toggleOrderList(false);
      });
      list.appendChild(button);
    }
    // К6.2: one rewarded video clears the cooldown. It sits at the end of the
    // list and says what it costs, so the offer is never a surprise; the button
    // is hidden whenever it would do nothing.
    const ad = document.createElement('button');
    ad.type = 'button';
    ad.className = 'order order-ad hidden';
    ad.id = 'btn-order-ad';
    ad.title = 'Снять кулдаун всех приказов за рекламу — один раз за партию';
    ad.innerHTML = `
      <span class="o-icon">${icon('play', 16)}</span>
      <span class="o-name">Ускорить</span>
      <span class="o-cost">реклама</span>`;
    ad.addEventListener('click', () => this.#offerSpeedup());
    list.appendChild(ad);
    $('#btn-order').addEventListener('click', () => this.#castOrder(this.orderSuggestion?.kind ?? 'tax'));
    $('#btn-order-more').addEventListener('click', () => this.#toggleOrderList());
  }

  #toggleOrderList(force = null) {
    const list = $('#order-list');
    const more = $('#btn-order-more');
    if (!list || !more) return;
    const open = force ?? list.classList.contains('hidden');
    list.classList.toggle('hidden', !open);
    more.setAttribute('aria-expanded', String(open));
    more.classList.toggle('is-open', open);
    // К6.6: at 1024×600 the unfolded row is wider than the free lane between the
    // province card and the journal, so both step aside while it is open.
    $('#app').classList.toggle('orders-open', open);
    if (open) sfx.click();
  }

  /** К6.2: the rewarded video behind «ускорить приказы». */
  async #offerSpeedup() {
    const game = this.game;
    const button = $('#btn-order-ad');
    if (!game || !button || button.disabled) return;
    if (!game.canSkipCooldown()) {
      this.#toast('Приказы уже готовы', 'info');
      return;
    }
    button.disabled = true;
    const granted = await platform.showRewarded();
    if (!granted) {
      button.disabled = false;
      this.#toast('Реклама не загрузилась — приказы не тронуты', 'info');
      return;
    }
    const result = game.skipOrderCooldown();
    this.#toggleOrderList(false);
    if (!result.ok) {
      this.#toast(result.reason ?? 'Приказы уже готовы', 'info');
      return;
    }
    sfx.coin();
    this.#updateHud();
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
    this.#tutorialEvent('order');
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

  /**
   * Journal filters. «Мои» and «Дипломатия» are on, «Чужие» is off: a war
   * between two computer empires is scenery, not news. The choice sticks, so a
   * player who wants the whole world keeps it on every match.
   */
  #wireLogFilters() {
    const row = $('#log-filters');
    if (!row) return;
    this.logScopes = new Set(['own', 'diplo']);
    try {
      const saved = localStorage.getItem('crowns.logScopes');
      if (saved) {
        const list = JSON.parse(saved);
        if (Array.isArray(list)) this.logScopes = new Set(list.filter((s) => ['own', 'diplo', 'foreign'].includes(s)));
      }
    } catch {
      /* private mode: keep the defaults */
    }
    const apply = () => {
      for (const button of row.children) {
        button.classList.toggle('is-active', this.logScopes.has(button.dataset.scope));
      }
      this.#renderLog();
    };
    row.addEventListener('click', (event) => {
      const button = event.target.closest('.log-filter');
      if (!button) return;
      const scope = button.dataset.scope;
      if (this.logScopes.has(scope)) {
        // Never leave the journal empty: the last enabled filter stays on.
        if (this.logScopes.size === 1) return;
        this.logScopes.delete(scope);
      } else {
        this.logScopes.add(scope);
      }
      try {
        localStorage.setItem('crowns.logScopes', JSON.stringify([...this.logScopes]));
      } catch {
        /* ignore */
      }
      sfx.click();
      apply();
    });
    apply();
  }

  // ---------------------------------------------------------------- log & toasts

  #addLog(entry) {
    this.logEntries = this.logEntries ?? [];
    this.logEntries.push(entry);
    if (this.logEntries.length > 50) this.logEntries.shift();
    this.#renderLog();
  }

  /** Repaints the last visible lines for the current filter set. */
  #renderLog() {
    const log = $('#log');
    if (!log) return;
    const scopes = this.logScopes ?? new Set(['own', 'diplo']);
    const visible = (this.logEntries ?? []).filter((entry) => scopes.has(entry.scope ?? 'own')).slice(-7);
    log.innerHTML = '';
    // The column is reversed in CSS (it grows upwards), so the newest line has
    // to be the first child to sit at the bottom of the corner.
    for (const entry of visible.slice().reverse()) {
      const line = document.createElement('div');
      line.className = `log-line ${entry.kind ?? 'info'}`;
      const year = document.createElement('span');
      year.className = 't';
      year.textContent = entry.year ?? '';
      const text = document.createElement('span');
      text.className = 'x';
      text.textContent = entry.text;
      line.append(year, text);
      log.appendChild(line);
    }
    // Wrapped «Чужие» lines push the pile past the corner: drop the oldest rows
    // until the top one is whole instead of slicing it in half.
    while (log.childElementCount > 1 && log.scrollHeight > log.clientHeight + 1) {
      log.lastElementChild.remove();
    }
  }

  #toast(text, kind = 'info') {
    // In the lesson the pill is the only narrator: a second floating layer of
    // messages over a map the player is still learning to read is noise.
    if (this.screen === 'game' && this.game?.state.tutorial && !this.game.state.tutorial.done) {
      this.tutorialUI.note(text, kind);
      return;
    }
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
        key: 'autoPause',
        title: 'Автопауза на решениях',
        hint: 'Партия сама остановится, когда к вашей земле идёт колонна, вам предлагают договор или открылась развилка фокуса. Так решение не проскочит мимо.',
        options: onOff('autoPause', 'Включена', 'Выключена'),
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

  /**
   * The same fade for the two lists inside «Обстановка». They scroll inside the
   * dialog, so a row cut by the dialog's edge has no other hint that more is
   * below — the scrollbar is 8 px and invisible on a touch screen.
   */
  #syncScrollFade(el) {
    if (!el) return;
    const sync = () => {
      const more = el.scrollHeight - el.clientHeight - el.scrollTop > 6;
      el.classList.toggle('has-more', more);
    };
    el.__syncFade = sync;
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
      this.#tip('pact', 'Договоры и войны — меню паузы → «Обстановка» → «Переговоры» (клавиша R)');
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

  /** «Обстановка»: «Державы» and «Переговоры» are tabs of one window. */
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
        <span>Держава</span><span>Земли</span><span>Армия</span><span>Дух</span><span><span class="th-long">Усталость</span><span class="th-short">Устал.</span></span><span>Доход</span><span>Рекруты</span>
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
    // The lists are rebuilt on every render, their height is not: sync the fade
    // against the freshly measured content after the browser lays it out.
    requestAnimationFrame(() => {
      this.#syncScrollFade(document.querySelector('#modal-rankings .rank-scroll'));
      this.#syncScrollFade($('#diplo-nations'));
    });
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
    // «Играть» — the one-tap path of К3.5: the current theatre's first scenario
    // with its first nation, straight into the match. The scenario cards stay
    // for anyone who wants to choose; the pause menu keeps the rules.
    $('#btn-play-now').addEventListener('click', () => this.#playNow());
    $('#btn-menu-rules')?.addEventListener('click', () => this.#openRules());
    $('#btn-howto').addEventListener('click', () => {
      sfx.click();
      $('#modal-howto').classList.remove('hidden');
      this.#syncModalScroll('#modal-howto');
    });
    for (const list of document.querySelectorAll('.rank-scroll, #diplo-nations')) {
      list.addEventListener('scroll', () => list.__syncFade?.(), { passive: true });
      new ResizeObserver(() => list.__syncFade?.()).observe(list);
    }
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
      const doctToggle = event.target.closest('[data-doctrine-toggle]');
      if (doctToggle) {
        sfx.click();
        this.doctrineOpen = !this.doctrineOpen;
        this.#renderNationDetail();
        return;
      }
      const mode = event.target.closest('[data-goal-mode]');
      if (mode) {
        sfx.click();
        this.pendingRules = normalizeRules({ ...this.pendingRules, mode: mode.dataset.goalMode });
        this.settings.rules = this.pendingRules;
        this.#saveSettings();
        this.#renderNationDetail();
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
    $('#btn-speed-play').addEventListener('click', () => {
      if (!this.game) return;
      sfx.select();
      this.setSpeed(this.lastSpeed || 1);
    });
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
    this.#wireLogFilters();
    $('#btn-pause-menu').addEventListener('click', () => this.openPause());
    // К3.5: «Державы» left the HUD — the pause menu and R still open the same
    // window, so the button is optional here.
    $('#btn-rankings')?.addEventListener('click', () => this.#openRankings());
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
      const open = $('#focus-card').classList.contains('hidden');
      this.#setFocusCard(open);
      if (open) sfx.click();
    });

    $('#focus-card').addEventListener('click', (event) => {
      if (event.target.closest('[data-fc-close]')) {
        this.#setFocusCard(false);
        return;
      }
      const pick = event.target.closest('[data-fc-pick]');
      if (pick) {
        const result = this.game.chooseFocus(pick.dataset.fcPick);
        if (!result.ok) {
          this.#toast(result.reason, 'bad');
          return;
        }
        sfx.select();
        this.#renderFocusCard();
        this.#updateFocus();
        this.#updateHud();
      }
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
          if (order.roam) {
            // A roaming order has no destination to re-create it with; the
            // numbers live in the same object the simulation reads.
            if (autoStep.dataset.field === 'when') order.when = Math.max(order.keep + 10, order.when + delta);
            else order.keep = Math.max(10, Math.min(order.when - 10, order.keep + delta));
          } else {
            const next = { ...order };
            if (autoStep.dataset.field === 'when') next.when = Math.max(order.keep + 10, order.when + delta);
            else next.keep = Math.max(10, Math.min(order.when - 10, order.keep + delta));
            this.game.addAuto(order.from, order.to, next.when, next.keep);
          }
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
      const attackButton = event.target.closest('[data-attack]');
      if (attackButton && this.game) {
        if (attackButton.disabled) return;
        // The button and a drag land in the same place, so the pact warning,
        // the route planner and the sea toll all behave exactly the same.
        this.#dragDrop(attackButton.dataset.attack, this.selectedProvince);
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
    // К3.2 / К3.4: the two helpers that make a match playable without micro.
    // They are part of the match rules, so the switch works mid-match and the
    // choice is remembered for the next one.
    $('#toggle-autobuild').addEventListener('change', (event) => {
      const on = event.target.checked;
      this.pendingRules = normalizeRules({ ...this.pendingRules, autoBuild: on });
      this.settings.rules = this.pendingRules;
      if (this.game) this.game.setRules({ autoBuild: on });
      this.#saveSettings();
    });
    $('#toggle-autosend').addEventListener('change', (event) => {
      const on = event.target.checked;
      this.pendingRules = normalizeRules({ ...this.pendingRules, autoSend: on });
      this.settings.rules = this.pendingRules;
      if (this.game) {
        this.game.setRules({ autoSend: on });
        if (on) this.game.enableAutoSend();
        else this.game.disableAutoSend();
        if (this.selectedProvince) this.#renderProvincePanel();
      }
      this.#saveSettings();
    });
    $('#toggle-sound').checked = this.settings.sound;
    $('#toggle-labels').checked = this.settings.labels;
    $('#toggle-tips').checked = this.settings.tips !== false;
    const autos = normalizeRules(this.pendingRules);
    $('#toggle-autobuild').checked = autos.autoBuild;
    $('#toggle-autosend').checked = autos.autoSend;
    sfx.setEnabled(this.settings.sound);

    $('#btn-again').addEventListener('click', () => {
      $('#screen-end').classList.add('hidden');
      $('#app')?.classList.remove('has-end');
      this.#restart();
    });
    $('#btn-revive').addEventListener('click', () => this.#offerRevive());
    $('#btn-end-menu').addEventListener('click', () => {
      $('#screen-end').classList.add('hidden');
      $('#app')?.classList.remove('has-end');
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
      // The focus card measures the window it sits in, so a resize has to
      // re-measure it instead of leaving a card from the old size behind.
      if (!$('#focus-card')?.classList.contains('hidden')) this.#setFocusCard(true);
      this.#fitOfferCard();
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
      else if (event.key === '3') this.setSpeed(3);
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
    // Three speeds, not four: at 4× the date flies past the messages the
    // player is supposed to read. 3× is for skipping a quiet stretch.
    const clamped = Math.max(0, Math.min(3, Math.round(Number(speed) || 0)));
    if (clamped > 0) this.lastSpeed = clamped;
    this.game.setSpeed(clamped);
    this.#updateHud();
  }

  /**
   * Stops the clock when something needs an answer. Without this the enemy
   * column reaches the province while the player is still reading the toast,
   * and a treaty offer can expire unseen.
   *
   * `force` is for events the player must answer (offers, a focus fork); a
   * marching column is throttled, otherwise one big war would pause the game
   * every couple of seconds and feel broken.
   */
  #autoPause(reason = null, { force = false, throttle = 20000 } = {}) {
    if (!this.game || this.screen !== 'game') return false;
    if (!this.game.state.rules.autoPause) return false;
    if (this.game.state.speed === 0) return false;
    if (!$('#modal-pause').classList.contains('hidden')) return false;
    const now = performance.now();
    // `?? 0` would swallow the first pause of a match: performance.now() is
    // still a few seconds old at that point, which reads as «paused recently».
    if (!force && this.lastAutoPause != null && now - this.lastAutoPause < throttle) return false;
    this.lastAutoPause = now;
    this.lastAutoPauseReason = reason;
    this.lastSpeed = this.game.state.speed;
    this.game.setSpeed(0);
    this.#updateHud();
    if (reason) this.#toast(`Пауза: ${reason}`, 'warn');
    return true;
  }

  openPause() {
    if (!this.game || this.screen !== 'game') return;
    // The switches show the rules of *this* match, not the saved defaults.
    $('#toggle-autobuild').checked = this.game.state.rules.autoBuild !== false;
    $('#toggle-autosend').checked = this.game.state.rules.autoSend !== false;
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
      // The lesson's target must keep its name even when a bigger neighbour
      // claims the space: «отпустите на Бельгии» over an unlabelled province is
      // the one instruction in the game that cannot be guessed.
      const lessonTarget = this.tutorialPhase === 'drag' ? 'BE' : null;
      this.labels.update(this.world, this.game, this.selectedProvince, this.world.hovered, lessonTarget);
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
    if (this.screen === 'game') this.tutorialUI.frame(now);
    this.world.render();
    requestAnimationFrame(this.loop);
  }
}
