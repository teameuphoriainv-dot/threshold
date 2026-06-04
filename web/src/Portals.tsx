import { useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { type Self } from "./helpers";
import { fx } from "./fx";

// Non-Euclidean portals after HackerPoet/NonEuclidean. The whole illusion is ONE
// `delta` matrix per portal connection (delta = dst.LocalToWorld * R180 *
// src.WorldToLocal), used for BOTH:
//   • the render — a virtual camera = delta * mainCamera renders the destination
//     room into a texture, sampled in screen space so the doorway is a real window.
//   • the teleport — crossing the plane applies the SAME delta to the player's
//     position + heading, so visual and collision never desync.
// Scale baked into the pair (different door sizes) resizes the player on crossing
// → bigger-on-the-inside (§7).

type PT = { pos: THREE.Vector3; yaw: number; size: number; color: number };
const RT = 512;
const R180 = new THREE.Matrix4().makeRotationY(Math.PI);
const Y = new THREE.Vector3(0, 1, 0);

const PAIRS: { a: PT; b: PT }[] = [
  // space-fold loop: deep north <-> near spawn
  { a: { pos: new THREE.Vector3(6, 1.7, -30), yaw: 0, size: 1, color: 0xff3a4e },
    b: { pos: new THREE.Vector3(0, 1.7, 17), yaw: Math.PI, size: 1, color: 0xff3a4e } },
  // SCALE portal (bigger-on-the-inside): small west door <-> large east door
  { a: { pos: new THREE.Vector3(-34, 1.7, 11), yaw: Math.PI / 2, size: 0.7, color: 0xd1457a },
    b: { pos: new THREE.Vector3(34, 1.7, -2), yaw: -Math.PI / 2, size: 1.3, color: 0xd1457a } },
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

    // ---- teleport: the delta kernel (pos + heading + scale) ----
    if (cd.current <= 0) {
      for (const e of ends) {
        if (Math.hypot(self.x - e.src.pos.x, self.z - e.src.pos.z) < 1.7 * e.src.size) {
          const delta = new THREE.Matrix4().multiplyMatrices(rigid(e.dst), R180).multiply(rigid(e.src).clone().invert());
          const np = new THREE.Vector3(self.x, 1.4, self.z).applyMatrix4(delta);
          self.x = np.x; self.z = np.z;
          const f = new THREE.Vector3(Math.sin(self.yaw), 0, Math.cos(self.yaw)).transformDirection(delta);
          self.yaw = Math.atan2(f.x, f.z);
          self.scale = Math.min(2.5, Math.max(0.4, self.scale * (e.dst.size / e.src.size)));
          cd.current = 1.0;
          fx.flash = 0.7; fx.trauma = Math.min(1, fx.trauma + 0.3);
          break;
        }
      }
    }

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
      {ends.map((e, i) => (
        <group key={i} position={e.src.pos.toArray()} rotation={[0, e.src.yaw, 0]}>
          <mesh>
            <torusGeometry args={[1.5 * e.src.size, 0.16, 10, 36]} />
            <meshStandardMaterial color={0x10242c} emissive={PAIRS_color(e.src)} emissiveIntensity={1.4} />
          </mesh>
          <mesh ref={(m) => { veils.current[i] = m; }} material={veilMats[i]}>
            <planeGeometry args={[2.6 * e.src.size, 3.2 * e.src.size]} />
          </mesh>
          <pointLight color={PAIRS_color(e.src)} intensity={1.2} distance={10} />
        </group>
      ))}
    </>
  );
}

function PAIRS_color(p: PT): number { return p.color; }
