import * as THREE from 'three';

const DEPTH = 0.34;
const PITCH = THREE.MathUtils.degToRad(58);
const MIN_ZOOM = 0.75;
const MAX_ZOOM = 3.2;

const GLOW = {
  none: { color: 0x000000, intensity: 0 },
  hover: { color: 0xffffff, intensity: 0.1 },
  valid: { color: 0x74b06e, intensity: 0.24 },
  target: { color: 0xf0d38a, intensity: 0.34 },
  invalid: { color: 0xc25555, intensity: 0.32 },
  // The selected nation on the menu must be obvious at a glance: it used to
  // be a 13 % golden tint that vanished under the hover highlight.
  accent: { color: 0xf3c85a, intensity: 0.42 },
  accentHover: { color: 0xffd98a, intensity: 0.56 },
};

export class World {
  constructor(canvas, map, callbacks = {}) {
    this.canvas = canvas;
    this.map = map;
    this.callbacks = callbacks;
    this.byId = Object.fromEntries(map.provinces.map((p) => [p.id, p]));

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(36, 1, 0.5, 500);
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();

    this.meshes = [];
    this.groups = new Map();
    this.materials = new Map();
    this.ownerColors = new Map();
    this.flash = new Map();

    this.hovered = null;
    this.dragFrom = null;
    this.dragHover = null;
    this.validTargets = new Set();
    this.accent = new Set();
    this.accentLines = [];
    this.selected = null;
    this.selectionLine = null;

    this.pointers = new Map();
    this.pinch = null;
    this.panning = null;
    this.pendingClick = null;

    this.target = new THREE.Vector3(0, 0, 0);
    this.panTarget = new THREE.Vector3(0, 0, 0);
    this.zoom = 1;
    this.zoomTarget = 1;
    this.baseDist = 60;
    this.autoPan = true;
    this.time = 0;
    this.enabled = true;

    this.#buildLights();
    this.#buildWater();
    this.#buildProvinces();
    this.#buildBorders();
    this.#buildDragLine();
    this.#bindEvents();
    this.resize();
  }

  setCallbacks(callbacks) {
    this.callbacks = callbacks;
  }

  /** Swaps the whole theatre under the same renderer and canvas. */
  setMap(map) {
    if (!map || map === this.map) return;
    this.scene.traverse((object) => {
      if (object.geometry) object.geometry.dispose();
      const materials = Array.isArray(object.material)
        ? object.material
        : object.material
          ? [object.material]
          : [];
      for (const material of materials) material.dispose();
    });
    this.scene.clear();
    this.map = map;
    this.byId = Object.fromEntries(map.provinces.map((p) => [p.id, p]));
    this.meshes = [];
    this.groups.clear();
    this.materials.clear();
    this.ownerColors.clear();
    this.flash.clear();
    this.hovered = null;
    this.dragFrom = null;
    this.dragHover = null;
    this.validTargets = new Set();
    this.accent = new Set();
    this.accentLines = [];
    this.selected = null;
    this.selectionLine = null;
    this.zoom = 1;
    this.zoomTarget = 1;
    this.target.set(0, 0, 0);
    this.panTarget.set(0, 0, 0);
    this.#buildLights();
    this.#buildWater();
    this.#buildProvinces();
    this.#buildBorders();
    this.resize();
    this.resetView();
  }

  // ---------------------------------------------------------------- build

