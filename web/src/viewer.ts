import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { dataUrl, type Part, type Status } from './data';

export type ColorMode = 'neutral' | 'mass' | 'status';
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)');
export interface Shot { fit: 'assembled' | 'exploded'; az: number; el: number; pad: number; shiftX: number; shiftY: number }

const BG = 0x0d0b26;
const C = {
  neutral: new THREE.Color(0xb4b9e0),
  kept: new THREE.Color(0xd9dbe8),
  low: new THREE.Color(0x2f46ff),
  mid: new THREE.Color(0xff3dcb),
  accent: new THREE.Color(0xffc400),
  status: {
    verified: new THREE.Color(0x00e58a),
    estimated: new THREE.Color(0xffc400),
    proposed: new THREE.Color(0xff4fd8),
    untouched: new THREE.Color(0x5a5e94),
  } as Record<Status, THREE.Color>,
};
const GHOST = new THREE.MeshStandardMaterial({ color: 0xff3b00, emissive: 0xff3b00, emissiveIntensity: 0.7, roughness: 0.5, transparent: true, opacity: 0.5, depthWrite: false, side: THREE.DoubleSide });
const smooth = (x: number) => x * x * (3 - 2 * x);
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

interface Slot {
  part: Part; holder: THREE.Group; offset: THREE.Vector3; delay: number;
  mat: THREE.MeshStandardMaterial; shell: THREE.MeshStandardMaterial; optMat: THREE.MeshStandardMaterial;
  shellMeshes: THREE.Mesh[]; opt: THREE.Object3D | null; optUrl: string | null; removed: THREE.Object3D | null; removedTried: boolean;
  color: THREE.Color; target: THREE.Color; dim: number; dimTarget: number; center: THREE.Vector3; radius: number;
}

export class Viewer {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(26, 1, 0.05, 40);
  private controls: OrbitControls;
  private root = new THREE.Group(); // Z-up URDF world -> Y-up three.js
  private slots = new Map<string, Slot>();
  private gltf = new GLTFLoader();
  private optCache = new Map<string, Promise<THREE.Object3D | null>>();
  private clock = new THREE.Clock();
  private ground: THREE.Mesh;
  private boxA = new THREE.Box3();
  private boxE = new THREE.Box3();
  private floorY = 0;
  private palette: Record<string, string> | null = null;
  private paused = false;
  private cutId: string | null = null;
  private changes = false;
  private product: { group: THREE.Group; before: THREE.Object3D | null; after: THREE.Object3D | null; box: THREE.Box3 } | null = null;
  private productToken = 0;

  private explode = 0;
  private explodeTarget = 0;
  private shot: Shot = { fit: 'assembled', az: 0.5, el: 0.1, pad: 1.2, shiftX: 0, shiftY: 0 };
  private shift = new THREE.Vector2();
  private userCam = false;
  private goalPos = new THREE.Vector3(0, 0.5, 4);
  private goalTarget = new THREE.Vector3(0, 0.45, 0);

  private mode: ColorMode = 'neutral';
  private statuses: Record<string, Status> = {};
  private massRank = new Map<string, number>();
  private selected: string | null = null;
  private current: string | null = null;
  private after = false;
  private stress = false;
  private frames = 0;
  private fpsT = 0;
  private lowFor = 0;
  fps = 0;

