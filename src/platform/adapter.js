import { WebAdapter } from './web.js';
import { YandexAdapter, isOnYandexHost } from './yandex.js';

/**
 * Выбор платформенного адаптера.
 *
 * Один и тот же билд работает:
 *   - локально в браузере (WebAdapter, localStorage);
 *   - в Яндекс Играх (YandexAdapter — включается сам, если найден YaGames);
 *   - принудительно через ?platform=yandex для отладки интеграции.
 *
 * Такой слой-адаптер — это то, что позволяет потом почти бесплатно
 * опубликовать ту же сборку на Playhop и других площадках: добавляется
 * ещё один файл-реализация, игровой код не меняется.
 */
export function createAdapter() {
  const params = new URLSearchParams(location.search);
  const forced = params.get('platform');

  if (forced === 'web') return new WebAdapter();

  if (forced === 'yandex' || typeof window.YaGames !== 'undefined' || isOnYandexHost()) {
    return new YandexAdapter();
  }

  return new WebAdapter();
}

export { WebAdapter, YandexAdapter };
