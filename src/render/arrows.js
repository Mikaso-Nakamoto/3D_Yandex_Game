// Screen-space arrows drawn on a 2D canvas above the 3D map.
// Everything is projected from map coordinates, so arrows follow pan and zoom exactly
// and never fight with depth buffers.
const TAU = Math.PI * 2;

function brighten(hex, amount = 0.55) {
  const value = parseInt(hex.replace('#', ''), 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  const mix = (c) => Math.round(c + (255 - c) * amount);
  return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
}

export class ArrowLayer {
  constructor(canvas, world) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.world = world;
    this.armies = [];
    this.nations = {};
    this.preview = null;
    this.time = 0;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.resize();
  }

  resize() {
    const width = this.canvas.clientWidth || window.innerWidth;
    const height = this.canvas.clientHeight || window.innerHeight;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(width * this.dpr);
    this.canvas.height = Math.round(height * this.dpr);
    this.width = width;
    this.height = height;
  }

  /** Marching armies: [{ id, owner, from, to, t, duration, sea }] */
  setArmies(armies, nations) {
    this.armies = armies;
    this.nations = nations;
  }

  /** Drag preview: { from: provinceId, point: [x, z], valid: boolean } | null */
  setPreview(preview) {
    this.preview = preview;
  }

  #project(provinceId) {
    const province = this.world.byId[provinceId];
    if (!province) return null;
    const pos = this.world.projectPoint(province.centroid[0], province.centroid[1], 0.5);
    return pos.visible ? pos : null;
  }

  draw(dt) {
    this.time += dt;
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);

    // Player armies first, so the eye catches them before the many AI moves.
    const ordered = [...this.armies].sort((a, b) => (b.isPlayer ? 1 : 0) - (a.isPlayer ? 1 : 0));
    for (const army of ordered) {
      const from = this.#project(army.from);
      const to = this.#project(army.to);
      if (!from || !to) continue;
      const isPlayer = Boolean(army.isPlayer);
      const owner = this.nations[army.owner];
      const base = owner?.color ?? '#d9b45a';
      const progress = army.duration > 0 ? Math.min(1, army.t / army.duration) : 1;
      this.#drawArrow({
        from,
        to,
        // Your own orders are always gold: instantly separates them from the AI traffic.
        color: isPlayer ? '#ffd479' : brighten(base, 0.55),
        edge: isPlayer ? 'rgba(24, 15, 4, 0.92)' : 'rgba(4, 8, 14, 0.85)',
        width: (army.sea ? 15 : 18) * (isPlayer ? 1.25 : 0.62),
        dashed: true,
        flow: isPlayer ? 1.25 : 0.8,
        alpha: isPlayer ? 1 : 0.42,
        progress,
      });
    }

    if (this.preview?.route?.length > 2) {
      // Planned road: dim gold arrows along every leg so the route reads as a
      // path rather than a single leap over half the continent.
      for (let i = 1; i < this.preview.route.length; i += 1) {
        const a = this.world.projectPoint(this.preview.route[i - 1][0], this.preview.route[i - 1][1], 0.5);
        const b = this.world.projectPoint(this.preview.route[i][0], this.preview.route[i][1], 0.5);
        if (!a.visible || !b.visible) continue;
        this.#drawArrow({
          from: a,
          to: b,
          color: this.preview.valid ? '#ffe6a3' : '#ff8a8a',
          edge: 'rgba(10, 8, 4, 0.9)',
          width: 14,
          dashed: true,
          flow: 1.4,
          alpha: 0.72,
        });
      }
    }

    // Only one preview at a time: either the planned road or a free-hand line.
    if (this.preview && !(this.preview.route?.length > 2)) {
      const from = this.#project(this.preview.from);
      if (from && this.preview.point) {
        const target = this.world.projectPoint(this.preview.point[0], this.preview.point[1], 0.5);
        if (target.visible) {
          this.#drawArrow({
            from,
            to: target,
            color: this.preview.valid ? '#ffe6a3' : '#ff8a8a',
            edge: 'rgba(10, 8, 4, 0.9)',
            width: 20,
            dashed: true,
            flow: 1.7,
            alpha: 0.98,
          });
        }
      }
    }
  }

  #drawArrow({ from, to, color, edge, width, dashed, flow, alpha, progress = null }) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const length = Math.hypot(dx, dy);
    if (length < 26) return;

    const angle = Math.atan2(dy, dx);
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(from.x, from.y);
    ctx.rotate(angle);
    ctx.globalAlpha = alpha;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const startX = width * 0.9;
    // The order arrow is always drawn in full; `progress` only marks how much is covered.
    const endX = length - width * 0.4;
    const headLength = Math.min(width * 2.7, Math.max(width * 1.9, length * 0.2));
    const shaftEnd = Math.max(startX + 8, endX - headLength * 0.75);

    // Dark outline under everything so arrows read on any map colour.
    ctx.strokeStyle = edge;
    ctx.lineWidth = width + 3.5;
    ctx.beginPath();
    ctx.moveTo(startX, 0);
    ctx.lineTo(shaftEnd, 0);
    ctx.stroke();

    // Travelled part is brighter, remaining part is dimmer: reads like a march order.
    ctx.strokeStyle = color;
    ctx.globalAlpha = alpha * (progress === null ? 1 : 0.7);
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(startX, 0);
    ctx.lineTo(shaftEnd, 0);
    ctx.stroke();

    if (progress !== null) {
      const travelled = startX + (shaftEnd - startX) * progress;
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.moveTo(startX, 0);
      ctx.lineTo(travelled, 0);
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(travelled, 0, width * 1.05, 0, TAU);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = edge;
      ctx.lineWidth = Math.max(2, width * 0.22);
      ctx.stroke();
      ctx.globalAlpha = alpha;

      // Dim the head while the army is still on the road.
      ctx.globalAlpha = alpha * (0.7 + 0.3 * progress);
    }

    if (dashed) {
      const step = width * 1.5;
      const offset = (this.time * 90 * flow) % step;
      ctx.save();
      ctx.beginPath();
      ctx.rect(startX, -width, Math.max(0, shaftEnd - startX), width * 2);
      ctx.clip();
      ctx.strokeStyle = edge;
      ctx.globalAlpha = alpha * 0.55;
      ctx.lineWidth = width * 0.42;
      for (let x = shaftEnd - offset; x > startX - step; x -= step) {
        ctx.beginPath();
        ctx.moveTo(x - step * 0.42, -width * 0.62);
        ctx.lineTo(x, 0);
        ctx.lineTo(x - step * 0.42, width * 0.62);
        ctx.stroke();
      }
      ctx.restore();
    }

    // Chevrons over the head trail keep the direction obvious on short hops.
    ctx.globalAlpha = alpha * (progress === null ? 1 : 0.75);

    // Arrow head.
    ctx.globalAlpha = alpha * (progress === null ? 1 : 0.75 + 0.25 * progress);
    const tipX = endX + headLength * 0.25;
    const baseX = tipX - headLength;
    ctx.beginPath();
    ctx.moveTo(tipX, 0);
    ctx.lineTo(baseX, -width * 1.55);
    ctx.lineTo(baseX + headLength * 0.22, 0);
    ctx.lineTo(baseX, width * 1.55);
    ctx.closePath();
    ctx.fillStyle = edge;
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(tipX - 2, 0);
    ctx.lineTo(baseX + 1.5, -width * 1.28);
    ctx.lineTo(baseX + headLength * 0.2, 0);
    ctx.lineTo(baseX + 1.5, width * 1.28);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();

    ctx.restore();
  }
}
