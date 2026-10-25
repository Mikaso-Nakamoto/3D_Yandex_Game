// HTML labels projected over the WebGL map. Crisp text at any zoom, no font assets.
// Labels are decluttered greedily: important provinces keep their label, crowded
// neighbours are hidden until the player zooms in.
const LABEL_HEIGHT = 30;

export class LabelLayer {
  constructor(container, map) {
    this.container = container;
    this.map = map;
    this.items = new Map();
    for (const province of map.provinces) {
      const el = document.createElement('div');
      el.className = 'province-label';
      el.innerHTML =
        '<span class="pl-name"></span>' +
        '<span class="pl-troops"><span class="pl-troops-value"></span><span class="pl-over"></span></span>';
      el.style.display = 'none';
      container.appendChild(el);
      this.items.set(province.id, {
        el,
        name: el.querySelector('.pl-name'),
        troops: el.querySelector('.pl-troops'),
        troopsValue: el.querySelector('.pl-troops-value'),
        over: el.querySelector('.pl-over'),
        area: province.area ?? 0,
        lastTroops: null,
        lastOver: null,
        lastOwner: null,
        lastText: null,
        visible: false,
      });
    }
    this.visible = true;
    this.placed = [];
  }

  /** Rebuilds labels for another theatre. */
  setMap(map) {
    this.container.innerHTML = '';
    this.map = map;
    this.items.clear();
    for (const province of map.provinces) {
      const el = document.createElement('div');
      el.className = 'province-label';
      el.innerHTML =
        '<span class="pl-name"></span>' +
        '<span class="pl-troops"><span class="pl-troops-value"></span><span class="pl-over"></span></span>';
      el.style.display = 'none';
      this.container.appendChild(el);
      this.items.set(province.id, {
        el,
        name: el.querySelector('.pl-name'),
        troops: el.querySelector('.pl-troops'),
        troopsValue: el.querySelector('.pl-troops-value'),
        over: el.querySelector('.pl-over'),
        area: province.area ?? 0,
        lastTroops: null,
        lastOver: null,
        lastOwner: null,
        lastText: null,
        visible: false,
      });
    }
    this.visible = true;
  }

  setVisible(visible) {
    this.visible = visible;
    if (!visible) {
      for (const item of this.items.values()) {
        item.el.style.display = 'none';
        item.visible = false;
      }
    }
  }

  update(world, game, selectedId, hoveredId = null, focusId = null) {
    if (!this.visible || !game) return;

    const candidates = [];
    for (const [id, item] of this.items) {
      const pos = world.projectProvince(id);
      if (!pos.visible) {
        this.#setVisible(item, false);
        continue;
      }
      const province = game.state.provinces[id];
      if (!province) continue;
      const important =
        id === focusId
          ? 4
          : id === selectedId || id === hoveredId
            ? 3
            : province.owner === game.state.nationId
              ? 2
              : province.owner
                ? 1
                : 0;
      candidates.push({ id, item, pos, important, area: item.area });
    }

    // Bigger, more important provinces claim space first.
    candidates.sort((a, b) => b.important - a.important || b.area - a.area);

    this.placed.length = 0;
    for (const candidate of candidates) {
      const { item, pos, id } = candidate;
      const province = game.state.provinces[id];
      const scale = Math.min(1.15, Math.max(0.82, world.zoom * 0.92));
      const nameWidth = item.name.textContent.length * 5.9 * scale + 24;
      const width = Math.max(nameWidth, 34) + (item.lastOver ? 14 : 0);
      const rect = {
        x1: pos.x - width / 2,
        x2: pos.x + width / 2,
        y1: pos.y - LABEL_HEIGHT * scale,
        y2: pos.y + 4,
      };
      const collides = this.placed.some(
        (other) => rect.x1 < other.x2 && rect.x2 > other.x1 && rect.y1 < other.y2 && rect.y2 > other.y1,
      );
      if (collides) {
        this.#setVisible(item, false);
        continue;
      }
      this.placed.push(rect);
      this.#setVisible(item, true);

      item.el.style.transform = `translate(-50%, -50%) translate(${pos.x}px, ${pos.y}px) scale(${scale.toFixed(2)})`;

      const owner = province.owner ? game.state.nations[province.owner] : null;
      if (item.lastOwner !== province.owner) {
        item.lastOwner = province.owner;
        item.troops.style.color = owner ? '#0c1119' : '#f8f2e2';
        item.troops.style.background = owner ? owner.color : 'rgba(6,11,19,0.72)';
        item.troops.style.borderColor = owner ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.14)';
      }

      const troops = Math.round(province.garrison);
      if (item.lastTroops !== troops) {
        item.lastTroops = troops;
        item.troopsValue.textContent = troops;
      }

      // Troops above the province norm: a small golden "+N" in the top-right
      // corner of the number badge.
      const over = Math.max(0, troops - game.maxGarrison(id));
      const overLabel = over >= 1 ? `+${over}` : '';
      if (item.lastOver !== overLabel) {
        item.lastOver = overLabel;
        item.over.textContent = overLabel;
        item.over.style.display = overLabel ? 'block' : 'none';
        item.over.title = overLabel ? `${over} чел. сверх нормы гарнизона` : '';
        item.el.classList.toggle('is-over', Boolean(overLabel));
      }
      const name = game.provinceName(id);
      if (item.lastText !== name) {
        item.lastText = name;
        item.name.textContent = name;
      }
      item.el.classList.toggle('is-small', item.area < 1.6);
      item.el.classList.toggle('is-selected', id === selectedId);
      item.name.style.opacity = id === selectedId || id === hoveredId ? '1' : '';
    }
  }

  #setVisible(item, visible) {
    if (item.visible === visible) return;
    item.visible = visible;
    item.el.style.display = visible ? 'flex' : 'none';
  }
}
