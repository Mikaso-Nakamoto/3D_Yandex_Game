/**
 * Веб-адаптер: локальная разработка и публикация на собственных/сторонних
 * площадках без Yandex Games SDK.
 *
 * Прогресс хранится в localStorage. В Яндекс Играх игра работает в iframe
 * на домене платформы, и localStorage там тоже доступен, но требование 1.9
 * обязывает сохранять прогресс в облако через player.setData() — поэтому
 * для Яндекс Игр используется yandex.js, а этот файл остаётся fallback'ом.
 */
const KEY = 'mergearena3d.profile.v1';

export class WebAdapter {
  constructor() {
    this.name = 'web';
    this.lang = 'ru';
    this.isAvailable = true;
  }

  async init() {
    // Ничего инициализировать не нужно — игра готова сразу.
    return true;
  }

  /** LoadingAPI.ready(): платформе сообщаем, что всё загрузилось. */
  ready() {}

  /** GameplayAPI.start(): игровой процесс начался. */
  gameplayStart() {}

  /** GameplayAPI.stop(): пауза, меню, реклама, уход со вкладки. */
  gameplayStop() {}

  /**
   * Rewarded video. В веб-сборке награда выдаётся сразу.
   * @returns {Promise<boolean>} true — награду можно выдавать
   */
  async rewarded() {
    return true;
  }

  /** Interstitial между волнами. В веб-сборке — no-op. */
  async interstitial() {
    return true;
  }

  async loadData(fallback = {}) {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return fallback;
      return { ...fallback, ...JSON.parse(raw) };
    } catch {
      return fallback;
    }
  }

  async saveData(data) {
    try {
      const prev = await this.loadData({});
      localStorage.setItem(KEY, JSON.stringify({ ...prev, ...data }));
    } catch {
      /* приватный режим или переполнение — играем без сохранения */
    }
  }

  async submitScore() {}

  async showLeaderboard() {}
}
