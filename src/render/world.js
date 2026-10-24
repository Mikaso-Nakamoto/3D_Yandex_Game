import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const DEPTH = 0.34;
const PITCH = THREE.MathUtils.degToRad(58);
// Limits are expressed in world units, not in zoom factors: the two maps have
// very different scales (the Atlantic file is three times wider), and a fixed
// zoom range would make the same country look half the size on one of them.
const MIN_VISIBLE = 9.5; // closest: this many world units across the screen
const MAX_VISIBLE = 2.2; // farthest: 2.2 widths of the map

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
  // The province the player is looking at. A 1-pixel golden contour was lost
  // among the borders (and the hover highlight used to wipe it out), so the
  // selection now also lights the province itself.
  selected: { color: 0xf3c85a, intensity: 0.34 },
  selectedHover: { color: 0xffd98a, intensity: 0.46 },
};


/** Even-odd test: is the point inside the ring of [x, z] pairs? */
function insideRing(ring, x, z) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}


/**
 * Merges extruded rings into one geometry that keeps the cap/wall split.
 * `mergeGeometries(shapes, false)` throws the material groups away, and a mesh
 * with two materials but no groups is drawn in a fallback colour — that is how
 * France and Italy turned grey on the world map. Caps go first, walls second,
 * and the merged geometry gets exactly the two groups the mesh expects.
 */
function mergeRings(geometries) {
  const caps = [];
  const walls = [];
  for (const geometry of geometries) {
    for (const group of geometry.groups) {
      const part = new THREE.BufferGeometry();
      for (const [name, attribute] of Object.entries(geometry.attributes)) {
        const slice = attribute.array.slice(
          group.start * attribute.itemSize,
          (group.start + group.count) * attribute.itemSize,
        );
        part.setAttribute(name, new THREE.BufferAttribute(slice, attribute.itemSize));
      }
      (group.materialIndex === 0 ? caps : walls).push(part);
    }
    geometry.dispose();
  }
  const merged = [];
  for (const list of [caps, walls]) {
    if (!list.length) continue;
    const one = list.length > 1 ? mergeGeometries(list, false) : list[0];
    for (const part of list) if (part !== one) part.dispose();
    merged.push(one);
  }
  if (merged.length < 2) return merged[0];
  const result = mergeGeometries(merged, true);
  for (const part of merged) part.dispose();
  return result;
}

export class World {
  constructor(canvas, map, callbacks = {}) {
    this.canvas = canvas;
    this.map = map;
    this.callbacks = callbacks;
    this.byId = Object.fromEntries(map.provinces.map((p) => [p.id, p]));

    // Multisampling on top of a 2x device pixel ratio costs more than it gives:
    // phones render the same picture with fewer samples and a slightly larger
    // frame budget. On a normal screen antialias stays on.
    const dpr = window.devicePixelRatio || 1;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: dpr < 1.5,
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
    // Ground plane slightly above the mesh top (the top face sits at y = 0).
    this.groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.02);
    this.planeHit = new THREE.Vector3();

    this.meshes = [];
    this.groups = new Map();
    // The world map is a cylinder: `period` is how far you scroll before the
    // same land shows up again. Provinces flagged by the builder as crossing
    // the date line are drawn twice more, one period to each side, so the seam
    // never opens a hole.
    this.period = map.wrap?.period ?? null;
    // Two extra copies of the whole theatre, one period to each side. The two
    // nearest the camera are shown, so the world never ends at the screen edge;
    // the third one is hidden and costs nothing to draw.
    this.copyGroups = { plus: [], minus: [] };
    this.seamExtras = [];
    this.#indexBoxes();
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
    this.selectionLines = [];
    this.selectionLines = [];

    this.pointers = new Map();
    this.pinch = null;
    this.panning = null;
    this.pendingClick = null;

