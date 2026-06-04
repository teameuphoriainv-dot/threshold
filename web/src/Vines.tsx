import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { WALLS } from "./world";

// Fleshy subsurface-scattering vines with real vertex undulation (PRD §3/§8).
// One shared ShaderMaterial; per-tendril phase is seeded from world position so
// they don't breathe in lockstep.
const VERT = `
  uniform float uTime;
  varying vec3 vWorldNormal; varying vec3 vViewDir; varying float vThickness;
  void main() {
    float ph = modelMatrix[3][0] * 0.7 + modelMatrix[3][2] * 0.5;
    float yN = (position.y + 1.0) * 0.5;
    vThickness = clamp(1.0 - yN, 0.0, 1.0);
    float wave = sin(uTime * 0.9 + ph + position.y * 1.6);
    vec3 disp = position;
    disp.x += wave * 0.10 * yN;
    disp.z += cos(uTime * 0.7 + ph + position.y * 1.3) * 0.06 * yN;
    disp.xz *= 1.0 + wave * 0.04;
    vec4 wp = modelMatrix * vec4(disp, 1.0);
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    vViewDir = normalize(cameraPosition - wp.xyz);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;
const FRAG = `
  uniform float uTime;
  uniform vec3 uDeep; uniform vec3 uGlow; uniform vec3 uRim;
  varying vec3 vWorldNormal; varying vec3 vViewDir; varying float vThickness;
  void main() {
    vec3 N = normalize(vWorldNormal); vec3 V = normalize(vViewDir);
    float fres = pow(1.0 - max(dot(N, V), 0.0), 3.0);
    float wrap = pow(max(dot(N, V), 0.0), 0.5);
    float sss = (vThickness * 0.65 + 0.35) * wrap;
    float pulse = 0.85 + 0.15 * sin(uTime * 1.3 + vThickness * 4.0);
    vec3 col = uDeep;
    col += uGlow * sss * pulse;
    col += uRim * fres * 1.2;
    col = col / (col + vec3(0.55));
    gl_FragColor = vec4(col, 1.0);
  }
`;

type Tendril = { pos: [number, number, number]; rotZ: number; len: number };

export function Vines() {
  const mat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: {
          uTime: { value: 0 },
          uDeep: { value: new THREE.Color(0x0a2622) },  // deep teal (was red-purple 0x2a0a12)
          uGlow: { value: new THREE.Color(0x12b39a) },  // teal blue-green glow (was crimson 0xb31226)
          uRim: { value: new THREE.Color(0x3affd8) },   // bright teal rim (was red 0xff3a52)
        },
        vertexShader: VERT,
        fragmentShader: FRAG,
      }),
    []
  );

  // deterministic tendril placement on wall faces (computed once)
  const tendrils = useMemo<Tendril[]>(() => {
    const out: Tendril[] = [];
    let s = 1;
    const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    for (const w of WALLS) {
      const count = Math.max(2, Math.floor((w.w + w.d) * 0.4));
      for (let i = 0; i < count; i++) {
        const onX = rnd() > 0.5;
        const x = w.x + (onX ? (rnd() - 0.5) * w.w : (rnd() > 0.5 ? w.w / 2 : -w.w / 2));
        const z = w.z + (onX ? (rnd() > 0.5 ? w.d / 2 : -w.d / 2) : (rnd() - 0.5) * w.d);
        out.push({ pos: [x, 0.5 + rnd() * 6, z], rotZ: (rnd() - 0.5) * 1.2, len: 2 + rnd() * 3 });
      }
    }
    return out;
  }, []);

  const matRef = useRef(mat);
  useFrame(({ clock }) => { matRef.current.uniforms.uTime.value = clock.elapsedTime; });

  return (
    <group>
      {tendrils.map((t, i) => (
        <mesh key={i} position={t.pos} rotation={[0, 0, t.rotZ]} material={mat}>
          <cylinderGeometry args={[0.06, 0.13, t.len, 8]} />
        </mesh>
      ))}
    </group>
  );
}
