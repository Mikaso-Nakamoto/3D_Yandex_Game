/**
 * Определение класса устройства и адаптивное качество.
 *
 * Яндекс Игры проверяют сборку на всём зоопарке браузеров и ОС (пункт 1.20),
 * а пункт 1.15 запрещает заметные фризы. Поэтому качество определяется на старте,
 * а в рантайме ещё и подстраивается по фактическому FPS.
 */

export const TIER = { LOW: 0, MID: 1, HIGH: 2 };

export function detectTier() {
  const mem = navigator.deviceMemory; // только Chromium, может быть undefined
  const cores = navigator.hardwareConcurrency || 4;
  const coarse = window.matchMedia?.('(hover: none) and (pointer: coarse)').matches;
  const small = Math.min(window.screen?.width || 1280, window.screen?.height || 720) < 500;

  let score = 0;
  if (cores >= 8) score += 2;
  else if (cores >= 4) score += 1;
  if (mem !== undefined) {
    if (mem >= 8) score += 2;
    else if (mem >= 4) score += 1;
  } else {
    score += 1; // нет данных — считаем середняком
  }
  if (coarse) score -= 2;
  if (small) score -= 1;

  if (score <= 0) return TIER.LOW;
  if (score <= 2) return TIER.MID;
  return TIER.HIGH;
}

/**
 * Настройки под уровень устройства.
 *
 * ВАЖНО про fogDensity: это НЕ абсолютная плотность, а плотность при опорной
 * дистанции до камеры REF_FOG_DIST = 35 (см. game.js). CameraRig каждый кадр
 * пересчитывает её как `fogDensity · 35 / фактическая_дистанция`, потому что
 * в three.js туман считается как 1 − exp(−(density · depth)²) и его сила
 * зависит от расстояния. А расстояние у нас плавает от ~35 (альбом) до ~47
 * (портрет) — в портрете камера выше и дальше.
 *
 * Без нормализации одно число не могло быть правильным для всех экранов:
 * на альбоме герой был затянут на 41–61%, а на телефоне в портрете — на
 * 62–82%, то есть основная аудитория Яндекс Игр почти не видела собственного
 * персонажа. Сейчас вклад тумана в изображение героя одинаков на любом разрезе.
 */
export function profileFor(tier) {
  switch (tier) {
    case TIER.LOW:
      return {
        pixelRatio: 1,
        bloom: false,
        shadows: false,
        maxEnemies: 55,
        maxProjectiles: 130,
        particles: 260,
        lights: false,
        fogDensity: 0.0118,
        gridDetail: 0.5,
      };
    case TIER.MID:
      return {
        pixelRatio: Math.min(1.5, window.devicePixelRatio || 1),
        bloom: true,
        bloomStrength: 0.62,
        shadows: false,
        maxEnemies: 85,
        maxProjectiles: 200,
        particles: 480,
        lights: true,
        fogDensity: 0.0105,
        gridDetail: 1,
      };
    default:
      return {
        pixelRatio: Math.min(2, window.devicePixelRatio || 1),
        bloom: true,
        bloomStrength: 0.85,
        shadows: true,
        maxEnemies: 120,
        maxProjectiles: 300,
        particles: 760,
        lights: true,
        fogDensity: 0.0092,
        gridDetail: 1,
      };
  }
}

/**
 * Наблюдатель за FPS: если кадры стабильно проседают — снижаем качество.
 * Обратное повышение не делаем, чтобы не «мигать» настройками.
 */
export class AutoQuality {
  constructor(onDowngrade) {
    this.onDowngrade = onDowngrade;
    this._acc = 0;
    this._frames = 0;
    this._badStreak = 0;
    this.downgraded = false;
  }

  update(dt) {
    if (this.downgraded) return;
    this._acc += dt;
    this._frames++;
    if (this._acc < 1) return;

    const fps = this._frames / this._acc;
    this._acc = 0;
    this._frames = 0;

    if (fps < 34) this._badStreak++;
    else this._badStreak = 0;

    if (this._badStreak >= 3) {
      this.downgraded = true;
      this.onDowngrade?.(fps);
    }
  }
}