  #buildLights() {
    this.scene.add(new THREE.HemisphereLight(0xdfeaff, 0x0a1420, 0.95));
    const key = new THREE.DirectionalLight(0xfff0cf, 1.5);
    key.position.set(-26, 48, 22);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x6f9cd0, 0.55);
    rim.position.set(34, 26, -30);
    this.scene.add(rim);
  }

  #buildWater() {
    const geo = new THREE.PlaneGeometry(420, 420);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x0a1826,
      roughness: 0.62,
      metalness: 0.25,
    });
    const water = new THREE.Mesh(geo, mat);
    water.rotation.x = -Math.PI / 2;
    water.position.y = -0.62;
    this.scene.add(water);

    // Faint rings give the sea some depth without textures.
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x16324a,
      transparent: true,
      opacity: 0.35,
      side: THREE.DoubleSide,
    });
    for (let i = 1; i <= 3; i += 1) {
      const ring = new THREE.Mesh(new THREE.RingGeometry(i * 26, i * 26 + 0.08, 96), ringMat);
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = -0.6;
      this.scene.add(ring);
    }
  }

  #extrudeRing(ring) {
    const shape = new THREE.Shape();
    ring.forEach(([x, z], i) => {
      if (i === 0) shape.moveTo(x, z);
      else shape.lineTo(x, z);
    });
    shape.closePath();
    const geo = new THREE.ExtrudeGeometry(shape, {
      depth: DEPTH,
      bevelEnabled: false,
      curveSegments: 1,
      steps: 1,
    });
    geo.rotateX(Math.PI / 2);
    geo.computeVertexNormals();
    return geo;
  }

  #buildProvinces() {
    for (const province of this.map.provinces) {
      const top = new THREE.MeshStandardMaterial({
        color: 0x6f7a86,
        roughness: 0.94,
        metalness: 0.03,
        flatShading: true,
      });
      const side = new THREE.MeshStandardMaterial({
        color: 0x2c3540,
        roughness: 0.98,
        metalness: 0.02,
      });
      this.materials.set(province.id, { top, side });

      const group = new THREE.Group();
      const rings = [province.rings[0], ...(province.islands ?? [])];
      for (const ring of rings) {
        if (!ring || ring.length < 3) continue;
        const mesh = new THREE.Mesh(this.#extrudeRing(ring), [top, side]);
        mesh.userData.provinceId = province.id;
        group.add(mesh);
        this.meshes.push(mesh);
      }
      this.groups.set(province.id, group);
      this.scene.add(group);
    }
  }

  #buildBorders() {
    const positions = [];
    for (const province of this.map.provinces) {
      for (const ring of [province.rings[0], ...(province.islands ?? [])]) {
        if (!ring) continue;
        for (let i = 0; i < ring.length; i += 1) {
          const a = ring[i];
          const b = ring[(i + 1) % ring.length];
          positions.push(a[0], 0.012, a[1], b[0], 0.012, b[1]);
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    const mat = new THREE.LineBasicMaterial({
      color: 0x0a1119,
      transparent: true,
      opacity: 0.62,
    });
    this.scene.add(new THREE.LineSegments(geo, mat));
  }

  #buildDragLine() {
    // Arrows live in the 2D overlay (src/render/arrows.js); nothing 3D to build here.
    this.previewArrowData = null;
  }

  showPreviewArrow(fromId, point, valid = true, route = null) {
    this.previewArrowData = { from: fromId, point, valid, route };
    this.callbacks.onArrowPreview?.(this.previewArrowData);
  }

  hidePreviewArrow() {
    this.previewArrowData = null;
    this.callbacks.onArrowPreview?.(null);
  }

  clearMarchArrows() {
    // Kept for API symmetry: march arrows are driven by the ArrowLayer.
  }

  // ---------------------------------------------------------------- colors

  setOwnership(colorByProvince) {
    for (const [id, color] of Object.entries(colorByProvince)) {
      const mats = this.materials.get(id);
      if (!mats) continue;
      if (this.ownerColors.get(id) === color) continue;
      this.ownerColors.set(id, color);
      mats.top.color.set(color);
      const sideColor = new THREE.Color(color).multiplyScalar(0.46);
      mats.side.color.copy(sideColor);
    }
  }

  setSelected(id) {
    this.selected = id;
    if (this.selectionLine) {
      this.scene.remove(this.selectionLine);
      this.selectionLine.geometry.dispose();
      this.selectionLine.material.dispose();
      this.selectionLine = null;
    }
    if (!id) return;
    const province = this.byId[id];
    if (!province) return;
    const ring = province.rings[0];
    const points = ring.map(([x, z]) => new THREE.Vector3(x, 0.02, z));
    const geo = new THREE.BufferGeometry().setFromPoints(points);
    const mat = new THREE.LineBasicMaterial({
      color: 0xf3d68c,
      transparent: true,
      opacity: 0.95,
      depthTest: false,
    });
    this.selectionLine = new THREE.LineLoop(geo, mat);
    this.selectionLine.renderOrder = 9;
    this.scene.add(this.selectionLine);
  }

  setValidTargets(ids = []) {
    this.validTargets = new Set(ids);
    this.#refreshGlow();
  }

  setAccent(ids = []) {
    this.accent = new Set(ids);
    this.#refreshGlow();
    this.#refreshAccentLines();
  }

  /**
   * A golden ring around the whole nation, not just a tint: on a big map a
   * subtle tint is invisible, and «which country did I pick» must never be a
   * question the player has to ask twice.
   */
  #refreshAccentLines() {
    if (this.accentLines) {
      for (const line of this.accentLines) {
        this.scene.remove(line);
        line.geometry.dispose();
        line.material.dispose();
      }
    }
    this.accentLines = [];
    for (const id of this.accent) {
      const province = this.byId[id];
      if (!province) continue;
      // Only the outer ring: islands would otherwise draw a lot of extra lines.
      const ring = province.rings[0];
      const geo = new THREE.BufferGeometry().setFromPoints(ring.map(([x, z]) => new THREE.Vector3(x, 0.03, z)));
      const mat = new THREE.LineBasicMaterial({ color: 0xffd98a, transparent: true, opacity: 0.9, depthTest: false });
      const line = new THREE.LineLoop(geo, mat);
      line.renderOrder = 8;
      this.scene.add(line);
      this.accentLines.push(line);
    }
  }

  flashProvince(id, strength = 1) {
    this.flash.set(id, strength);
  }

  #refreshGlow() {
    for (const [id, mats] of this.materials) {
      let state = 'none';
      if (this.dragFrom) {
        if (id === this.dragHover) state = this.validTargets.has(id) ? 'target' : 'invalid';
        else if (this.validTargets.has(id)) state = 'valid';
      } else if (this.accent.has(id)) {
        // An accented province stays golden while hovered: it used to turn
        // white under the cursor, which read as «the highlight disappeared».
        state = this.hovered === id ? 'accentHover' : 'accent';
      } else if (id === this.hovered) {
        state = 'hover';
      }
      const glow = GLOW[state];
      const flash = this.flash.get(id) ?? 0;
      mats.top.emissive.setHex(glow.color);
      mats.top.emissiveIntensity = glow.intensity + flash * 0.55;
      if (state === 'none' && flash <= 0) mats.top.emissive.setHex(0x000000);
    }
  }

  // ---------------------------------------------------------------- camera

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();

    const vFov = THREE.MathUtils.degToRad(this.camera.fov);
    const projectedDepth = this.map.height * Math.sin(PITCH) + DEPTH + 3.5;
    const needV = projectedDepth * 1.12;
    const needH = this.map.width * 1.1;
    const distV = needV / (2 * Math.tan(vFov / 2));
    const distH = needH / (2 * Math.tan(vFov / 2) * this.camera.aspect);
    this.baseDist = Math.max(distV, distH);
  }

  setAutoPan(on) {
    this.autoPan = on;
  }

  zoomBy(factor) {
    this.zoomTarget = THREE.MathUtils.clamp(this.zoomTarget * factor, MIN_ZOOM, MAX_ZOOM);
  }

  panBy(dx, dz) {
    this.autoPan = false;
    this.panTarget.x += dx;
    this.panTarget.z += dz;
    this.#clampPan();
  }

  #clampPan() {
    const limX = (this.map.width / 2) * 0.62 * Math.max(1, this.zoom);
    const limZ = (this.map.height / 2) * 0.62 * Math.max(1, this.zoom);
    this.panTarget.x = THREE.MathUtils.clamp(this.panTarget.x, -limX, limX);
    this.panTarget.z = THREE.MathUtils.clamp(this.panTarget.z, -limZ, limZ);
  }

  focusOn(provinceId) {
    const province = this.byId[provinceId];
    if (!province) return;
    this.autoPan = false;
    this.panTarget.x = province.centroid[0];
    this.panTarget.z = province.centroid[1];
    this.zoomTarget = Math.max(this.zoomTarget, 1.15);
    this.#clampPan();
  }

  resetView() {
    this.autoPan = true;
    this.panTarget.set(0, 0, 0);
    this.zoomTarget = 1;
  }

  // ---------------------------------------------------------------- picking

  pick(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.meshes, false);
    return hits[0]?.object.userData.provinceId ?? null;
  }

  projectPoint(x, z, y = 0.1) {
    const rect = this.canvas.getBoundingClientRect();
    const v = new THREE.Vector3(x, y, z).project(this.camera);
    return {
      x: (v.x * 0.5 + 0.5) * rect.width,
      y: (-v.y * 0.5 + 0.5) * rect.height,
      visible: v.z > -1 && v.z < 1 && Math.abs(v.x) < 1.35 && Math.abs(v.y) < 1.35,
    };
  }

  projectProvince(id) {
    const province = this.byId[id];
    if (!province) return { x: 0, y: 0, visible: false };
    return this.projectPoint(province.centroid[0], province.centroid[1]);
  }

  // ---------------------------------------------------------------- input

  #bindEvents() {
    const canvas = this.canvas;
    canvas.addEventListener('pointerdown', (e) => this.#onPointerDown(e));
    canvas.addEventListener('pointermove', (e) => this.#onPointerMove(e));
    canvas.addEventListener('pointerup', (e) => this.#onPointerUp(e));
    canvas.addEventListener('pointercancel', (e) => this.#onPointerUp(e));
    canvas.addEventListener('pointerleave', () => {
      if (!this.dragFrom) this.#setHover(null);
    });
    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.zoomBy(Math.exp(-e.deltaY * 0.0013));
      },
      { passive: false },
    );
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('resize', () => this.resize());
  }

  #onPointerDown(e) {
    if (!this.enabled) return;
    this.canvas.setPointerCapture?.(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.autoPan = false;

    if (this.pointers.size === 2) {
      this.#endDrag(null);
      this.panning = null;
      const [a, b] = [...this.pointers.values()];
      this.pinch = {
        distance: Math.hypot(a.x - b.x, a.y - b.y),
        center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      };
      return;
    }

    if (e.button === 2 || e.button === 1) {
      this.panning = { x: e.clientX, y: e.clientY, moved: 0 };
      this.canvas.classList.add('dragging');
      return;
    }

    const id = this.pick(e.clientX, e.clientY);
    if (id && this.callbacks.canDrag?.(id)) {
      this.dragFrom = id;
      this.dragHover = id;
      this.dragStartPoint = { x: e.clientX, y: e.clientY, moved: 0 };
      this.callbacks.onDragStart?.(id);
      this.#refreshGlow();
      this.#updateDragLine(e.clientX, e.clientY);
      return;
    }

    this.panning = { x: e.clientX, y: e.clientY, moved: 0 };
    this.pendingClick = { x: e.clientX, y: e.clientY, id };
    this.canvas.classList.add('dragging');
  }

  #onPointerMove(e) {
    if (!this.enabled) return;
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (this.pinch && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      if (this.pinch.distance > 0) this.zoomBy(distance / this.pinch.distance);
      this.#panPixels(center.x - this.pinch.center.x, center.y - this.pinch.center.y);
      this.pinch = { distance, center };
      return;
    }

    if (this.dragFrom) {
      if (this.dragStartPoint) {
        // Distance from where the finger went down, not movementX/Y: touch
        // pointer events report those as 0, so every finger drag looked like a
        // tap and no army ever marched on a phone.
        const dx = e.clientX - this.dragStartPoint.x;
        const dy = e.clientY - this.dragStartPoint.y;
        this.dragStartPoint.moved = Math.max(this.dragStartPoint.moved, Math.hypot(dx, dy));
      }
      const id = this.pick(e.clientX, e.clientY);
      const hover = id && this.validTargets.has(id) ? id : null;
      if (hover !== this.dragHover) {
        this.dragHover = hover;
        this.#refreshGlow();
      }
      this.#updateDragLine(e.clientX, e.clientY, id);
      return;
    }

    if (this.panning) {
      const dx = e.clientX - this.panning.x;
      const dy = e.clientY - this.panning.y;
      this.panning.moved += Math.abs(dx) + Math.abs(dy);
      this.panning.x = e.clientX;
      this.panning.y = e.clientY;
      this.#panPixels(dx, dy);
      return;
    }

    const id = this.pick(e.clientX, e.clientY);
    this.#setHover(id);
    this.canvas.classList.toggle('over-province', Boolean(id));
  }

  #onPointerUp(e) {
    this.pointers.delete(e.pointerId);
    if (this.pinch) {
      if (this.pointers.size < 2) this.pinch = null;
      return;
    }

    if (this.dragFrom) {
      const id = this.pick(e.clientX, e.clientY);
      const from = this.dragFrom;
      // A tap on your own province is a click, not an empty order.
      const isTap = (this.dragStartPoint?.moved ?? 0) < 9;
      this.#endDrag(id);
      this.canvas.classList.remove('dragging');
      if (id && !isTap) this.callbacks.onDrop?.(from, id);
      else if (isTap) this.callbacks.onClick?.(from);
      return;
    }

    if (this.panning) {
      const moved = this.panning.moved;
      this.panning = null;
      this.canvas.classList.remove('dragging');
      if (moved < 8 && this.pendingClick) {
        const id = this.pendingClick.id ?? this.pick(e.clientX, e.clientY);
        this.callbacks.onClick?.(id);
      }
      this.pendingClick = null;
      return;
    }
  }

  #endDrag(targetId) {
    if (!this.dragFrom) return;
    this.dragFrom = null;
    this.dragStartPoint = null;
    this.dragHover = null;
    this.validTargets = new Set();
    this.hidePreviewArrow();
    this.callbacks.onDragCancel?.();
    this.#refreshGlow();
    if (targetId) this.#setHover(targetId);
  }

  #setHover(id) {
    if (this.hovered === id) return;
    this.hovered = id;
    this.#refreshGlow();
    this.callbacks.onHover?.(id);
  }

  #panPixels(dx, dy) {
    const h = this.canvas.clientHeight || window.innerHeight;
    // Larger zoom value = closer camera = bigger map.
    const dist = this.baseDist / this.zoom;
    const worldPerPixel = (2 * dist * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2)) / h;
    this.panTarget.x -= dx * worldPerPixel;
    this.panTarget.z -= dy * worldPerPixel * 1.25;
    this.#clampPan();
  }

  #updateDragLine(clientX, clientY, overId) {
    const province = this.byId[this.dragFrom];
    if (!province) return;
    const rect = this.canvas.getBoundingClientRect();
    const point = overId ? this.byId[overId]?.centroid : null;
    let end = { x: 0, z: 0 };
    if (point) {
      end = { x: point[0], z: point[1] };
    } else {
      this.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      this.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
      this.raycaster.setFromCamera(this.pointer, this.camera);
      const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.05);
      const hit = new THREE.Vector3();
      this.raycaster.ray.intersectPlane(plane, hit);
      if (hit) end = { x: hit.x, z: hit.z };
    }
    const valid = overId ? this.validTargets.has(overId) : true;
    // A multi-province order shows the whole planned road, not a straight line
    // across the map: the player must see which provinces the column crosses.
    let route = null;
    if (overId && this.routeProvider) {
      const ids = this.routeProvider(this.dragFrom, overId);
      if (ids && ids.length > 2) {
        route = ids
          .map((id) => this.byId[id]?.centroid)
          .filter(Boolean)
          .map(([x, z]) => [x, z]);
      }
    }
    this.showPreviewArrow(this.dragFrom, [end.x, end.z], valid, route);
  }

  // ---------------------------------------------------------------- frame

  update(dt) {
    this.time += dt;
    const k = 1 - Math.exp(-dt * 9);

    if (this.autoPan) {
      const t = this.time * 0.1;
      this.panTarget.x = Math.sin(t) * 2.2;
      this.panTarget.z = Math.cos(t * 0.77) * 1.1;
    }

    this.zoom += (this.zoomTarget - this.zoom) * k;
    this.target.lerp(this.panTarget, k);

    // Larger zoom value = closer camera = bigger map.
    const dist = this.baseDist / this.zoom;
    this.camera.position.set(
      this.target.x,
      dist * Math.sin(PITCH),
      this.target.z + dist * Math.cos(PITCH),
    );
    this.camera.lookAt(this.target.x, 0, this.target.z);

    if (this.flash.size) {
      for (const [id, value] of this.flash) {
        const next = value - dt * 1.6;
        if (next <= 0) this.flash.delete(id);
        else this.flash.set(id, next);
      }
      this.#refreshGlow();
    }
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }
}
