// ============================================================
//  CUSTOMIZER — the full WHISPERS avatar panel (lives inside CreatorScreen).
//
//  FULLY CONTROLLED: this component owns NO avatar/name draft state. The parent
//  (CreatorScreen) is the single source of truth — it passes the live `value`
//  (drives every control's selected state) and `name`, and receives every change
//  synchronously via `onChange` / `onNameChange`. CreatorScreen renders the live
//  <AvatarPodium avatar={value}/> as the preview, so there is no 3rd WebGL context
//  here. Changes always reflect instantly; there is no live-toggle or save button.
//
//  Wiring contract (CreatorScreen owns draft + name):
//    <Customizer
//      compact
//      value={draft}                                    // single source of truth
//      onChange={(cfg) => { setDraft(cfg); onApply(cfg); }}
//      name={name}
//      onNameChange={(n) => { setName(n); onSetName?.(n); }}
//      onRegister={(u,p) => registerAccount({ username:u, pin:p })}
//      onLogin={(u,p)    => loginAccount({ username:u, pin:p })}
//    />
//
//  Persistence model (handled by the host, not here):
//    - Anonymous players: setAvatar writes straight onto their Player row.
//    - Account players: register_account / login_account snapshot the look into
//      the `account` row keyed by username+pin, so it follows them across devices.
// ============================================================
import { useMemo, useState } from "react";
import {
  BUILDS, HOODS, MARKINGS, HEIGHTS, EMISSIVE, PALETTE,
  type AvatarConfig,
} from "./avatar";
import "./Customizer.css";

export type CustomizerProps = {
  /** The parent's draft — drives EVERY avatar control's selected state. */
  value: AvatarConfig;
  /** Fires SYNCHRONOUSLY on every avatar control change. */
  onChange: (cfg: AvatarConfig) => void;
  /** The parent's name draft — drives the NAME input value. */
  name: string;
  /** Fires on every NAME keystroke. */
  onNameChange: (name: string) => void;
  /** Optional account creation — wire to register_account. */
  onRegister?: (username: string, pin: string) => void;
  /** Optional account login — wire to login_account. */
  onLogin?: (username: string, pin: string) => void;
  /** Show a compact variant (e.g. squeezed into the creator panel). */
  compact?: boolean;
};

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
  value, onChange, name, onNameChange, onRegister, onLogin, compact = false,
}: CustomizerProps) {
  // account panel state (the only local state — auth is self-contained here)
  const [authMode, setAuthMode] = useState<"none" | "register" | "login">("none");
  const [username, setUsername] = useState("");
  const [pin, setPin] = useState("");
  const [authErr, setAuthErr] = useState<string | null>(null);

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
      <div className="cz-controls">
        <div className="cz-title">YOUR SHAPE</div>

        <div className="cz-field">
          <div className="cz-label">NAME</div>
          <input
            className="cz-text" maxLength={16} placeholder="who are you?"
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
          />
        </div>

        {/* COLOR — palette swatches (shares the trust-color space) */}
        <div className="cz-field">
          <div className="cz-label">GLOW</div>
          <div className="cz-swatches">
            {PALETTE.map((c) => (
              <button
                key={c}
                type="button"
                className={"cz-swatch" + (value.color === c ? " sel" : "")}
                style={{ background: "#" + c.toString(16).padStart(6, "0") }}
                onClick={() => onChange({ ...value, color: c })}
                aria-label={"color " + c.toString(16)}
              />
            ))}
          </div>
        </div>

        <ChipRow label="BUILD" options={BUILDS} value={value.build} onChange={(i) => onChange({ ...value, build: i })} />
        <ChipRow label="HOOD" options={HOODS} value={value.hood} onChange={(i) => onChange({ ...value, hood: i })} />
        <ChipRow label="MARKING" options={MARKINGS} value={value.marking} onChange={(i) => onChange({ ...value, marking: i })} />

        <Slider
          label="HEIGHT" min={HEIGHTS.min} max={HEIGHTS.max} step={0.01}
          value={value.height} fmt={(v) => v.toFixed(2) + "×"}
          onChange={(v) => onChange({ ...value, height: v })}
        />
        <Slider
          label="GLOW STRENGTH" min={EMISSIVE.min} max={EMISSIVE.max} step={0.01}
          value={value.emissive} fmt={(v) => Math.round(v * 100) + "%"}
          onChange={(v) => onChange({ ...value, emissive: v })}
        />

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
