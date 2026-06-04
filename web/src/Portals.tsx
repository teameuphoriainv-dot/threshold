import { useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { type Self } from "./helpers";
import { fx, tickAmbient, paintPortalTint, PORTAL_TYPES, type PortalType } from "./fx";

// Non-Euclidean portals after HackerPoet/NonEuclidean. The whole illusion is ONE
// `delta` matrix per portal connection (delta = dst.LocalToWorld * R180 *
// src.WorldToLocal), used for BOTH:
//   • the render — a virtual camera = delta * mainCamera renders the destination
//     room into a texture, sampled in screen space so the doorway is a real window.
//   • the teleport — crossing the plane applies the SAME delta to the player's
//     position + heading, so visual and collision never desync.
// Scale baked into the pair (different door sizes) resizes the player on crossing
// → bigger-on-the-inside (§7).

type PT = { pos: THREE.Vector3; yaw: number; size: number; type: PortalType };
const RT = 512;
const R180 = new THREE.Matrix4().makeRotationY(Math.PI);
const Y = new THREE.Vector3(0, 1, 0);
// how far the portal mouth's hum/tint reaches (world units); proximity inside
// this radius drives the ambient dread + colour wash (see paintPortalTint).
const HUM_RADIUS = 9;

// Pair type lives on the PAIR, not the end — both mouths of a connection share
// one identity, and PORTAL_TYPES (fx.ts) is the SINGLE source of colour/feel.
const PAIRS: { type: PortalType; a: PT; b: PT }[] = [
  // space-fold loop: deep north <-> near spawn.
  // The spawn-side end is pulled OFF the x=0 spawn->convergence corridor
  // (spawn (0,26) -> convergence (0,4)) so players don't get yanked through
  // it the instant they walk forward. Tucked east into open floor, facing
  // back toward the corridor so it still reads as a doorway off the path.
  { type: "FOLD",
    a: { pos: new THREE.Vector3(6, 1.7, -30), yaw: 0, size: 1, type: "FOLD" },
    b: { pos: new THREE.Vector3(13, 1.7, 18), yaw: -Math.PI / 2, size: 1, type: "FOLD" } },
  // SCALE portal (bigger-on-the-inside): small west door <-> large east door
  { type: "SCALE",
    a: { pos: new THREE.Vector3(-34, 1.7, 11), yaw: Math.PI / 2, size: 0.7, type: "SCALE" },
    b: { pos: new THREE.Vector3(34, 1.7, -2), yaw: -Math.PI / 2, size: 1.3, type: "SCALE" } },
];

const rigid = (p: PT) =>
  new THREE.Matrix4().compose(p.pos, new THREE.Quaternion().setFromAxisAngle(Y, p.yaw), new THREE.Vector3(1, 1, 1));

const VEIL_FRAG = `
  uniform sampler2D tPortal;
  uniform vec2 uRes;
  void main() { gl_FragColor = texture2D(tPortal, gl_FragCoord.xy / uRes); }
`;
const VEIL_VERT = `void main(){ gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`;

export function Portals({ self }: { self: Self }) {
  const { gl, scene, camera } = useThree();

  // four portal ends (each pair contributes src->dst both ways)
  const ends = useMemo(
    () => PAIRS.flatMap((pr) => [{ src: pr.a, dst: pr.b }, { src: pr.b, dst: pr.a }]),
    []
  );
  const rts = useMemo(() => ends.map(() => new THREE.WebGLRenderTarget(RT, RT)), [ends]);
  const veilMats = useMemo(
    () => ends.map((_, i) =>
      new THREE.ShaderMaterial({
        uniforms: { tPortal: { value: rts[i].texture }, uRes: { value: new THREE.Vector2(1, 1) } },
        vertexShader: VEIL_VERT, fragmentShader: VEIL_FRAG,
      })),
    [ends, rts]
  );
  const veils = useRef<(THREE.Mesh | null)[]>([]);
  const vcam = useMemo(() => { const c = new THREE.PerspectiveCamera(62, 1, 0.1, 400); c.matrixAutoUpdate = false; return c; }, []);
  const cd = useRef(0);
  const RES = useMemo(() => new THREE.Vector2(), []);

  useFrame((_, dt) => {
    cd.current = Math.max(0, cd.current - dt);

    // ---- proximity wash + teleport, in one distance pass over the mouths ----
    // closest dist per pair-type so the colour code is driven by the nearest
    // portal of each kind; we feed the strongest into paintPortalTint below.
    let teleported = false;
    for (const e of ends) {
      const d = Math.hypot(self.x - e.src.pos.x, self.z - e.src.pos.z);

      // colour/dread wash: 0 at the hum radius, 1 at the mouth (eased). Painting
      // by TYPE means colour == meaning — red FOLD vs magenta SCALE wash the
      // ambience differently as you approach, and the dread swells with it.
      if (d < HUM_RADIUS) {
        const closeness = 1 - d / HUM_RADIUS;
        paintPortalTint(e.src.type, closeness * closeness);
      }

      // teleport: the delta kernel (pos + heading + scale)
      if (!teleported && cd.current <= 0 && d < 1.7 * e.src.size) {
        const delta = new THREE.Matrix4().multiplyMatrices(rigid(e.dst), R180).multiply(rigid(e.src).clone().invert());
        const np = new THREE.Vector3(self.x, 1.4, self.z).applyMatrix4(delta);
        self.x = np.x; self.z = np.z;
        const f = new THREE.Vector3(Math.sin(self.yaw), 0, Math.cos(self.yaw)).transformDirection(delta);
        self.yaw = Math.atan2(f.x, f.z);
        self.scale = Math.min(2.5, Math.max(0.4, self.scale * (e.dst.size / e.src.size)));
        cd.current = 1.0;
        // crossing-specific kick: a brighter flash for the disorienting SCALE
        // gate (your body resizes) than for the smoother FOLD loop.
        const cross = e.src.type === "SCALE" ? 0.9 : 0.7;
        fx.flash = cross; fx.trauma = Math.min(1, fx.trauma + (e.src.type === "SCALE" ? 0.45 : 0.3));
        teleported = true;
      }
    }

    // own the dread heartbeat: Portals is the single per-frame owner of the
    // ambient scalar (it already runs every frame and is the thing that paints
    // the tint). tickAmbient eases ambient toward floor+breath+hot+near and
    // relaxes the tint/hum we just painted. Runs even if nothing is nearby.
    tickAmbient(dt);

    // ---- see-through render: virtual camera = same delta * main camera ----
    gl.getSize(RES).multiplyScalar(gl.getPixelRatio());
    veils.current.forEach((v) => v && (v.visible = false));        // depth-1: no portal-in-portal
    const prevRT = gl.getRenderTarget();
    for (let i = 0; i < ends.length; i++) {
      const e = ends[i];
      const delta = new THREE.Matrix4().multiplyMatrices(rigid(e.dst), R180).multiply(rigid(e.src).clone().invert());
      vcam.matrixWorld.multiplyMatrices(delta, camera.matrixWorld);
      vcam.matrixWorldInverse.copy(vcam.matrixWorld).invert();
      vcam.projectionMatrix.copy(camera.projectionMatrix);
      // oblique-ish seam removal: clip everything behind the destination doorway
      const n = new THREE.Vector3(Math.sin(e.dst.yaw), 0, Math.cos(e.dst.yaw));
      gl.clippingPlanes = [new THREE.Plane().setFromNormalAndCoplanarPoint(n, e.dst.pos)];
      (veilMats[i].uniforms.uRes.value as THREE.Vector2).copy(RES);
      gl.setRenderTarget(rts[i]);
      gl.render(scene, vcam);
    }
    gl.setRenderTarget(prevRT);
    gl.clippingPlanes = [];
    veils.current.forEach((v) => v && (v.visible = true));
  });

  return (
    <>
      {ends.map((e, i) => {
        const t = PORTAL_TYPES[e.src.type]; // color == meaning, from fx.ts
        return (
          <group key={i} position={e.src.pos.toArray()} rotation={[0, e.src.yaw, 0]}>
            <mesh>
              <torusGeometry args={[1.5 * e.src.size, 0.16, 10, 36]} />
              <meshStandardMaterial color={0x10242c} emissive={t.ring} emissiveIntensity={t.emissive} toneMapped={false} />
            </mesh>
            <mesh ref={(m) => { veils.current[i] = m; }} material={veilMats[i]}>
              <planeGeometry args={[2.6 * e.src.size, 3.2 * e.src.size]} />
            </mesh>
            <pointLight color={t.color} intensity={1.2} distance={10 * e.src.size} />
          </group>
        );
      })}
    </>
  );
}
