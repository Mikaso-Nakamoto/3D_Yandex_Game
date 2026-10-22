import './style.css';
import { Game } from './game.js';
import { createAdapter } from './platform/adapter.js';

/**
 * Точка входа.
 *
 * Порядок обязателен: сначала инициализируется платформенный адаптер,
 * потом создаётся игра, потом платформе сообщается LoadingAPI.ready().
 * В Яндекс Играх лоадер платформы висит до вызова ready(), поэтому тянуть
 * с ним нельзя — но и вызывать до первой отрисовки тоже (пункт 1.1 требований).
 */

const canvas = document.getElementById('game');
const uiRoot = document.getElementById('ui');
const fxLayer = document.getElementById('fx-layer');
const boot = document.getElementById('boot');

async function main() {
  const adapter = createAdapter();

  try {
    await adapter.init();
  } catch (e) {
    console.warn('[boot] platform init failed, continuing in web mode', e);
  }

  const game = new Game({ canvas, uiRoot, fxLayer, adapter });

  // Адаптер должен уметь глушить звук и геймплей на время рекламы.
  if (adapter.onPauseRequest !== undefined) {
    adapter.onPauseRequest = () => {
      game.audio.stopMusic();
      game.audio.suspend();
    };
    adapter.onResumeRequest = () => game.audio.resume();
  }

  // Отладочный доступ из консоли браузера.
  window.__game = game;

  game.start();
  await game.toMenu();

  // Лоадер платформы (и наш собственный) снимаем после первого кадра.
  adapter.ready();
  boot.classList.add('hide');
  setTimeout(() => boot.remove(), 500);

  /* ---------- Уход со вкладки ----------
     Требуется честная пауза: без неё игрок возвращается в мёртвого персонажа,
     а GameplayAPI получает недостоверные сигналы о длительности сессии. */
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) game.externalPause();
    else game.externalResume();
  });
  window.addEventListener('pagehide', () => game.externalPause());
  window.addEventListener('blur', () => game.externalPause());

  /* ---------- Запрет системных жестов ----------
     Пункт 1.10 требований: никаких системной прокрутки, свайп-обновления
     и зума в игровой области. */
  document.addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener(
    'touchmove',
    (e) => {
      // Разрешаем прокрутку внутри самих экранов-оверлеев (список перков).
      if (e.target.closest?.('.screen')) return;
      e.preventDefault();
    },
    { passive: false },
  );
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  document.addEventListener('dblclick', (e) => e.preventDefault());
}

main().catch((e) => {
  console.error('[boot] fatal', e);
  const b = document.getElementById('boot');
  if (b) {
    b.innerHTML =
      '<div class="boot-inner"><div class="boot-text">Не удалось запустить игру.<br>Обнови страницу.</div></div>';
    b.classList.remove('hide');
  }
});
