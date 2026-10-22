/**
 * Адаптер Yandex Games SDK v2.
 *
 * Закрывает обязательные пункты требований платформы:
 *   1.1  — SDK встроен, YaGames.init() вызван, LoadingAPI.ready() сообщён;
 *   1.9  — прогресс сохраняется в облако (player.setData/getData);
 *   1.12 — монетизация: fullscreen + rewarded блоки вызываются из кода;
 *   1.6  — авторизация только по явному клику, игра доступна и гостю;
 *   GameplayAPI.start()/stop() — честная пауза на время рекламы и меню.
 *
 * В прототипе этот адаптер не активируется: SDK грузится только на домене
 * платформы или по явному ?platform=yandex. Это позволяет разрабатывать
 * локально без заглушек и не ломать модерационные требования в релизе.
 */

const SDK_PATH_PLATFORM = '/sdk.js'; // требование: относительный путь в архиве
const SDK_PATH_STANDALONE = 'https://yandex.ru/games/sdk/v2'; // только для отладки со своего домена

function loadScript(src, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    const timer = setTimeout(() => reject(new Error(`SDK load timeout: ${src}`)), timeout);
    s.onload = () => {
      clearTimeout(timer);
      resolve();
    };
    s.onerror = () => {
      clearTimeout(timer);
      reject(new Error(`SDK load error: ${src}`));
    };
    document.head.appendChild(s);
  });
}

/**
 * Находимся ли мы на домене Яндекс Игр.
 *
 * Проверка нужна до загрузки SDK: в момент выбора адаптера window.YaGames
 * ещё не существует, поэтому полагаться только на него нельзя — иначе игра,
 * опубликованная на платформе, по ошибке уйдёт в веб-режим без монетизации
 * и облачных сохранений, а это гарантированный отказ модерации (пункт 1.1).
 */
export function isOnYandexHost() {
  const h = location.hostname;
  return (
    h === 'games.yandex.ru' ||
    /(^|\.)yandex\.(ru|com|by|kz|uz|com\.tr|com\.am|ge|md|tj|tm|az)$/.test(h) ||
    /(^|\.)yandexgames\.(com|ru)$/.test(h) ||
    /(^|\.)playhop\.com$/.test(h)
  );
}

export class YandexAdapter {
  constructor() {
    this.name = 'yandex';
    this.sdk = null;
    this.player = null;
    this.leaderboards = null;
    this.lang = 'ru';
    this.isAvailable = false;
    this._gameplayStarted = false;
    this._adBusy = false;
    this.onPauseRequest = null; // game.js подписывается, чтобы глушить звук на рекламе
    this.onResumeRequest = null;
  }

  async init() {
    try {
      if (!window.YaGames) {
        await loadScript(isOnYandexHost() ? SDK_PATH_PLATFORM : SDK_PATH_STANDALONE);
      }
      if (!window.YaGames) throw new Error('YaGames unavailable');

      this.sdk = await window.YaGames.init();
      this.isAvailable = true;

      const env = this.sdk.getEnvironment?.();
      this.lang = env?.i18n?.lang || 'ru';

      // Профиль — только «мягкий», без scopes: игра обязана работать у гостя.
      try {
        this.player = await this.sdk.getPlayer({ scopes: false });
      } catch {
        this.player = null;
      }

      try {
        this.leaderboards = await this.sdk.getLeaderboards();
      } catch {
        this.leaderboards = null;
      }

      // Выход из игры: прощаемся корректно.
      this.sdk.events?.on?.('EXIT', () => this.gameplayStop());

      return true;
    } catch (e) {
      console.warn('[yandex] SDK init failed, falling back to web mode:', e);
      this.isAvailable = false;
      return false;
    }
  }

  /** Сообщаем платформе, что игра загрузилась и можно убирать лоадер. */
  ready() {
    try {
      this.sdk?.features?.LoadingAPI?.ready();
    } catch (e) {
      console.warn('[yandex] LoadingAPI.ready failed', e);
    }
  }

  gameplayStart() {
    if (!this.sdk || this._gameplayStarted || this._adBusy) return;
    try {
      this.sdk.features?.GameplayAPI?.start();
      this._gameplayStarted = true;
    } catch (e) {
      console.warn('[yandex] GameplayAPI.start failed', e);
    }
  }

