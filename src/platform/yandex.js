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
