import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

/**
 * Рендерер, камера и постобработка.
 *
 * Bloom даёт «неоновый» вид при почти нулевой стоимости в байтах — весь визуал
 * процедурный, текстур с диска не грузим. На слабых устройствах композитор
 * отключается целиком и сцена рендерится напрямую.
 */
export class Renderer {
  constructor(canvas, profile) {
    this.canvas = canvas;
    this.profile = profile;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: profile.pixelRatio < 1.5,
      alpha: false,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.setPixelRatio(profile.pixelRatio);
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.renderer.setClearColor(0x05060f, 1);
    this.renderer.shadowMap.enabled = !!profile.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // Тонмаппинг делает эмиссивные материалы «светящимися», а не пересвеченными.
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.06;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x05060f);
    this.scene.fog = new THREE.FogExp2(0x070a1a, profile.fogDensity);

    this.camera = new THREE.PerspectiveCamera(52, window.innerWidth / window.innerHeight, 0.5, 220);
    this.camera.position.set(0, 26, 20);
    this.camera.lookAt(0, 0, 0);

    this.composer = null;
    this.bloomPass = null;
    if (profile.bloom) this._initBloom();

    this._onResize = this._onResize.bind(this);
    window.addEventListener('resize', this._onResize);
    window.addEventListener('orientationchange', () => setTimeout(this._onResize, 220));
  }

  _initBloom() {
    const { innerWidth: w, innerHeight: h } = window;
    this.composer = new EffectComposer(this.renderer);
    this.composer.setPixelRatio(this.profile.pixelRatio);
    this.composer.setSize(w, h);
    this.composer.addPass(new RenderPass(this.scene, this.camera));

    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(w, h), this.profile.bloomStrength ?? 0.8, 0.62, 0.72);
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(new OutputPass());
  }

  /** Отключение постобработки на лету (AutoQuality или ручной переключатель). */
  disableBloom() {
    this.composer = null;
    this.bloomPass = null;
  }

  downgradePixelRatio(ratio) {
    this.profile.pixelRatio = ratio;
    this.renderer.setPixelRatio(ratio);
    if (this.composer) this.composer.setPixelRatio(ratio);
    this._onResize();
  }

  _onResize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    // На очень узких экранах расширяем FOV, чтобы игрок всегда видел врагов вокруг.
    this.camera.fov = w / h < 1 ? 62 : 52;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
    if (this.composer) this.composer.setSize(w, h);
  }

  render() {
    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    window.removeEventListener('resize', this._onResize);
    this.renderer.dispose();
    this.composer?.dispose?.();
  }
}