    this.target = new THREE.Vector3(0, 0, 0);
    this.panTarget = new THREE.Vector3(0, 0, 0);
    this.zoom = 1;
    this.zoomTarget = 1;
    this.baseDist = 60;
    this.focusDist = null;
    this.mapCenter = { x: 0, z: 0 };
    // Where the idle menu drift orbits. focusNation() moves it, so the menu
    // background pans over the countries of the chosen theatre instead of
    // snapping back to the middle of the ocean.
    this.viewCenter = { x: 0, z: 0 };
    // Pixels of the screen covered by the HUD; the camera keeps the land out
    // from under the buttons instead of hiding provinces behind them.
    this.safeArea = { top: 0, right: 0, bottom: 0, left: 0 };
    this.autoPan = true;
    this.time = 0;
    this.enabled = true;

    this.#buildLights();
    this.#buildWater();
    this.#buildProvinces();
    this.#buildBorders();
    this.#buildDragLine();
    this.#bindEvents();
    this.#updateMapCenter();
    this.resize();
  }

  /** Middle of the drawn land, not of the coordinate system: the theatre is
   *  lopsided (Europe left, America right), so the origin is not the middle. */
  #updateMapCenter() {
    const e = this.map.extent;
    this.mapCenter = e
      ? { x: (e.minX + e.maxX) / 2, z: (e.minZ + e.maxZ) / 2 }
      : { x: 0, z: 0 };
    this.viewCenter = { ...this.mapCenter };
    this.target.set(this.mapCenter.x, 0, this.mapCenter.z);
    this.panTarget.set(this.mapCenter.x, 0, this.mapCenter.z);
    // The corners of the bounding box are open sea; fitting them would push the
    // camera far away and leave the land as a small patch. Fit the real coast.
    const vertices = [];
    for (const province of this.map.provinces) {
      for (const ring of province.rings) {
        const stride = Math.max(1, Math.floor(ring.length / 36));
        for (let i = 0; i < ring.length; i += stride) {
          const [x, z] = ring[i];
          vertices.push(new THREE.Vector3(x, 0.1, z));
        }
      }
    }
    this.fitPoints = vertices;
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
    this.#indexBoxes();
    this.meshes = [];
    this.groups.clear();
    this.seamExtras = [];
    this.copyGroups = { plus: [], minus: [] };
    this.period = map.wrap?.period ?? null;
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
    this.#updateMapCenter();
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
    // The sea must outrun the camera on the cylinder: at the far zoom the world
    // is a period wide, and a 420-unit square left a dark wedge at the top of
    // the screen where the plane ended.
    const size = Math.max(420, (this.period ?? this.map.width) * 3, this.map.height * 3);
    const geo = new THREE.PlaneGeometry(size, size);
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

      const shapes = [];
      const rings = [province.rings[0], ...(province.islands ?? [])];
      for (const ring of rings) {
        if (!ring || ring.length < 3) continue;
        shapes.push(this.#extrudeRing(ring));
      }
      // One mesh per province, islands included: the world theatre keeps two
      // copies of everything on screen and every extra mesh is a draw call.
      const geometry = shapes.length > 1 ? mergeRings(shapes) : shapes[0];
      // One mesh per outline (the mainland plus every island). Merging them
      // into a single geometry would drop the material groups, and a mesh with
      // two materials but no groups is drawn with a fallback colour — that is
      // exactly how France and Italy turned grey on the world map.
      const addGroup = (offsetX, remember) => {
        const group = new THREE.Group();
        group.position.x = offsetX;
        const mesh = new THREE.Mesh(geometry, [top, side]);
        mesh.userData.provinceId = province.id;
        group.add(mesh);
        this.meshes.push(mesh);
        if (remember) remember.push(mesh);
        this.scene.add(group);
        return group;
      };
      const main = addGroup(0, null);
      this.groups.set(province.id, main);
      if (this.period) {
        this.copyGroups.plus.push(addGroup(this.period, null));
        this.copyGroups.minus.push(addGroup(-this.period, null));
      }
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
    const mat = new THREE.LineBasicMaterial({
      color: 0x0a1119,
      transparent: true,
      opacity: 0.62,
    });
    // The world repeats: every contour is drawn one period to each side as
    // well. Lines are cheap, so both copies stay visible and the scrolling map
    // keeps its borders wherever the camera is.
    if (this.period) {
      const original = positions.slice();
      for (const shift of [this.period, -this.period]) {
        for (let i = 0; i < original.length; i += 3) {
          positions.push(original[i] + shift, original[i + 1], original[i + 2]);
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
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
    this.#refreshGlow();
    this.#rebuildSelectionLines();
  }

  /**
   * A golden contour drawn as a thin *ribbon* (buffer geometry, not a line):
   * WebGL ignores line width, and a hairline is invisible on a phone.
   */
  #rebuildSelectionLines() {
    for (const line of this.selectionLines ?? []) {
      this.scene.remove(line);
      line.geometry.dispose();
      line.material.dispose();
    }
    this.selectionLines = [];
    this.selectionLine = null;
    if (!this.selected) return;
    const province = this.byId[this.selected];
    if (!province) return;
    const width = 0.3;
    const positions = [];
    for (const ring of [province.rings[0], ...(province.islands ?? [])]) {
      const count = ring?.length ?? 0;
      if (count < 3) continue;
      // Signed area tells which side of the boundary is inside. The band is
      // drawn *inside* the province: a centred band doubled the coastline's
      // coarse zig-zag and made a sawtooth crown around the country.
      let area = 0;
      for (let i = 0; i < count; i += 1) {
        const [x1, z1] = ring[i];
        const [x2, z2] = ring[(i + 1) % count];
        area += x1 * z2 - x2 * z1;
      }
      const side = area >= 0 ? 1 : -1;
      // Mitre the corners instead of stamping one quad per segment: separate
      // quads left triangular gaps at every turn of the coastline.
      const offsets = [];
      for (let i = 0; i < count; i += 1) {
        const prev = ring[(i - 1 + count) % count];
        const cur = ring[i];
        const next = ring[(i + 1) % count];
        const normal = (a, b) => {
          const dx = b[0] - a[0];
          const dz = b[1] - a[1];
          const len = Math.hypot(dx, dz) || 1;
          return [(-dz / len) * side, (dx / len) * side];
        };
        const n1 = normal(prev, cur);
        const n2 = normal(cur, next);
        const sx = n1[0] + n2[0];
        const sz = n1[1] + n2[1];
        const dot = n1[0] * n2[0] + n1[1] * n2[1];
        const scale = 1 + dot;
        let mx = scale > 1e-4 ? sx / scale : n1[0];
        let mz = scale > 1e-4 ? sz / scale : n1[1];
        const len = Math.hypot(mx, mz);
        if (len > 3) {
          mx = (mx / len) * 3;
          mz = (mz / len) * 3;
        }
        offsets.push([cur[0] + mx * width, cur[1] + mz * width]);
      }
      for (let i = 0; i < count; i += 1) {
        const a = ring[i];
        const b = ring[(i + 1) % count];
        const ia = offsets[i];
        const ib = offsets[(i + 1) % count];
        positions.push(
          a[0], 0.05, a[1],
          ia[0], 0.05, ia[1],
          ib[0], 0.05, ib[1],
          a[0], 0.05, a[1],
          ib[0], 0.05, ib[1],
          b[0], 0.05, b[1],
        );
      }
    }
    if (!positions.length) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffd98a,
      transparent: true,
      opacity: 0.95,
      depthTest: false,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 9;
    this.scene.add(mesh);
    this.selectionLine = mesh;
    this.selectionLines = [mesh];
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
      } else if (id === this.selected) {
        // Stays golden under the cursor and while another panel is open: the
        // player must never wonder which province the card belongs to.
        state = this.hovered === id ? 'selectedHover' : 'selected';
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

    this.baseDist = this.#fitDistance();
    // The far plane must follow the map: on the world theatre the camera sits
    // hundreds of units away when the whole planet is on screen, and a fixed
    // 500-unit plane cut the continents off at the far zoom.
    this.camera.far = Math.max(500, this.baseDist * 8);
    this.camera.updateProjectionMatrix();
    // The framed distance is stored in world units, so a resize (or a phone
    // rotation) keeps the same view instead of re-scaling the zoom factor.
    if (this.focusDist) {
      const limits = this.#zoomLimits();
      this.zoomTarget = THREE.MathUtils.clamp(this.baseDist / this.focusDist, limits.min, limits.max);
    }
  }

  /** The part of the screen that is not covered by the HUD, in NDC. */
  #safeBand() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    const topInset = Math.max(Math.min(h * 0.2, 62), this.safeArea.top);
    const bottomInset = Math.max(Math.min(h * 0.24, 86), this.safeArea.bottom);
    // Keep a few pixels of sea between the coast and the edge of the screen.
    const rightInset = Math.min(this.safeArea.right, w * 0.34) + 8;
    const leftInset = Math.max(this.safeArea.left, 10);
    const yHigh = 1 - (2 * topInset) / h;
    const yLow = -1 + (2 * bottomInset) / h;
    const xHigh = 1 - (2 * rightInset) / w;
    const xLow = -1 + (2 * leftInset) / w;
    return {
      yHigh,
      yLow,
      xHigh,
      xLow,
      centerY: (yHigh + yLow) / 2,
      centerX: (xHigh + xLow) / 2,
      w,
      h,
    };
  }

  /** World units a single view may span at most. Both theatres have a similar
   *  short side, so the same country is shown at the same apparent size on
   *  both — the wide Atlantic file must not shrink Europe by fitting the sea. */
  #maxSpan() {
    return Math.min(this.map.width, this.map.height) * 0.82;
  }

  /** Zoom range derived from the map scale, so both theatres feel the same. */
  #zoomLimits() {
    if (this.period) {
      // Fully zoomed out, exactly one turn of the cylinder fits across the
      // screen. Fitting the height instead showed a world and a third of the
      // next one side by side, which reads as a duplicated map rather than a
      // seamless one; panning still goes round and round.
      const aspect = this.camera.aspect > 0.2 ? this.camera.aspect : 1.78;
      const halfFov = Math.tan((this.camera.fov * Math.PI) / 360);
      const distance = this.period / (2 * halfFov * aspect);
      // No `min(..., 1)` here: on a wide phone screen that cap let the camera
      // back away far enough to show nearly two worlds side by side.
      return {
        min: this.baseDist / distance,
        max: Math.max(this.baseDist / MIN_VISIBLE, 1.5),
      };
    }
    const widest = this.map.width * MAX_VISIBLE;
    const min = this.baseDist / widest;
    const max = this.baseDist / MIN_VISIBLE;
    return { min: Math.min(min, 1), max: Math.max(max, 1.5) };
  }

  /**
   * The densest square of provinces, `halfSpan` world units from the middle.
   * On the Atlantic map the playable countries sit on two continents and
   * their average centre falls in the ocean; the menu has to look *somewhere*,
   * and that somewhere is where most of the countries are.
   */
  #denseCluster(list, halfSpan) {
    let best = list;
    let bestScore = -1;
    for (const centre of list) {
      const near = list.filter(
        (p) => Math.abs(p.centroid[0] - centre.centroid[0]) <= halfSpan
          && Math.abs(p.centroid[1] - centre.centroid[1]) <= halfSpan * 0.8,
      );
      if (near.length > bestScore) {
        bestScore = near.length;
        best = near;
      }
    }
    return best;
  }

  /**
   * The provinces that make up the *core* of a set: the densest cluster,
   * covering `share` of them. A realm with one colony across the ocean is
   * still shown from its mainland, and the whole Atlantic theatre is shown
   * from Europe — otherwise «Atlantic» would always look half the size of
   * «Europe» just because the map file is wider.
   */
  #coreProvinces(list, share = 0.78) {
    if (list.length <= 3) return list;
    const xs = list.map((p) => p.centroid[0]).sort((a, b) => a - b);
    const zs = list.map((p) => p.centroid[1]).sort((a, b) => a - b);
    const midX = xs[Math.floor(xs.length / 2)];
    const midZ = zs[Math.floor(zs.length / 2)];
    const dist = (p) => Math.hypot(p.centroid[0] - midX, p.centroid[1] - midZ);
    const sorted = [...list].sort((a, b) => dist(a) - dist(b));
    const keep = Math.max(3, Math.ceil(sorted.length * share));
    const radius = dist(sorted[keep - 1]) * 1.08;
    return sorted.filter((p) => dist(p) <= radius);
  }

  /**
   * Frames the given provinces: their middle goes to the middle of the free
   * area and the zoom is chosen so the realm fills `fill` of it. One number
   * covers a city-state and a continent — no more hand-tuned 1.1 / 1.55.
   */
  focusNation(ids = [], fill = 0.5, options = {}) {
    const all = ids.map((id) => this.byId[id]).filter(Boolean);
    if (!all.length) return false;
    // A realm with overseas lands is framed from its capital: Britain shows
    // the British Isles, not the Isles plus Canada squeezed to a corner.
    const anchor = options.anchor ? this.byId[options.anchor] : null;
    const maxSpan = this.#maxSpan();
    const spanOf = (list) => {
      const xs = list.map((p) => p.centroid[0]);
      const zs = list.map((p) => p.centroid[1]);
      return Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs));
    };
    let core;
    if (anchor) {
      // Everything within a shrinking radius of the capital, so a chain of
      // overseas holdings never drags the camera out to the whole ocean.
      let radius = maxSpan * 0.62;
      core = all.filter(
        (p) => Math.hypot(p.centroid[0] - anchor.centroid[0], p.centroid[1] - anchor.centroid[1]) <= radius,
      );
      while (core.length > 1 && spanOf(core) > maxSpan) {
        radius *= 0.7;
        core = all.filter(
          (p) => Math.hypot(p.centroid[0] - anchor.centroid[0], p.centroid[1] - anchor.centroid[1]) <= radius,
        );
      }
      if (!core.length) core = [anchor];
    } else if (options.dense) {
      // A fixed window in world units, not a share of the file: both maps share
      // the European scale, so «Europe» is framed identically on either.
      core = this.#denseCluster(all, Math.min(16, maxSpan / 2));
    } else if (options.all === false) {
      core = this.#coreProvinces(all);
    } else {
      core = all;
    }
    // Never frame more than one theatre's worth of land: without this the
    // whole two-continent scenario would be zoomed out to a tiny strip.
    const clampSpan = spanOf(core) > maxSpan;
    const points = [];
    let sx = 0;
    let sz = 0;
    for (const province of core) {
      sx += province.centroid[0];
      sz += province.centroid[1];
      for (const ring of province.rings) {
        const stride = Math.max(1, Math.floor(ring.length / 24));
        for (let i = 0; i < ring.length; i += stride) {
          points.push(new THREE.Vector3(ring[i][0], 0.1, ring[i][1]));
        }
      }
    }
    const n = core.length;
    if (!n || !points.length) return false;
    const band = this.#safeBand();
    const cx = sx / n;
    let cz = sz / n;
    const cam = this.camera;
    const measure = (dist, centerZ) => {
      cam.position.set(cx, dist * Math.sin(PITCH), centerZ + dist * Math.cos(PITCH));
      cam.lookAt(cx, 0, centerZ);
      cam.updateMatrixWorld(true);
      let lowX = 9;
      let highX = -9;
      let lowY = 9;
      let highY = -9;
      for (const point of points) {
        const v = point.clone().project(cam);
        if (v.x < lowX) lowX = v.x;
        if (v.x > highX) highX = v.x;
        if (v.y < lowY) lowY = v.y;
        if (v.y > highY) highY = v.y;
      }
      const needW = (highX - lowX) / bandW;
      const needH = (highY - lowY) / bandH;
      return { ratio: Math.max(needW, needH), cy: (lowY + highY) / 2 };
    };
    // The realm should take `fill` of the free area *in its widest direction*,
    // so an empire and a duchy both read at a sensible size.
    const bandW = band.xHigh - band.xLow;
    const bandH = band.yHigh - band.yLow;
    let dist = this.baseDist;
    for (let i = 0; i < 8; i += 1) {
      const { ratio } = measure(dist, cz);
      if (!Number.isFinite(ratio) || ratio <= 0.0001) break;
      dist *= ratio / fill;
      if (Math.abs(ratio - fill) < 0.01) break;
    }
    // A big scenario may cover a whole ocean. Pull the camera back to at most
    // one theatre's worth of land: the same count of degrees per pixel on both
    // maps, so «Atlantic» is not drawn smaller than «Europe».
    if (clampSpan) {
      measure(dist, cz); // put the camera where the fit left it
      const a = new THREE.Vector3(cx, 0.1, cz).project(cam);
      const b = new THREE.Vector3(cx + 1, 0.1, cz).project(cam);
      const ndcPerUnit = Math.hypot(b.x - a.x, b.y - a.y);
      // How many world units fit across the free band right now.
      const visibleWorld = ndcPerUnit > 1e-6 ? (band.xHigh - band.xLow) / ndcPerUnit : maxSpan;
      if (visibleWorld < maxSpan) dist *= maxSpan / visibleWorld;
    }
    for (let i = 0; i < 3; i += 1) {
      const probe = measure(dist, cz);
      const shifted = measure(dist, cz + 1);
      const slope = shifted.cy - probe.cy;
      if (Math.abs(slope) < 1e-4) break;
      const dz = THREE.MathUtils.clamp(
        (band.centerY - probe.cy) / slope,
        -this.map.height * 0.45,
        this.map.height * 0.45,
      );
      cz += dz;
      if (Math.abs(dz) < 0.05) break;
    }
    this.autoPan = false;
    this.viewCenter = { x: cx, z: cz };
    this.panTarget.set(cx, 0, cz);
    const limits = this.#zoomLimits();
    const widest = this.period ? this.period * 0.98 : this.map.width * MAX_VISIBLE;
    this.focusDist = THREE.MathUtils.clamp(dist, MIN_VISIBLE, widest);
    this.zoomTarget = THREE.MathUtils.clamp(this.baseDist / this.focusDist, limits.min, limits.max);
    return true;
  }

  /**
   * Camera distance at which the whole map fills the free part of the screen.
   * The old formula used the raw plane size, so on a wide phone the tilted
   * map occupied barely half the height and hung in an empty sea. Here the
   * real coastline is projected and the distance is nudged until the drawing
   * touches the safe band between the top bar and the bottom panels.
   */
  #fitDistance() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    const band = this.#safeBand();
    const { yHigh, yLow, xHigh, xLow } = band;
    const bandCenter = band.centerY;
    const bandCenterX = band.centerX;
    const points = this.fitPoints?.length
      ? this.fitPoints
      : [new THREE.Vector3(this.mapCenter.x, 0.1, this.mapCenter.z)];
    const cam = this.camera;
    let cx = this.mapCenter.x;
    const measure = (dist, cz) => {
      cam.position.set(cx, dist * Math.sin(PITCH), cz + dist * Math.cos(PITCH));
      cam.lookAt(cx, 0, cz);
      cam.updateMatrixWorld(true);
      let ratio = 0;
      let low = 9;
      let high = -9;
      let left = 9;
      let right = -9;
      for (const point of points) {
        const v = point.clone().project(cam);
        ratio = Math.max(
          ratio,
          v.x > 0 ? v.x / xHigh : v.x / xLow,
          v.y > 0 ? v.y / yHigh : v.y / yLow,
        );
        if (v.y < low) low = v.y;
        if (v.y > high) high = v.y;
        if (v.x < left) left = v.x;
        if (v.x > right) right = v.x;
      }
      return { ratio, cy: (low + high) / 2, cxp: (left + right) / 2 };
    };
    // The projected size is close to inversely proportional to the distance,
    // so a few multiplications land on the answer.
    let dist = Math.max(12, this.map.width * 0.45);
    let cz = this.mapCenter.z;
    const fitDist = () => {
      for (let i = 0; i < 10; i += 1) {
        const { ratio } = measure(dist, cz);
        if (!Number.isFinite(ratio) || ratio <= 0) return;
        dist *= ratio;
        if (Math.abs(ratio - 1) < 0.004) return;
      }
    };
    for (let round = 0; round < 3; round += 1) {
      fitDist();
      // A tilted camera shows the far edge higher than the near edge, so the
      // land sits low on screen and leaves a dead band on top. Slide the frame
      // until the drawing is centred in the free space, then fit again.
      const probe = measure(dist, cz);
      const shifted = measure(dist, cz + 1);
      const slope = shifted.cy - probe.cy;
      const dz = Math.abs(slope) > 1e-4
        ? THREE.MathUtils.clamp(
            (bandCenter - probe.cy) / slope,
            -this.map.height * 0.45,
            this.map.height * 0.45,
          )
        : 0;
      // Same for the sideways shift when buttons take a column on the right.
      // One world unit sideways is worth this much on the NDC axis.
      const dxPerUnit = 1 / (dist * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2)
        * this.camera.aspect);
      const dx = THREE.MathUtils.clamp(
        (probe.cxp - bandCenterX) / Math.max(dxPerUnit, 1e-4),
        -this.map.width * 0.3,
        this.map.width * 0.3,
      );
      cz += dz;
      cx += dx;
      if (Math.abs(dx) < 0.02 && Math.abs(dz) < 0.02) break;
    }
    // Re-fit once more: the last slide freed room that the drawing can use.
    fitDist();
    this.fitCenterZ = cz;
    this.fitCenterX = cx;
    return dist;
  }

  setSafeArea(area = {}) {
    this.safeArea = { top: 0, right: 0, bottom: 0, left: 0, ...area };
    this.resize();
  }

  setAutoPan(on) {
    this.autoPan = on;
  }

  zoomBy(factor) {
    // From here on the player owns the zoom; a later resize must not snap it.
    this.focusDist = this.baseDist / this.zoomTarget;
    const { min, max } = this.#zoomLimits();
    this.zoomTarget = THREE.MathUtils.clamp(this.zoomTarget * factor, min, max);
  }

  panBy(dx, dz) {
    this.autoPan = false;
    this.panTarget.x += dx;
    this.panTarget.z += dz;
    this.#clampPan();
  }

  /** The camera may wander over the map, not beyond it. Bounds come from the
   *  real land extent: an earlier centre-based box could not reach Moscow or
   *  Alaska on the wide Atlantic map, so framing a realm silently drifted. */
  #clampPan() {
    if (this.period) {
      // Modular wrap: never a `while` loop here, a NaN or an infinite value
      // would spin the main thread forever.
      const wrapped = Number.isFinite(this.panTarget.x)
        ? this.panTarget.x - Math.round(this.panTarget.x / this.period) * this.period
        : 0;
      const shift = wrapped - this.panTarget.x;
      if (Math.abs(shift) > 1e-9) {
        this.panTarget.x += shift;
        this.target.x += shift;
        this.viewCenter.x += shift;
      }
      const e = this.map.extent;
      const marginZ = this.map.height * 0.08;
      this.panTarget.z = THREE.MathUtils.clamp(
        this.panTarget.z,
        (e?.minZ ?? -this.map.height / 2) - marginZ,
        (e?.maxZ ?? this.map.height / 2) + marginZ,
      );
      return;
    }
    const e = this.map.extent;
    const marginX = this.map.width * 0.08;
    const marginZ = this.map.height * 0.08;
    const minX = (e?.minX ?? -this.map.width / 2) - marginX;
    const maxX = (e?.maxX ?? this.map.width / 2) + marginX;
    const minZ = (e?.minZ ?? -this.map.height / 2) - marginZ;
    const maxZ = (e?.maxZ ?? this.map.height / 2) + marginZ;
    this.panTarget.x = THREE.MathUtils.clamp(this.panTarget.x, minX, maxX);
    this.panTarget.z = THREE.MathUtils.clamp(this.panTarget.z, minZ, maxZ);
  }

  focusOn(provinceId) {
    const province = this.byId[provinceId];
    if (!province) return;
    // Same scale language as focusNation: the capital and its neighbours.
    const around = [provinceId, ...(province.neighbors ?? [])].filter((id) => this.byId[id]);
    this.focusNation(around, 0.34);
  }

  resetView() {
    this.focusDist = null;
    this.autoPan = true;
    this.viewCenter = { x: this.fitCenterX ?? this.mapCenter.x, z: this.fitCenterZ ?? this.mapCenter.z };
    this.panTarget.set(this.viewCenter.x, 0, this.viewCenter.z);
    this.zoomTarget = 1;
  }

  // ---------------------------------------------------------------- picking

  /**
   * Which province is under the pointer. The hit is computed against the map
   * data, not against the WebGL triangles: provinces that keep islands are one
   * merged mesh with a single material group, and a raycaster would skip them.
   * The ray is cast onto the ground plane and the point is tested against the
   * real outlines, which also handles the wrapped copies for free.
   */
  pick(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const plane = this.groundPlane;
    const hit = this.planeHit;
    if (!this.raycaster.ray.intersectPlane(plane, hit)) return null;
    return this.#provinceAt(hit.x, hit.z);
  }

  /** Screen-independent lookup: which province covers the map point (x, z). */
  #provinceAt(x, z) {
    for (const province of this.map.provinces) {
      const box = this.boxes.get(province.id);
      if (!box) continue;
      // The point may be on the copy one period away; measure it against the
      // copy nearest to this province before the box test.
      let px = x;
      if (this.period && Number.isFinite(px)) {
        px -= Math.round((px - province.centroid[0]) / this.period) * this.period;
      }
      if (px < box.minX || px > box.maxX || z < box.minZ || z > box.maxZ) continue;
      const rings = [province.rings[0], ...(province.islands ?? [])];
      for (const ring of rings) {
        if (ring && insideRing(ring, px, z)) return province.id;
      }
    }
    return null;
  }

  #indexBoxes() {
    this.boxes = new Map();
    for (const province of this.map.provinces) {
      let minX = Infinity;
      let maxX = -Infinity;
      let minZ = Infinity;
      let maxZ = -Infinity;
      for (const ring of [province.rings[0], ...(province.islands ?? [])]) {
        if (!ring) continue;
        for (const [x, z] of ring) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (z < minZ) minZ = z;
          if (z > maxZ) maxZ = z;
        }
      }
      this.boxes.set(province.id, { minX, maxX, minZ, maxZ });
    }
  }

  projectPoint(x, z, y = 0.1) {
    // On the cylinder every point exists once per period. Labels and arrows use
    // the copy nearest the camera, otherwise an arrow across the Bering strait
    // would be drawn around the whole world.
    if (this.period && Number.isFinite(x)) {
      const dx = x - this.target.x;
      if (dx > this.period / 2) x -= this.period;
      else if (dx < -this.period / 2) x += this.period;
    }
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
      this.panTarget.x = this.viewCenter.x + Math.sin(t) * 2.2;
      this.panTarget.z = this.viewCenter.z + Math.cos(t * 0.77) * 1.1;
    }

    // Safety net: a stale or programmatic zoom must never leave the allowed
    // range, otherwise the camera flies past the far plane and the map vanishes.
    const limits = this.#zoomLimits();
    this.zoomTarget = THREE.MathUtils.clamp(this.zoomTarget, limits.min, limits.max);
    this.zoom += (this.zoomTarget - this.zoom) * k;
    this.target.lerp(this.panTarget, k);

    if (this.period && this.copyGroups.plus.length) {
      // The camera lives in [-period/2, period/2]. Whatever the side, the pair
      // of copies that covers the view is the original plus the one next to it.
      const positive = this.target.x >= 0;
      for (const group of this.copyGroups.plus) group.visible = positive;
      for (const group of this.copyGroups.minus) group.visible = !positive;
    }

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
