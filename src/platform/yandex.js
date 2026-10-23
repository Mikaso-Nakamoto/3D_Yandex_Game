// Thin wrapper around the Yandex Games SDK. Everything is optional:
// the game must run identically in a plain browser (local preview, itch, etc.).
const SDK_URL = 'https://yandex.ru/games/sdk/v2';

let sdkPromise = null;

function loadScript(src) {
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.onload = resolve;
    script.onerror = () => reject(new Error('sdk load failed'));
    document.head.appendChild(script);
  });
  return sdkPromise;
}

function isYandexHost() {
  const h = location.hostname;
  return (
    /(^|\.)yandex\.(ru|com|net|by|kz)$/.test(h) ||
    /(^|\.)games\.s3\.yandex\.net$/.test(h) ||
    new URLSearchParams(location.search).has('ysdk')
  );
}

export const platform = {
  ysdk: null,
  player: null,
  ready: false,
  isYandex: false,

  async init() {
    this.isYandex = isYandexHost();
    if (!this.isYandex) return false;
    try {
      await loadScript(SDK_URL);
      if (!window.YaGames) return false;
      this.ysdk = await window.YaGames.init();
      this.ready = true;
      try {
        this.player = await this.ysdk.getPlayer({ scopes: false });
      } catch (error) {
        console.info('[yandex] player data недоступны', error?.message);
      }
      this.ysdk.features?.LoadingAPI?.ready?.();
      return true;
    } catch (error) {
      console.info('[yandex] SDK не подключён:', error?.message);
      return false;
    }
  },

  gameplayStart() {
    try {
      this.ysdk?.features?.GameplayAPI?.start();
    } catch {
      /* ignore */
    }
  },

  gameplayStop() {
    try {
      this.ysdk?.features?.GameplayAPI?.stop();
    } catch {
      /* ignore */
    }
  },

  /** Resolves true if a fullscreen ad was actually shown. */
  showInterstitial() {
    if (!this.ysdk?.adv?.showFullscreenAdv) return Promise.resolve(false);
    return new Promise((resolve) => {
      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      try {
        this.ysdk.adv.showFullscreenAdv({
          callbacks: {
            onClose: (wasShown) => done(Boolean(wasShown)),
            onError: () => done(false),
          },
        });
      } catch {
        done(false);
      }
      setTimeout(() => done(false), 12000);
    });
  },

  /** Best-effort leaderboard submit; silently no-ops outside Yandex Games. */
  async submitScore(leaderboard, score) {
    if (!this.ysdk?.leaderboards?.setLeaderboardScore) return false;
    try {
      await this.ysdk.leaderboards.setLeaderboardScore(leaderboard, Math.round(score), '');
      return true;
    } catch (error) {
      console.info('[yandex] leaderboard rejected:', error?.message);
      return false;
    }
  },

  /** Top entries of a leaderboard, or an empty list when unavailable. */
  async topScores(leaderboard, quantity = 5) {
    if (!this.ysdk?.leaderboards?.getLeaderboardEntries) return [];
    try {
      const result = await this.ysdk.leaderboards.getLeaderboardEntries(leaderboard, {
        quantityTop: quantity,
        includeUser: true,
        quantityAround: 2,
      });
      return (result?.entries ?? []).map((entry) => ({
        rank: entry.rank,
        score: entry.score,
        name: entry.player?.publicName || 'Игрок',
        self: Boolean(entry.player?.scopePermission === undefined && false),
      }));
    } catch (error) {
      console.info('[yandex] leaderboard read failed:', error?.message);
      return [];
    }
  },

  async save(data) {
    try {
      await this.player?.setData(data, false);
    } catch {
      /* ignore */
    }
  },

  async load() {
    try {
      return await this.player?.getData();
    } catch {
      return null;
    }
  },
};
