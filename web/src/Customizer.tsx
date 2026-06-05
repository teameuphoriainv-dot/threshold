// ============================================================
//  CUSTOMIZER — the full WHISPERS avatar panel (lobby, pre-game, live).
//
//  Self-contained: Game.tsx renders <Customizer/> in the lobby + waiting room.
//  It owns its own draft state, shows a live rotating <Character/> preview, and
//  persists via the setAvatar reducer (+ optional account register/login).
//
//  Wiring contract (see integrationInstructions for the exact Game.tsx edits):
//    <Customizer
//      initial={avatarFromPlayer(me)}        // current persisted look
//      onApply={(cfg) => setAvatar(avatarToReducerArgs(cfg))}   // setAvatar reducer
//      onSetName={(name) => setName({ name })}                  // existing set_name
//      onRegister={(u,p) => registerAccount({ username:u, pin:p })}
//      onLogin={(u,p)    => loginAccount({ username:u, pin:p })}
//      currentName={me?.name}
//    />
//
//  Persistence model:
//    - Anonymous players: setAvatar writes straight onto their Player row (lives
//      as long as the identity token in localStorage survives).
//    - Account players: register_account / login_account snapshot the look into
//      the `account` row keyed by username+pin, so it follows them across devices.
//      The reducer copies the saved look back onto the live Player on login.
// ============================================================
import { useEffect, useMemo, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { EffectComposer, Bloom } from "@react-three/postprocessing";
import {
  BUILDS, HOODS, MARKINGS, HEIGHTS, EMISSIVE, PALETTE,
  DEFAULT_AVATAR, type AvatarConfig,
} from "./avatar";
import { Character } from "./Character";
import "./Customizer.css";

export type CustomizerProps = {
  /** Current persisted look (from the live Player row). Falls back to default. */
  initial?: AvatarConfig;
  /** Current persisted name, for the name field. */
  currentName?: string;
  /** Persist the look — wire to the setAvatar reducer in Game.tsx. */
  onApply: (cfg: AvatarConfig) => void;
  /** Persist the display name — wire to the existing set_name reducer. */
  onSetName?: (name: string) => void;
  /** Optional account creation — wire to register_account. */
  onRegister?: (username: string, pin: string) => void;
  /** Optional account login — wire to login_account. */
  onLogin?: (username: string, pin: string) => void;
  /** Show a compact variant (e.g. squeezed into the waiting room). */
  compact?: boolean;
};

// --- a tiny live 3D preview of the current draft ---------------------------
function Preview({ avatar }: { avatar: AvatarConfig }) {
  return (
    <Canvas
      camera={{ fov: 38, position: [0, 1.8, 5.2] }}
      style={{ width: "100%", height: "100%", borderRadius: 10 }}
      gl={{ alpha: true }}
    >
      <color attach="background" args={[0x0c0a0d]} />
      <fogExp2 attach="fog" args={[0x0c0a0d, 0.12]} />
      <ambientLight intensity={0.5} color={0x4a4048} />
      <directionalLight position={[3, 6, 4]} intensity={0.7} color={0x8a93a0} />
      <pointLight position={[-3, 2, 2]} intensity={0.6} color={0xff7a8a} />
      <group position-y={-0.3}>
        <Character avatar={avatar} animate seen />
      </group>
      <EffectComposer>
        <Bloom intensity={0.85} luminanceThreshold={0.45} luminanceSmoothing={0.4} mipmapBlur />
      </EffectComposer>
    </Canvas>
  );
}

// --- a labelled chip row used for each enumerated option -------------------
function ChipRow<T extends { name: string; desc?: string }>(
  { label, options, value, onChange }: {
    label: string; options: readonly T[]; value: number; onChange: (i: number) => void;
  },
) {
  const active = options[value];
  return (
    <div className="cz-field">
      <div className="cz-label">{label}</div>
      <div className="cz-chips">
        {options.map((o, i) => (
          <button
            key={o.name}
            type="button"
            className={"cz-chip" + (i === value ? " sel" : "")}
            onClick={() => onChange(i)}
          >
            {o.name}
          </button>
        ))}
      </div>
      {active?.desc && <div className="cz-desc">{active.desc}</div>}
    </div>
  );
}

function Slider(
  { label, min, max, step, value, fmt, onChange }: {
    label: string; min: number; max: number; step: number; value: number;
    fmt: (v: number) => string; onChange: (v: number) => void;
  },
) {
  return (
    <div className="cz-field">
      <div className="cz-label">{label}<span className="cz-val">{fmt(value)}</span></div>
      <input
        type="range" min={min} max={max} step={step} value={value}
        className="cz-slider"
        onChange={(e) => onChange(parseFloat(e.target.value))}
      />
    </div>
  );
}

export function Customizer({
  initial, currentName, onApply, onSetName, onRegister, onLogin, compact = false,
}: CustomizerProps) {
  const [draft, setDraft] = useState<AvatarConfig>(initial ?? DEFAULT_AVATAR);
  const [name, setName] = useState(currentName ?? "");
  const [dirty, setDirty] = useState(false);

  // account panel state
  const [authMode, setAuthMode] = useState<"none" | "register" | "login">("none");
  const [username, setUsername] = useState("");
  const [pin, setPin] = useState("");
  const [authErr, setAuthErr] = useState<string | null>(null);

  // Re-sync the draft/name when the persisted row changes underneath us (e.g. on
  // login, where login_account rewrites the live Player). Done with the official
  // "adjust state during render" pattern (https://react.dev/reference/react/useState#storing-information-from-previous-renders)
  // rather than an effect, so there's no cascading re-render. Skipped while the
  // user has unsaved edits so we never clobber their in-progress choices.
  const [prevInitial, setPrevInitial] = useState(initial);
  if (initial && initial !== prevInitial) {
    setPrevInitial(initial);
    if (!dirty) setDraft(initial);
  }
  const [prevName, setPrevName] = useState(currentName);
  if (currentName !== undefined && currentName !== prevName) {
    setPrevName(currentName);
    if (!dirty) setName(currentName);
  }

  const set = (patch: Partial<AvatarConfig>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setDirty(true);
  };

  const apply = () => {
    onApply(draft);
    if (onSetName && name.trim() && name.trim() !== currentName) onSetName(name.trim());
    setDirty(false);
  };

  // live-apply toggle: when on, every change is pushed immediately (great in-lobby UX)
  const [live, setLive] = useState(true);
  useEffect(() => {
    if (!live || !dirty) return;
    const t = setTimeout(() => { onApply(draft); setDirty(false); }, 180); // debounce
    return () => clearTimeout(t);
  }, [live, dirty, draft, onApply]);

  const usernameValid = useMemo(() => /^[\w]{3,16}$/.test(username), [username]);
  const pinValid = useMemo(() => /^\d{4,6}$/.test(pin), [pin]);

  const submitAuth = () => {
    setAuthErr(null);
    if (!usernameValid) { setAuthErr("username must be 3–16 letters/digits"); return; }
    if (!pinValid) { setAuthErr("pin must be 4–6 digits"); return; }
    if (authMode === "register") onRegister?.(username, pin);
    else if (authMode === "login") onLogin?.(username, pin);
    setPin("");
  };

  return (
    <div className={"cz-root" + (compact ? " cz-compact" : "")}>
      <div className="cz-preview">
        <Preview avatar={draft} />
      </div>

      <div className="cz-controls">
        <div className="cz-title">YOUR SHAPE</div>

        {onSetName && (
          <div className="cz-field">
            <div className="cz-label">NAME</div>
            <input
              className="cz-text" maxLength={16} placeholder="who are you?"
              value={name}
              onChange={(e) => { setName(e.target.value); setDirty(true); }}
            />
          </div>
        )}

        {/* COLOR — palette swatches (shares the trust-color space) */}
        <div className="cz-field">
          <div className="cz-label">GLOW</div>
          <div className="cz-swatches">
            {PALETTE.map((c) => (
              <button
                key={c}
                type="button"
                className={"cz-swatch" + (draft.color === c ? " sel" : "")}
                style={{ background: "#" + c.toString(16).padStart(6, "0") }}
                onClick={() => set({ color: c })}
                aria-label={"color " + c.toString(16)}
              />
            ))}
          </div>
        </div>

        <ChipRow label="BUILD" options={BUILDS} value={draft.build} onChange={(i) => set({ build: i })} />
        <ChipRow label="HOOD" options={HOODS} value={draft.hood} onChange={(i) => set({ hood: i })} />
        <ChipRow label="MARKING" options={MARKINGS} value={draft.marking} onChange={(i) => set({ marking: i })} />

        <Slider
          label="HEIGHT" min={HEIGHTS.min} max={HEIGHTS.max} step={0.01}
          value={draft.height} fmt={(v) => v.toFixed(2) + "×"}
          onChange={(v) => set({ height: v })}
        />
        <Slider
          label="GLOW STRENGTH" min={EMISSIVE.min} max={EMISSIVE.max} step={0.01}
          value={draft.emissive} fmt={(v) => Math.round(v * 100) + "%"}
          onChange={(v) => set({ emissive: v })}
        />

        <label className="cz-live">
          <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} />
          apply changes live
        </label>

        {!live && (
          <button type="button" className="btn cz-apply" disabled={!dirty} onClick={apply}>
            {dirty ? "SAVE LOOK" : "SAVED"}
          </button>
        )}

        {/* ACCOUNT — optional cross-device persistence */}
        {(onRegister || onLogin) && (
          <div className="cz-account">
            {authMode === "none" ? (
              <div className="cz-auth-toggle">
                <span>keep this look across devices?</span>
                {onRegister && <button type="button" className="cz-link" onClick={() => { setAuthMode("register"); setAuthErr(null); }}>create account</button>}
                {onLogin && <button type="button" className="cz-link" onClick={() => { setAuthMode("login"); setAuthErr(null); }}>log in</button>}
              </div>
            ) : (
              <div className="cz-auth-form">
                <div className="cz-label">{authMode === "register" ? "NEW ACCOUNT" : "LOG IN"}</div>
                <input
                  className="cz-text" placeholder="username (3–16)" autoComplete="off"
                  value={username} onChange={(e) => setUsername(e.target.value.replace(/\s/g, ""))}
                />
                <input
                  className="cz-text" placeholder="pin (4–6 digits)" inputMode="numeric"
                  type="password" autoComplete="off" maxLength={6}
                  value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
                />
                {authErr && <div className="cz-err">{authErr}</div>}
                <div className="cz-auth-actions">
                  <button type="button" className="btn" onClick={submitAuth}>
                    {authMode === "register" ? "CREATE" : "ENTER"}
                  </button>
                  <button type="button" className="cz-link" onClick={() => setAuthMode("none")}>cancel</button>
                </div>
                <div className="cz-desc">
                  {authMode === "register"
                    ? "your current look is saved to this account."
                    : "your saved look replaces your current one."}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
