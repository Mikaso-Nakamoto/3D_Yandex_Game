/**
 * Математика, случайность и пространственная сетка.
 * Всё игровое поле живёт в плоскости XZ, Y — высота. Коллизии — окружности в XZ,
 * физический движок не нужен: это держит сборку маленькой, а FPS высоким.
 */

export const TAU = Math.PI * 2;

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const rand = (a, b) => a + Math.random() * (b - a);
export const randInt = (a, b) => Math.floor(a + Math.random() * (b - a + 1));
export const pick = (arr) => arr[(Math.random() * arr.length) | 0];

/** Кадронезависимое сглаживание: не «плывёт» при просадках FPS. */
export const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));

export const dist2 = (ax, az, bx, bz) => {
  const dx = ax - bx;
  const dz = az - bz;
  return dx * dx + dz * dz;
};

export const dist = (ax, az, bx, bz) => Math.sqrt(dist2(ax, az, bx, bz));

export function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    const t = arr[i];
    arr[i] = arr[j];
    arr[j] = t;
  }
  return arr;
}

/** Выбор N неповторяющихся элементов. */
export function sample(arr, n) {
  const copy = arr.slice();
  shuffle(copy);
  return copy.slice(0, Math.min(n, copy.length));
}

/** Взвешенный выбор: items — массив, weight(item, index) — вес. */
export function weightedPick(items, weight) {
  let total = 0;
  for (let i = 0; i < items.length; i++) total += weight(items[i], i);
  if (total <= 0) return items[0];
  let r = Math.random() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weight(items[i], i);
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

export const fmt = (n) => Math.floor(n).toLocaleString('ru-RU');

export const fmtTime = (sec) => {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
};

/**
 * Равномерная сетка для broadphase. Пересоздаётся каждый кадр через clear(),
 * ключи — целые числа, чтобы не мусорить строками в GC.
 */
export class SpatialGrid {
  constructor(cellSize = 4) {
    this.cell = cellSize;
    this.buckets = new Map();
  }

  clear() {
    this.buckets.clear();
  }

  _key(cx, cz) {
    // Смещение убирает отрицательные координаты; диапазон арены сильно меньше 4096 ячеек.
    return (cx + 2048) * 4096 + (cz + 2048);
  }

  insert(obj) {
    const cx = Math.floor(obj.x / this.cell);
    const cz = Math.floor(obj.z / this.cell);
    const key = this._key(cx, cz);
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = [];
      this.buckets.set(key, bucket);
    }
    bucket.push(obj);
  }

  /** Все объекты в квадрате вокруг (x, z) радиуса r. Результат пишется в out. */
  query(x, z, r, out) {
    out.length = 0;
    const c = this.cell;
    const minCx = Math.floor((x - r) / c);
    const maxCx = Math.floor((x + r) / c);
    const minCz = Math.floor((z - r) / c);
    const maxCz = Math.floor((z + r) / c);
    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cz = minCz; cz <= maxCz; cz++) {
        const bucket = this.buckets.get(this._key(cx, cz));
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i++) out.push(bucket[i]);
      }
    }
    return out;
  }
}
