// Runtime smoke test for THRESHOLD boot path.
// Stubs only the Three.js r128 surface that REALLY exists (CapsuleGeometry intentionally
// absent, exactly like r128) so the original `new THREE.CapsuleGeometry` bug would re-throw.
const fs = require("fs");
const html = fs.readFileSync(process.argv[2], "utf8");
const script = [...html.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)].pop()[1];

// ---- Vector3 with the chainable methods the code uses ----
class Vec {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  clone() { return new Vec(this.x, this.y, this.z); }
  add(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
  sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
  subVectors(a, b) { this.x = a.x - b.x; this.y = a.y - b.y; this.z = a.z - b.z; return this; }
  normalize() { const l = this.length() || 1; this.x /= l; this.y /= l; this.z /= l; return this; }
  length() { return Math.hypot(this.x, this.y, this.z); }
  lengthSq() { return this.x ** 2 + this.y ** 2 + this.z ** 2; }
  distanceTo(v) { return Math.hypot(this.x - v.x, this.y - v.y, this.z - v.z); }
  lerp(v, a) { this.x += (v.x - this.x) * a; this.y += (v.y - this.y) * a; this.z += (v.z - this.z) * a; return this; }
}
const obj3 = () => ({
  position: new Vec(), rotation: new Vec(), scale: new Vec(1, 1, 1),
  material: { emissiveIntensity: 1, opacity: 1 }, userData: {}, visible: true,
  intensity: 1, add() {}, lookAt() {}, copy(v) { this.position.copy(v); return this; },
});
const THREE = {
  Scene: class { constructor() { Object.assign(this, obj3()); this.background = null; this.fog = null; } },
  Color: class { constructor() {} setHSL() { return this; } },
  FogExp2: class {}, PerspectiveCamera: class { constructor() { Object.assign(this, obj3()); this.aspect = 1; } updateProjectionMatrix() {} },
  WebGLRenderer: class { setPixelRatio() {} setSize() {} render() {} constructor() { this.domElement = {}; } },
  AmbientLight: class { constructor() { Object.assign(this, obj3()); } },
  HemisphereLight: class { constructor() { Object.assign(this, obj3()); } },
  PointLight: class { constructor() { Object.assign(this, obj3()); } },
  DirectionalLight: class { constructor() { Object.assign(this, obj3()); this.target = obj3(); } },
  AnimationMixer: class { constructor() {} clipAction() { return { reset(){return this;}, play(){return this;}, setLoop(){}, setEffectiveTimeScale(){return this;}, setEffectiveWeight(){return this;}, crossFadeFrom(){return this;}, fadeIn(){return this;}, fadeOut(){return this;}, enabled: true }; } update() {} addEventListener() {} },
  LoopOnce: 2200,
  MeshStandardMaterial: class { constructor(o = {}) { Object.assign(this, o); } },
  MeshBasicMaterial: class { constructor(o = {}) { Object.assign(this, o); } },
  Mesh: class { constructor(g, m) { Object.assign(this, obj3()); this.geometry = g; this.material = m || this.material; } },
  Group: class { constructor() { Object.assign(this, obj3()); } },
  PlaneGeometry: class {}, BoxGeometry: class {}, CylinderGeometry: class {},
  TorusGeometry: class {}, OctahedronGeometry: class {}, SphereGeometry: class {}, CircleGeometry: class {},
  Vector3: Vec,
  BufferGeometry: class { constructor() { this.attributes = {}; } setAttribute(n, a) { this.attributes[n] = a; } },
  BufferAttribute: class { constructor(arr) { this.array = arr; this.needsUpdate = false; } },
  Points: class { constructor(g, m) { Object.assign(this, obj3()); this.geometry = g; this.material = m; } },
  PointsMaterial: class { constructor(o = {}) { Object.assign(this, o); } },
  Clock: class { getDelta() { return 0.016; } start() {} getElapsedTime() { return 0; } },
  MathUtils: { degToRad: d => d * Math.PI / 180 },
  DoubleSide: 2,
  // CapsuleGeometry: INTENTIONALLY UNDEFINED (matches r128)
};

// ---- DOM stubs ----
const elements = {};
function makeEl() {
  return {
    children: [], style: {}, textContent: "", innerHTML: "",
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); } },
    _handlers: {},
    getContext() { return new Proxy({}, { get: () => (() => {}), set: () => true }); },
    addEventListener(ev, fn) { this._handlers[ev] = fn; },
    appendChild(c) { this.children.push(c); this.firstChild = this.children[0]; },
    removeChild(c) { this.children.shift(); this.firstChild = this.children[0]; },
    querySelector() { return makeEl(); },
  };
}
const document = {
  getElementById(id) { return elements[id] || (elements[id] = makeEl()); },
  querySelector(s) { return elements[s] || (elements[s] = makeEl()); },
  createElement() { return makeEl(); },
  body: { appendChild() {} },
};
let loadHandler = null;
const window = { addEventListener(ev, fn) { if (ev === "load") loadHandler = fn; }, innerWidth: 1280, innerHeight: 720 };

const sandbox = {
  THREE, document, window, console,
  innerWidth: 1280, innerHeight: 720, devicePixelRatio: 1,
  performance: { now: () => 1000 },
  _rafCb: null,
  requestAnimationFrame(cb) { sandbox._rafCb = cb; return 0; },  // capture loop() for a manual frame
  setTimeout: () => 0,
  addEventListener: window.addEventListener,
};

const vm = require("vm");
vm.createContext(sandbox);
try {
  vm.runInContext(script, sandbox, { filename: "index.html-script" });
  if (!loadHandler) throw new Error("no load handler registered");
  loadHandler();                         // -> buildWorld() + loop() (running=false)
  const startBtn = elements["startBtn"];
  if (!startBtn || !startBtn._handlers.click) throw new Error("START BUTTON HANDLER NOT ATTACHED (the reported bug)");
  startBtn._handlers.click();            // simulate "ENTER THE THRESHOLD" (sets running=true)
  // drive a few live frames so updatePlayer/updatePlayerAnim/updatePortals/drawMinimap actually run
  for (const code of ["KeyW", "ShiftLeft", "Space", "KeyG", "ArrowLeft"]) sandbox.keys && (sandbox.keys[code] = true);
  let frames = 0;
  for (let i = 0; i < 5 && sandbox._rafCb; i++) { sandbox._rafCb(); frames++; }
  console.log("PASS: world built, ENTER THE THRESHOLD fired, " + frames + " live frames ran (movement+anim+minimap exercised) with no throw");
} catch (e) {
  console.log("FAIL: " + e.message);
  process.exit(1);
}