  constructor(private canvas: HTMLCanvasElement, onPick: (id: string | null) => void) {
    const r = (this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' }));
    r.setClearColor(BG);
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.05;
    r.setPixelRatio(Math.min(devicePixelRatio, 2));
    r.localClippingEnabled = true;

    const pmrem = new THREE.PMREMGenerator(r);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.05).texture;
    this.scene.environmentIntensity = 0.42;

    const key = new THREE.DirectionalLight(0xffffff, 2.3);
    key.position.set(2.2, 3.4, 1.8);
    // No shadow maps: with them, random parts stopped drawing under Chrome's
    // Metal backend after the explode (8 of 8 runs clean once removed).
    key.target.position.set(0, 0.4, 0);
    const rim = new THREE.DirectionalLight(0xcfe0ff, 1.9);
    rim.position.set(-2.5, 1.6, -2.5);
    const fill = new THREE.DirectionalLight(0xffffff, 0.35);
    fill.position.set(1, 0.2, -2.5);
    this.scene.add(key, key.target, rim, fill);

    this.root.rotation.x = -Math.PI / 2;
    this.scene.add(this.root);

    // Soft pool of light under the robot; cheaper and calmer than a lit floor.
    const cv = document.createElement('canvas');
    cv.width = cv.height = 256;
    const g = cv.getContext('2d')!;
    const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
    grad.addColorStop(0, 'rgba(255,255,255,.10)');
    grad.addColorStop(0.45, 'rgba(255,255,255,.03)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 256, 256);
    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(2.4, 2.4),
      new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(cv), transparent: true, depthWrite: false }),
    );
    this.ground.rotation.x = -Math.PI / 2;
    this.scene.add(this.ground);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.enablePan = false;
    this.controls.minDistance = 0.3;
    this.controls.maxDistance = 12;
    this.controls.addEventListener('start', () => (this.userCam = true));

    this.gltf.setMeshoptDecoder(MeshoptDecoder);

    let down: [number, number] | null = null;
    canvas.addEventListener('pointerdown', (e) => (down = [e.clientX, e.clientY]));
    canvas.addEventListener('pointerup', (e) => {
      if (down && Math.hypot(e.clientX - down[0], e.clientY - down[1]) < 6) onPick(this.pick(e.clientX, e.clientY));
      down = null;
    });

    addEventListener('resize', () => this.resize());
    this.resize();
    r.setAnimationLoop(() => this.frame());
  }

  async load(parts: Part[], onProgress: (done: number, total: number) => void) {
    // Rank, not raw mass: the torso would otherwise flatten every limb to one shade.
    const heavy = [...parts].sort((a, b) => a.mass_g - b.mass_g);
    heavy.forEach((p, i) => this.massRank.set(p.id, i / Math.max(1, heavy.length - 1)));
    let done = 0;
    await Promise.all(parts.map(async (part) => {
      const url = dataUrl(part.mesh);
      const g = await this.gltf.loadAsync(url);
      const mat = new THREE.MeshStandardMaterial({ color: C.neutral.clone(), metalness: 0.28, roughness: 0.46 });
      const shell = new THREE.MeshStandardMaterial({ color: 0xd8dade, metalness: 0, roughness: 0.3, transparent: true, opacity: 0.1, depthWrite: false });
      const optMat = new THREE.MeshStandardMaterial({ color: C.neutral.clone(), metalness: 0.05, roughness: 0.75 });
      const shellMeshes: THREE.Mesh[] = [];
      g.scene.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) {
          const m = o as THREE.Mesh;
          m.material = mat;
          m.userData.partId = part.id;
          shellMeshes.push(m);
        }
      });
      const inner = new THREE.Group();
      inner.matrixAutoUpdate = false;
      inner.matrix.fromArray(part.matrix);
      inner.add(g.scene);
      const holder = new THREE.Group();
      holder.add(inner);
      this.root.add(holder);
      this.slots.set(part.id, {
        part, holder, offset: new THREE.Vector3(...part.explode), delay: 0, mat, shell, optMat, shellMeshes,
        opt: null, optUrl: null, removed: null, removedTried: false, color: C.neutral.clone(), target: C.neutral.clone(), dim: 1, dimTarget: 1,
        center: new THREE.Vector3(), radius: 0.1,
      });
      onProgress(++done, parts.length);
    }));
    this.measure();
    this.setShot(this.shot);
  }

  private measure() {
    this.root.updateMatrixWorld(true);
    const box = new THREE.Box3();
    const maxOff = Math.max(...[...this.slots.values()].map((s) => s.offset.length()), 1e-6);
    this.boxA.makeEmpty();
    this.boxE.makeEmpty();
    for (const s of this.slots.values()) {
      box.setFromObject(s.holder);
      this.boxA.union(box);
      s.radius = box.getSize(new THREE.Vector3()).length() / 2;
      s.center.copy(box.getCenter(new THREE.Vector3()));
      s.delay = (s.offset.length() / maxOff) * 0.35;
      const off = s.offset.clone().applyEuler(this.root.rotation);
      this.boxE.union(box.clone().translate(off));
    }
    this.floorY = this.boxA.min.y - 0.004;
    if (!this.product) this.ground.position.y = this.floorY;
  }

  private partEase(s: Slot) {
    return smooth(clamp01(this.explode * (1 + s.delay) - s.delay));
  }

  /** Swap the robot for a single analyzed product. Both models share one fit so they line up. */
  async showProduct(beforeUrl: string | null, afterUrl: string | null) {
    this.clearProduct();
    const mine = ++this.productToken;
    const get = async (url: string | null) => {
      if (!url) return null;
      try {
        const scene = (await this.gltf.loadAsync(url)).scene as THREE.Object3D;
        scene.traverse((o) => {
          const m = o as THREE.Mesh;
          if (m.isMesh) m.material = new THREE.MeshStandardMaterial({ color: C.neutral.clone(), metalness: 0.28, roughness: 0.46 });
        });
        return scene;
      } catch { return null; }
    };
    const [before, after] = await Promise.all([get(beforeUrl), get(afterUrl)]);
    if (mine !== this.productToken) return { before: false, after: false };
    const models = [before, after].filter((o): o is THREE.Object3D => !!o);
    if (!models.length) return { before: false, after: false };

    const group = new THREE.Group();
    group.add(...models);
    group.updateMatrixWorld(true);
    const raw = new THREE.Box3().setFromObject(group);
    const size = raw.getSize(new THREE.Vector3());
    const scale = 0.8 / Math.max(size.x, size.y, size.z, 1e-9);
    group.scale.setScalar(scale);
    group.position.copy(raw.getCenter(new THREE.Vector3()).multiplyScalar(-scale));
    group.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(group);
    this.scene.add(group);
    this.product = { group, before, after, box };
    this.root.visible = false;
    this.ground.position.y = box.min.y - 0.004;
    (this.ground.material as THREE.MeshBasicMaterial).opacity = 1;
    this.explode = this.explodeTarget = 0;
    return { before: !!before, after: !!after };
  }

  productHas(side: 'before' | 'after') { return !!this.product?.[side]; }
  productHasStress(side: 'before' | 'after') {
    let found = false;
    this.product?.[side]?.traverse((o) => { if ((o as THREE.Mesh).isMesh && (o as THREE.Mesh).geometry.getAttribute('color')) found = true; });
    return found;
  }

  setProductView(side: 'before' | 'after', stress: boolean) {
    const p = this.product;
    if (!p) return;
    for (const k of ['before', 'after'] as const) {
      const o = p[k];
      if (!o) continue;
      o.visible = k === side;
      o.traverse((c) => {
        const m = c as THREE.Mesh;
        if (!m.isMesh) return;
        const mat = m.material as THREE.MeshStandardMaterial;
        const on = stress && !!m.geometry.getAttribute('color');
        mat.color.copy(on ? new THREE.Color(0xffffff) : C.neutral);
        if (mat.vertexColors !== on) { mat.vertexColors = on; mat.needsUpdate = true; }
      });
    }
  }

  clearProduct() {
    this.productToken++;
    const p = this.product;
    if (!p) return;
    this.scene.remove(p.group);
    p.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) { m.geometry.dispose(); (m.material as THREE.Material).dispose(); }
    });
    this.product = null;
    this.root.visible = true;
    this.ground.position.y = this.floorY;
  }

  setExplode(on: boolean | number) { this.explodeTarget = typeof on === 'number' ? on : on ? 1 : 0; }
  setShot(s: Shot) { this.shot = s; this.userCam = false; this.aim(); }
  setColorMode(m: ColorMode) { this.mode = m; this.recolor(); }
  setStatuses(s: Record<string, Status>) { this.statuses = s; this.recolor(); }
  setCurrent(id: string | null) { this.current = id; this.recolor(); }
  setSelected(id: string | null) { this.selected = id; this.userCam = false; this.aim(); this.recolor(); }

  /** Choose which optimized mesh each part shows in the After view. */
  async setOptMesh(id: string, mesh: string | null) {
    const s = this.slots.get(id);
    if (!s) return;
    const url = mesh ? dataUrl(mesh) : null;
    if (url === s.optUrl && s.opt) return;
    s.optUrl = url;
    if (s.opt) { s.holder.children[0].remove(s.opt); s.opt = null; }
    if (url) {
      const obj = await this.loadOpt(url);
      if (s.optUrl !== url) return;
      if (obj) {
        if (s.opt) s.holder.children[0].remove(s.opt); // a concurrent call may have landed first
        s.opt = obj.clone();
        s.opt.traverse((o) => {
          const m = o as THREE.Mesh;
          if (m.isMesh) { m.material = s.optMat; m.userData.partId = id; }
        });
        s.holder.children[0].add(s.opt);
      }
    }
    this.applyView();
    if (s.opt) await this.loadRemoved(id);
  }

  private loadOpt(url: string) {
    let p = this.optCache.get(url);
    if (!p) {
      p = this.gltf.loadAsync(url).then((g) => g.scene as THREE.Object3D).catch(() => null);
      this.optCache.set(url, p);
    }
    return p;
  }

  hasOpt(id: string) { return !!this.slots.get(id)?.opt; }
  hasStress(id: string) {
    let found = false;
    this.slots.get(id)?.opt?.traverse((o) => {
      if ((o as THREE.Mesh).isMesh && (o as THREE.Mesh).geometry.getAttribute('color')) found = true;
    });
    return found;
  }

  setView(after: boolean, stress: boolean) { this.after = after; this.stress = stress; this.applyView(); }

  private applyView() {
    for (const s of this.slots.values()) {
      const show = this.after && !!s.opt;
      const ghost = show && this.changes && !!s.removed;
      if (s.removed) s.removed.visible = ghost;
      if (s.opt) s.opt.visible = show;
      for (const m of s.shellMeshes) {
        m.material = show ? s.shell : s.mat;
        m.visible = !(show && (ghost || this.cutId === s.part.id));
        m.renderOrder = show ? 2 : 0;
      }
      const colors = !ghost && show && this.stress && this.hasStress(s.part.id);
      if (s.optMat.vertexColors !== colors) { s.optMat.vertexColors = colors; s.optMat.needsUpdate = true; }
    }
    this.recolor();
  }

  /** Per-part colors (strategy coding) laid over the current mode; untouched parts recede. */
  setPalette(p: Record<string, string> | null) { this.palette = p; this.recolor(); }
  setPaused(v: boolean) { this.paused = v; }

  /** Open the selected part: clip the near half of its redesigned mesh, facing the camera. */
  setCut(id: string | null) {
    this.cutId = id;
    const s = id ? this.slots.get(id) : null;
    for (const o of this.slots.values()) o.optMat.clippingPlanes = [];
    if (s) {
      const n = this.goalTarget.clone().sub(this.camera.position).normalize();
      s.optMat.clippingPlanes = [new THREE.Plane().setFromNormalAndCoplanarPoint(n, this.goalTarget)];
      s.optMat.side = THREE.DoubleSide;
      s.optMat.needsUpdate = true;
    }
    this.applyView();
  }

  /** Optional ghost of the material taken away, in the same frame as the part. */
  async loadRemoved(id: string) {
    const s = this.slots.get(id);
    if (!s || s.removedTried) return !!s?.removed;
    s.removedTried = true;
    try {
      const scene = (await this.gltf.loadAsync(dataUrl(`parts/${id}_removed.glb`))).scene;
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) { m.material = GHOST; m.renderOrder = 3; m.userData.partId = id; }
      });
      s.removed = scene;
      s.holder.children[0].add(scene);
    } catch { /* optional file */ }
    this.applyView();
    return !!s.removed;
  }
  hasRemoved(id?: string) {
    return id ? !!this.slots.get(id)?.removed : [...this.slots.values()].some((s) => s.removed);
  }
  /** Changes view: kept material neutral, removed material ghosted in a vivid highlight. */
  setChanges(v: boolean) { this.changes = v; this.applyView(); }

  private recolor() {
    const focus = this.selected ?? this.current;
    for (const s of this.slots.values()) {
      const st = this.statuses[s.part.id] ?? 'untouched';
      if (this.mode === 'status') s.target.copy(this.current === s.part.id && st === 'untouched' ? C.neutral : C.status[st]);
      else if (this.mode === 'mass') {
        const r = this.massRank.get(s.part.id) ?? 0;
        if (r < 0.5) s.target.copy(C.low).lerp(C.mid, r * 2); else s.target.copy(C.mid).lerp(C.accent, r * 2 - 1);
      }
      else s.target.copy(C.neutral);
      if (this.palette) s.target.copy(this.palette[s.part.id] ? new THREE.Color(this.palette[s.part.id]) : C.status.untouched);
      s.dimTarget = focus && focus !== s.part.id ? (this.selected ? 0.22 : 0.6) : 1;
    }
  }

  private pick(x: number, y: number) {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const hit = ray.intersectObjects([...this.slots.values()].flatMap((s) => s.shellMeshes), false)[0];
    return hit ? (hit.object.userData.partId as string) : null;
  }

  private resize() {
    const w = innerWidth, h = innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.applyOffset();
    this.aim();
  }

  private applyOffset() {
    const w = innerWidth, h = innerHeight;
    if (Math.abs(this.shift.x) + Math.abs(this.shift.y) < 1e-4) this.camera.clearViewOffset();
    else this.camera.setViewOffset(w, h, -this.shift.x * w, -this.shift.y * h, w, h);
    this.camera.updateProjectionMatrix();
  }

  /** Compute the camera goal so the whole subject fits at any aspect ratio. */
  private aim(sway = 0) {
    const { az, el, pad, fit } = this.shot;
    const sel = this.selected ? this.slots.get(this.selected) : null;
    const dir = new THREE.Vector3(Math.cos(el) * Math.cos(az + sway), Math.sin(el), -Math.cos(el) * Math.sin(az + sway));
    const tan = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    if (sel) {
      const e = this.partEase(sel);
      const off = sel.offset.clone().applyEuler(this.root.rotation).multiplyScalar(e);
      this.goalTarget.copy(sel.center).add(off);
      const r = Math.max(sel.radius, 0.08) * 1.5;
      this.goalPos.copy(this.goalTarget).addScaledVector(dir, Math.max(r / tan, r / (tan * this.camera.aspect)));
      return;
    }
    const box = this.product ? this.product.box : fit === 'exploded' ? this.boxE : this.boxA;
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    box.getCenter(this.goalTarget);
    const halfW = Math.hypot(size.x, size.z) / 2;
    const dist = Math.max(size.y / 2 / tan, halfW / (tan * this.camera.aspect)) * pad + halfW;
    this.goalPos.copy(this.goalTarget).addScaledVector(dir, dist);
  }

  private frame() {
    const dt = Math.min(this.clock.getDelta(), 0.05);
    if (this.paused) return; // the story is showing opaque sections over the canvas
    this.step(dt, this.clock.elapsedTime);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);

    this.frames++;
    this.fpsT += dt;
    if (this.fpsT >= 1) {
      this.fps = Math.round(this.frames / this.fpsT);
      // Protect stage frame rate on weak GPUs: shed resolution.
      this.lowFor = this.fps < 40 ? this.lowFor + 1 : 0;
      if (this.lowFor >= 3 && this.renderer.getPixelRatio() > 1) {
        this.renderer.setPixelRatio(1);
        this.renderer.setSize(innerWidth, innerHeight, false);
        this.lowFor = 0;
      }
      this.frames = 0;
      this.fpsT = 0;
    }
  }

  /** Advance animation state by dt. The video capture script drives this directly. */
  step(dt: number, t: number) {

    // Explode: constant rate driving per-part eased, staggered motion.
    if (this.explode !== this.explodeTarget) {
      const step = dt / 1.5;
      this.explode = this.explodeTarget > this.explode ? Math.min(this.explodeTarget, this.explode + step) : Math.max(this.explodeTarget, this.explode - step);
      for (const s of this.slots.values()) s.holder.position.copy(s.offset).multiplyScalar(this.partEase(s));
      (this.ground.material as THREE.MeshBasicMaterial).opacity = 1 - this.explode * 0.6;
    }

    const k = 1 - Math.exp(-dt * 7);
    for (const s of this.slots.values()) {
      s.color.lerp(s.target, k);
      s.dim += (s.dimTarget - s.dim) * k;
      const pulse = this.current === s.part.id ? 0.12 + 0.05 * Math.sin(t * 5) : 0;
      s.mat.color.copy(s.color).multiplyScalar(s.dim);
      s.mat.emissive.copy(s.color).multiplyScalar(pulse);
      if (s.optMat.vertexColors) s.optMat.color.setScalar(s.dim);
      else if (this.changes && s.removed) s.optMat.color.copy(C.kept).multiplyScalar(s.dim);
      else s.optMat.color.copy(s.color).multiplyScalar(s.dim);
      s.shell.opacity = 0.1 * s.dim;
    }

    // Camera: glide to the goal unless the presenter has taken over.
    const narrow = innerWidth < 760;
    const sx = this.selected ? (narrow ? 0 : -0.12) : this.shot.shiftX, sy = this.selected ? (narrow ? -0.2 : 0) : this.shot.shiftY;
    const before = this.shift.clone();
    this.shift.x += (sx - this.shift.x) * (1 - Math.exp(-dt * 3));
    this.shift.y += (sy - this.shift.y) * (1 - Math.exp(-dt * 3));
    if (before.distanceToSquared(this.shift) > 1e-9) this.applyOffset();
    if (!this.userCam) {
      this.aim(this.selected || REDUCED.matches ? 0 : Math.sin(t * 0.18) * 0.1);
      const c = 1 - Math.exp(-dt * 2.6);
      this.camera.position.lerp(this.goalPos, c);
      this.controls.target.lerp(this.goalTarget, c);
    }
  }
}