  gameplayStop() {
    if (!this.sdk || !this._gameplayStarted) return;
    try {
      this.sdk.features?.GameplayAPI?.stop();
      this._gameplayStarted = false;
    } catch (e) {
      console.warn('[yandex] GameplayAPI.stop failed', e);
    }
  }

  /**
   * Обёртка показа рекламы: обязательно гасим GameplayAPI и звук,
   * иначе модерация возвращает игру (частая причина отказов).
   */
  _withAd(show) {
    return new Promise((resolve) => {
      if (!this.sdk || this._adBusy) {
        resolve(false);
        return;
      }
      this._adBusy = true;
      const wasPlaying = this._gameplayStarted;
      this.gameplayStop();
      this.onPauseRequest?.();

      let settled = false;
      const finish = (rewarded) => {
        if (settled) return;
        settled = true;
        this._adBusy = false;
        this.onResumeRequest?.();
        if (wasPlaying) this.gameplayStart();
        resolve(rewarded);
      };

      // Страховка: если колбэки платформы не сработали, не вешаем игру.
      const guard = setTimeout(() => finish(false), 45000);

      show({
        callbacks: {
          onOpen: () => {},
          onOpened: () => {},
          onClose: () => {
            clearTimeout(guard);
            finish(this._rewardSeen);
          },
          onClosed: () => {
            clearTimeout(guard);
            finish(this._rewardSeen);
          },
          onRewarded: () => {
            this._rewardSeen = true;
          },
          onError: (e) => {
            console.warn('[yandex] ad error', e);
            clearTimeout(guard);
            finish(false);
          },
        },
      });
    });
  }

  /** Rewarded video: true, если игрок досмотрел и награду можно выдать. */
  async rewarded() {
    if (!this.sdk) return true;
    this._rewardSeen = false;
    return this._withAd((opts) => this.sdk.adv.showRewardedVideo(opts));
  }

  /**
   * Полноэкранная реклама. Вызывать ТОЛЬКО в естественных паузах
   * (между волнами), никогда не во время геймплея.
   */
  async interstitial() {
    if (!this.sdk) return true;
    return this._withAd((opts) => this.sdk.adv.showFullscreenAdv(opts));
  }

  async loadData(fallback = {}) {
    if (!this.player) {
      // Гость: читаем из localStorage, прогресс всё равно не должен теряться.
      return this._localLoad(fallback);
    }
    try {
      const data = await this.player.getData(['best', 'lastRun', 'settings']);
      return { ...fallback, ...data };
    } catch (e) {
      console.warn('[yandex] getData failed', e);
      return this._localLoad(fallback);
    }
  }

  async saveData(data) {
    await this._localSave(data);
    if (!this.player) return;
    try {
      // Лимит setData — 200 КБ и 100 обращений в 5 минут; наш профиль крошечный.
      await this.player.setData(data);
    } catch (e) {
      console.warn('[yandex] setData failed', e);
    }
  }

  /**
   * Авторизация — только по явному клику игрока (пункт 1.6:
   * нельзя требовать вход для запуска игры).
   */
  async auth() {
    if (!this.sdk) return false;
    try {
      this.player = await this.sdk.auth.openAuthDialog();
      return !!this.player;
    } catch {
      return false;
    }
  }

  async submitScore(board = 'main', score) {
    if (!this.leaderboards || !this.player?.getUniqueID()) return;
    try {
      await this.leaderboards.setLeaderboardScore(board, Math.floor(score));
    } catch (e) {
      console.warn('[yandex] setLeaderboardScore failed', e);
    }
  }

  async showLeaderboard(board = 'main') {
    if (!this.leaderboards) return null;
    try {
      return await this.leaderboards.getLeaderboardEntries(board, {
        quantityTop: 10,
        includeUser: true,
        quantityAround: 3,
      });
    } catch (e) {
      console.warn('[yandex] getLeaderboardEntries failed', e);
      return null;
    }
  }

  /* ---------- localStorage fallback для гостей ---------- */

  _localLoad(fallback) {
    try {
      const raw = localStorage.getItem('mergearena3d.profile.v1');
      return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
    } catch {
      return fallback;
    }
  }

  _localSave(data) {
    try {
      const prev = this._localLoad({});
      localStorage.setItem('mergearena3d.profile.v1', JSON.stringify({ ...prev, ...data }));
    } catch {
      /* приватный режим — играем без локального сохранения */
    }
  }
}
