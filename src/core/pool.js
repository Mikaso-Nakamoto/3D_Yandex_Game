/**
 * Пул объектов. В браузерной игре главное — не создавать сборщик мусора
 * каждый кадр: снаряды, враги, частицы и пикапы берутся и возвращаются из пула.
 */
export class Pool {
  /**
   * @param {() => T} factory  — создать объект
   * @param {(obj: T) => void} reset — привести объект в начальное состояние при выдаче
   * @param {number} initial  — сколько объектов создать сразу
   */
  constructor(factory, reset, initial = 0) {
    this.factory = factory;
    this.reset = reset;
    this.free = [];
    this.live = [];
    for (let i = 0; i < initial; i++) this.free.push(factory());
  }

  obtain() {
    const obj = this.free.length ? this.free.pop() : this.factory();
    this.reset(obj);
    this.live.push(obj);
    return obj;
  }

  /**
   * Освободить объект. index — позиция в live (передаётся из итератора,
   * чтобы не искать объект повторно).
   */
  releaseAt(index) {
    const obj = this.live[index];
    const last = this.live.pop();
    if (index < this.live.length) this.live[index] = last;
    this.free.push(obj);
    return last === obj ? null : last;
  }

  releaseAll() {
    while (this.live.length) this.free.push(this.live.pop());
  }

  get count() {
    return this.live.length;
  }
}

/**
 * Пул THREE-мешей с ключом по типу.
 *
 * Геометрии и материалы кэшируются на стороне builder'а, поэтому выдача меша —
 * это только смена parent/visible, без аллокаций. Именно это позволяет держать
 * 100+ врагов и сотни снарядов без просадок FPS на телефоне.
 */
export class KeyedMeshPool {
  /** @param {(key: string) => THREE.Object3D} builder */
  constructor(builder) {
    this.builder = builder;
    this.free = new Map();
  }

  obtain(key) {
    let bucket = this.free.get(key);
    if (bucket && bucket.length) {
      const mesh = bucket.pop();
      mesh.visible = true;
      return mesh;
    }
    const mesh = this.builder(key);
    mesh.visible = true;
    return mesh;
  }

  release(key, mesh) {
    mesh.visible = false;
    if (mesh.parent) mesh.parent.remove(mesh);
    let bucket = this.free.get(key);
    if (!bucket) {
      bucket = [];
      this.free.set(key, bucket);
    }
    bucket.push(mesh);
  }

  releaseAll(onRelease) {
    for (const [key, bucket] of this.free) {
      for (const m of bucket) {
        m.visible = false;
        if (m.parent) m.parent.remove(m);
      }
      bucket.length = 0;
      onRelease?.(key);
    }
  }
}
