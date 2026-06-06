//! WHISPERS — SpacetimeDB module (Rust). MULTI-MATCH / lobby architecture.
//!
//! The nervous system (PRD §2.2/§10). Every game is a `match` row joined by a
//! short code; players, anchors, chat, tethers and Warden actions are all scoped
//! by `match_id`, so thousands of concurrent games run isolated on one DB and
//! clients subscribe filtered to their own match.
//!
//! THE TRUST SECRET (PRD §5.2): a forged message is just a normal `chat_message`
//! row stamped with the victim's identity by the privileged `warden_mimic`
//! reducer. No `forged` column exists, so clients provably cannot distinguish it;
//! only line-of-sight (client-side) exposes it. Each `match` carries its own
//! Warden claim (stale-takeover so a crashed Warden never locks a game).

use spacetimedb::{Identity, ReducerContext, Table, Timestamp};

// ============================================================
//  TABLES
// ============================================================

/// A game instance. Players join by `code`. Carries its own clock + Warden claim.
#[spacetimedb::table(accessor = game_match, public)]
pub struct GameMatch {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub code: String,           // short join code, e.g. "X7K2" (looked up via scan)
    pub state: String,          // "lobby" | "playing" | "won" | "lost"
    pub time_left: f32,
    pub phase: u8,
    pub anchors_placed: u8,
    pub exit_open: bool,
    pub warden_identity: Option<Identity>,
    pub warden_last_action: Timestamp,
    pub created_at: Timestamp,
}

/// One row per connected human. `match_id` None = sitting in the lobby.
#[spacetimedb::table(accessor = player, public)]
pub struct Player {
    #[primary_key]
    pub identity: Identity,
    pub name: String,
    pub color: u32,
    #[index(btree)]
    pub match_id: u64,          // 0 = lobby (not in a match)
    pub x: f32,
    pub z: f32,
    pub yaw: f32,
    pub state: String,          // "active" | "absorbed"
    pub carrying_anchor_id: Option<u64>,
    pub last_seen: Timestamp,
    // ----- avatar columns (ADDITIVE; defaulted at every insert) -----
    pub build: u8,              // body build index (BUILDS)
    pub hood: u8,               // headwear index (HOODS)
    pub marking: u8,            // marking/sigil index (MARKINGS)
    pub emissive_intensity: f32,// glow strength
    pub height: f32,            // height scale
}

/// Username+PIN account. ADDITIVE, self-contained auth that binds a chosen
/// username -> avatar profile -> the caller's current connection `identity`.
/// `public` so the client can subscribe to its own row (where identity == me);
/// `pin_hash`/`salt` are exposed to subscribers but the hash is non-reversible
/// and the where-clause keeps each client to its own row — acceptable for a
/// self-contained game PIN with no real-world value.
#[spacetimedb::table(accessor = account, public)]
pub struct Account {
    #[primary_key]
    pub username: String,
    pub pin_hash: String,
    pub salt: String,
    #[index(btree)]
    pub identity: Identity,
    pub name: String,
    pub color: u32,
    pub build: u8,
    pub hood: u8,
    pub marking: u8,
    pub emissive_intensity: f32,
    pub height: f32,
    pub created: Timestamp,
}

/// Which identities have finished avatar creation. A SEPARATE table (not an
/// account column) so the schema change is a clean additive migration — adding a
/// brand-new table never requires backfilling/defaulting existing rows.
#[spacetimedb::table(accessor = avatar_done, public)]
pub struct AvatarDone {
    #[primary_key]
    pub identity: Identity,
}

/// Anchors — real or fake (the Warden's lure). Scoped to a match.
#[spacetimedb::table(accessor = anchor, public)]
pub struct Anchor {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub match_id: u64,
    pub kind: String,           // "real" | "fake"
    pub x: f32,
    pub z: f32,
    pub carried_by: Option<Identity>,
    pub placed: bool,
}

/// Chat rows, scoped to a match. A forged row is identical to a real one.
#[spacetimedb::table(accessor = chat_message, public)]
pub struct ChatMessage {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub match_id: u64,
    pub sender: Identity,
    pub sender_name: String,
    pub sender_color: u32,
    pub text: String,
    pub created_at: Timestamp,
}

/// A tether where an absorbed teammate can be pulled back (PRD §5.4).
#[spacetimedb::table(accessor = tether, public)]
pub struct Tether {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub match_id: u64,
    pub absorbed: Identity,
    pub x: f32,
    pub z: f32,
}

/// Append-only Warden action log per match — clients read it to fire FX.
///
/// NON-public as of the indistinguishability pass: the legacy path carried a
/// victim NAME in `target` and broadcast Warden intent (DISTORT/MANIFEST) to
/// every subscribed client, a clean "the Warden just acted on <name> now" tell.
/// MANIFEST/legacy FX still write here, but the rows are no longer streamed to
/// game clients. Location-only FX migrated to the public `world_event` table.
/// (Dropping `public` is an access-modifier change, NOT a column change — clean
/// additive migration, no --delete-data.)
#[spacetimedb::table(accessor = warden_action)]
pub struct WardenAction {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub match_id: u64,
    pub action_type: String,
    pub target: String,
    pub created_at: Timestamp,
}

/// Warden claim, per match. NON-public: never streamed to game clients, so
/// who/whether a Warden exists is invisible. Replaces game_match.warden_*.
/// (Brand-new table = clean additive migration.)
#[spacetimedb::table(accessor = warden_seat)]
pub struct WardenSeat {
    #[primary_key]
    pub match_id: u64,
    pub warden_identity: Identity,
    pub last_action: Timestamp,
}

/// Public, LOCATION-ONLY FX trigger. Carries NO identity / victim name and NO
/// 'forged' flag — a client cannot tell which player (if any) an event concerns,
/// nor whether it was Warden-driven. The client distance-gates rendering, so an
/// unaffected player perceives nothing and there is no row-presence signal to
/// cross-reference. This is the spine of all non-chat deception FX. A row says
/// only "something happened at (x,z)". (Brand-new table = clean additive.)
#[spacetimedb::table(accessor = world_event, public)]
pub struct WorldEvent {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub match_id: u64,
    pub kind: String,   // "ghost_step" | "phantom_anchor" | "distort" | "MANIFEST" | ...  (NEVER "MIMIC")
    pub x: f32,
    pub z: f32,
    pub created_at: Timestamp,
}

// ============================================================
//  HELPERS
// ============================================================

const NAMES: [&str; 8] = ["Mara", "Cass", "Ezra", "Wren", "Sol", "Vale", "Juno", "Rook"];
const COLORS: [u32; 8] = [0xff9a5c, 0xffc46b, 0xff7a8a, 0xffd27a, 0xc98bff, 0x7ad1ff, 0x8affc4, 0xff6f5e];
const CODE_ALPHA: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous chars
const WARDEN_STALE_MICROS: i64 = 30_000_000; // 30s

/// Shared secret gating `claim_warden`. The module WASM is server-side only and
/// never downloaded by browsers, so a module const is not client-visible.
/// `option_env!` keeps the secret in the CI/build env (not source control) when
/// set, with a non-empty fallback so the module still builds locally without it.
/// The Warden client passes this via a NON-`VITE_` env var (never bundled into
/// the web client), so ordinary players cannot claim, mimic, or absorb — and a
/// wrong/absent secret is a silent no-op that reveals nothing about seat state.
const WARDEN_SECRET: &str = match option_env!("WARDEN_SECRET") {
    Some(s) => s,
    None => "whispers-warden-9f3c1a7e6b2d4f80a5c9e1d3b7f02468",
};

// ----- avatar column defaults (mirror DEFAULT_AVATAR in web/src/avatar.ts) ----
const DEF_BUILD: u8 = 1;
const DEF_HOOD: u8 = 0;
const DEF_MARKING: u8 = 0;
const DEF_EMISSIVE: f32 = 0.45;
const DEF_HEIGHT: f32 = 1.0;

// ----- auth helpers (self-contained; deterministic inside the WASM module) -----

/// sha256(salt + pin), hex-encoded. Uses the `sha2` crate which is no_std-clean
/// and deterministic — safe inside a reducer.
fn hash_pin(salt: &str, pin: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(salt.as_bytes());
    h.update(pin.as_bytes());
    hex::encode(h.finalize())
}

/// Random 16-byte salt from the module's deterministic RNG (NOT std rand).
fn gen_salt(ctx: &ReducerContext) -> String {
    let mut bytes = [0u8; 16];
    for b in bytes.iter_mut() {
        *b = ctx.random::<u8>();
    }
    hex::encode(bytes)
}

/// username: 3..=16 chars, ASCII alphanumeric or underscore.
fn valid_username(u: &str) -> bool {
    let n = u.chars().count();
    n >= 3 && n <= 16 && u.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// pin: 4..=6 ASCII digits.
fn valid_pin(p: &str) -> bool {
    let n = p.chars().count();
    n >= 4 && n <= 6 && p.chars().all(|c| c.is_ascii_digit())
}

// Name/color: first free among players IN THE SAME MATCH.
fn assign_identity(ctx: &ReducerContext, match_id: u64) -> (String, u32) {
    let used: Vec<String> = ctx.db.player().match_id().filter(match_id).map(|p| p.name).collect();
    for (i, n) in NAMES.iter().enumerate() {
        if !used.iter().any(|u| u == n) {
            return ((*n).to_string(), COLORS[i]);
        }
    }
    let n = used.len();
    (format!("Lost-{}", n), COLORS[n % COLORS.len()])
}

fn gen_code(ctx: &ReducerContext) -> String {
    for _ in 0..12 {
        let mut n: u32 = ctx.random();
        let mut s = String::new();
        for _ in 0..4 {
            s.push(CODE_ALPHA[(n as usize) % CODE_ALPHA.len()] as char);
            n /= CODE_ALPHA.len() as u32;
        }
        if !ctx.db.game_match().iter().any(|m| m.code == s) {
            return s;
        }
    }
    format!("{}", ctx.timestamp.to_micros_since_unix_epoch() % 100000)
}

fn seed_anchors(ctx: &ReducerContext, match_id: u64) {
    let reals = [(0.0f32, -30.0f32), (-34.0, 5.0), (34.0, 5.0)];
    for (x, z) in reals {
        ctx.db.anchor().insert(Anchor { id: 0, match_id, kind: "real".to_string(), x, z, carried_by: None, placed: false });
    }
    ctx.db.anchor().insert(Anchor { id: 0, match_id, kind: "fake".to_string(), x: 12.0, z: -18.0, carried_by: None, placed: false });
}

/// Warden authority now lives in the NON-public `warden_seat` table, keyed by
/// match_id. Signature unchanged so every caller compiles untouched; it simply
/// no longer reads `m.warden_identity` (that column is frozen at None forever).
fn is_warden_of(ctx: &ReducerContext, m: &GameMatch) -> bool {
    ctx.db
        .warden_seat()
        .match_id()
        .find(m.id)
        .map(|s| s.warden_identity == ctx.sender())
        .unwrap_or(false)
}

// ----- world geometry / line-of-sight (ported verbatim from web/src/world.ts) -
// Used server-side so the Warden's board edits (CORRUPT_ITEM) can verify that a
// relocation is UNOBSERVED — a visible teleport would be a tell. Walls are the
// same axis-aligned footprints the client uses for occlusion (PRD §5.1).

/// (x, z, w, d) wall footprints — MUST stay in sync with WALLS in world.ts.
const WALLS: [(f32, f32, f32, f32); 20] = [
    // outer boundary (arena)
    (0.0, -35.0, 80.0, 1.2), (0.0, 35.0, 80.0, 1.2),
    (-40.0, 0.0, 1.2, 72.0), (40.0, 0.0, 1.2, 72.0),
    // central hub partial walls
    (-9.0, -10.0, 14.0, 1.0), (9.0, -10.0, 14.0, 1.0),
    (-16.0, 0.0, 1.0, 22.0), (16.0, 0.0, 1.0, 22.0),
    // north satellite room
    (-22.0, -24.0, 1.0, 18.0), (22.0, -24.0, 1.0, 18.0),
    (-13.0, -33.0, 18.0, 1.0), (13.0, -33.0, 18.0, 1.0),
    // west satellite room
    (-30.0, -6.0, 16.0, 1.0), (-30.0, 14.0, 16.0, 1.0), (-38.0, 4.0, 1.0, 18.0),
    // east satellite room
    (30.0, -6.0, 16.0, 1.0), (30.0, 14.0, 16.0, 1.0), (38.0, 4.0, 1.0, 18.0),
    // inner baffles that break sightlines (make mimicry bite)
    (-6.0, 18.0, 12.0, 1.0), (10.0, -22.0, 1.0, 12.0),
];

const SEE_DIST: f32 = 22.0;
// cos(58°) half-cone, matching SEE_FOV in world.ts.
const SEE_FOV: f32 = 0.529_919_27;

/// slab method: does segment a->b intersect wall AABB (x, z, w, d)?
fn seg_hits_box(ax: f32, az: f32, bx: f32, bz: f32, wall: (f32, f32, f32, f32)) -> bool {
    let (wx, wz, ww, wd) = wall;
    let minx = wx - ww / 2.0;
    let maxx = wx + ww / 2.0;
    let minz = wz - wd / 2.0;
    let maxz = wz + wd / 2.0;
    let mut t0 = 0.0f32;
    let mut t1 = 1.0f32;
    let dx = bx - ax;
    let dz = bz - az;
    let edges = [(-dx, ax - minx), (dx, maxx - ax), (-dz, az - minz), (dz, maxz - az)];
    for (p, q) in edges {
        if p.abs() < 1e-9 {
            if q < 0.0 { return false; }
        } else {
            let t = q / p;
            if p < 0.0 {
                if t > t1 { return false; }
                if t > t0 { t0 = t; }
            } else {
                if t < t0 { return false; }
                if t < t1 { t1 = t; }
            }
        }
    }
    t0 <= t1
}

fn has_line_of_sight(ax: f32, az: f32, bx: f32, bz: f32) -> bool {
    !WALLS.iter().any(|&w| seg_hits_box(ax, az, bx, bz, w))
}

/// Can a viewer at (px,pz) facing yaw SEE world point (tx,tz)? range + FOV + occlusion.
fn can_see(px: f32, pz: f32, yaw: f32, tx: f32, tz: f32) -> bool {
    let dx = tx - px;
    let dz = tz - pz;
    let dist = (dx * dx + dz * dz).sqrt();
    if dist > SEE_DIST { return false; }
    if dist < 0.001 { return true; }
    let fwdx = yaw.sin();
    let fwdz = yaw.cos();
    let dot = (dx / dist) * fwdx + (dz / dist) * fwdz;
    if dot < SEE_FOV { return false; }
    has_line_of_sight(px, pz, tx, tz)
}

/// True if ANY active player in the match can currently see world point (x,z).
fn point_observed(ctx: &ReducerContext, match_id: u64, x: f32, z: f32) -> bool {
    ctx.db
        .player()
        .match_id()
        .filter(match_id)
        .any(|p| p.state == "active" && can_see(p.x, p.z, p.yaw, x, z))
}

// ============================================================
//  LIFECYCLE
// ============================================================

#[spacetimedb::reducer(init)]
pub fn init(_ctx: &ReducerContext) {
    log::info!("WHISPERS module initialized (multi-match)");
}

#[spacetimedb::reducer(client_connected)]
pub fn on_connect(ctx: &ReducerContext) {
    if ctx.db.player().identity().find(ctx.sender()).is_some() {
        return;
    }
    // join the lobby (no match yet); name is assigned on match join
    ctx.db.player().insert(Player {
        identity: ctx.sender(), name: "wanderer".to_string(), color: 0xffb066,
        match_id: 0, x: 0.0, z: 26.0, yaw: 0.0,
        state: "active".to_string(), carrying_anchor_id: None, last_seen: ctx.timestamp,
        build: DEF_BUILD, hood: DEF_HOOD, marking: DEF_MARKING,
        emissive_intensity: DEF_EMISSIVE, height: DEF_HEIGHT,
    });
}

#[spacetimedb::reducer(client_disconnected)]
pub fn on_disconnect(ctx: &ReducerContext) {
    // free tethers held for this player
    let mine: Vec<u64> = ctx.db.tether().iter().filter(|t| t.absorbed == ctx.sender()).map(|t| t.id).collect();
    for id in mine { ctx.db.tether().id().delete(id); }
    // release carried anchor
    if let Some(p) = ctx.db.player().identity().find(ctx.sender()) {
        if let Some(aid) = p.carrying_anchor_id {
            if let Some(a) = ctx.db.anchor().id().find(aid) {
                ctx.db.anchor().id().update(Anchor { carried_by: None, ..a });
            }
        }
    }
    ctx.db.player().identity().delete(ctx.sender());
}

// ============================================================
//  LOBBY REDUCERS
// ============================================================

#[spacetimedb::reducer]
pub fn set_name(ctx: &ReducerContext, name: String) {
    if let Some(p) = ctx.db.player().identity().find(ctx.sender()) {
        let name = name.chars().take(16).collect::<String>();
        ctx.db.player().identity().update(Player { name, ..p });
    }
}

// ============================================================
//  ACCOUNT / AUTH REDUCERS (self-contained username + PIN)
// ============================================================

/// Register a new account, binding `username` -> the caller's current identity.
/// Validates and early-returns on bad input or a taken username (never panics).
/// Snapshots the caller's current Player avatar into the account so a later
/// login can restore it. On success the client's me-row subscription
/// (account.where identity == me) flips, which is how the client detects auth.
#[spacetimedb::reducer]
pub fn register_account(ctx: &ReducerContext, username: String, pin: String) {
    let username = username.trim().to_string();
    if !valid_username(&username) || !valid_pin(&pin) {
        return;
    }
    // username is the PK — reject if already taken (no panic).
    if ctx.db.account().username().find(&username).is_some() {
        return;
    }
    let salt = gen_salt(ctx);
    let pin_hash = hash_pin(&salt, &pin);
    // DEFAULT display name = the username (overrides the on_connect "wanderer").
    // Snapshot the caller's current avatar (or defaults if no player row yet).
    let p = ctx.db.player().identity().find(ctx.sender());
    let name = username.clone();
    let (color, build, hood, marking, emissive_intensity, height) = match &p {
        Some(p) => (p.color, p.build, p.hood, p.marking, p.emissive_intensity, p.height),
        None => (COLORS[0], DEF_BUILD, DEF_HOOD, DEF_MARKING, DEF_EMISSIVE, DEF_HEIGHT),
    };
    // Write the username onto the caller's live Player row so me?.name shows it
    // immediately (still editable later via set_name).
    if let Some(p) = p {
        ctx.db.player().identity().update(Player { name: name.clone(), ..p });
    }
    ctx.db.account().insert(Account {
        username, pin_hash, salt, identity: ctx.sender(),
        name, color, build, hood, marking, emissive_intensity, height,
        created: ctx.timestamp,
    });
}

/// Log into an existing account. On a correct PIN, REBIND the account's
/// `identity` column to the caller's current connection identity and mirror the
/// saved avatar/name onto the caller's Player row. Wrong PIN / unknown user is a
/// silent no-op (client watchdog surfaces the error). Never panics.
#[spacetimedb::reducer]
pub fn login_account(ctx: &ReducerContext, username: String, pin: String) {
    let username = username.trim().to_string();
    if !valid_username(&username) || !valid_pin(&pin) {
        return;
    }
    let acc = match ctx.db.account().username().find(&username) {
        Some(a) => a,
        None => return,
    };
    if hash_pin(&acc.salt, &pin) != acc.pin_hash {
        return; // wrong PIN — silent no-op
    }
    // Snapshot the avatar/name to mirror onto the Player row.
    let (name, color, build, hood, marking, emissive_intensity, height) =
        (acc.name.clone(), acc.color, acc.build, acc.hood, acc.marking, acc.emissive_intensity, acc.height);
    // Rebind the account to the caller's current connection identity.
    ctx.db.account().username().update(Account { identity: ctx.sender(), ..acc });
    // Mirror saved avatar/name onto the caller's Player row.
    if let Some(p) = ctx.db.player().identity().find(ctx.sender()) {
        ctx.db.player().identity().update(Player {
            name, color, build, hood, marking, emissive_intensity, height, ..p
        });
    }
}

/// Update the caller's avatar. Writes BOTH the Player row and (if the caller is
/// logged in) the caller's account row so the look persists across sessions.
#[spacetimedb::reducer]
pub fn set_avatar(
    ctx: &ReducerContext,
    color: u32,
    build: u8,
    hood: u8,
    marking: u8,
    emissive_intensity: f32,
    height: f32,
) {
    if let Some(p) = ctx.db.player().identity().find(ctx.sender()) {
        ctx.db.player().identity().update(Player {
            color, build, hood, marking, emissive_intensity, height, ..p
        });
    }
    // Mirror onto the caller's account row, if any (identity is btree-indexed).
    let mine: Vec<Account> = ctx.db.account().identity().filter(ctx.sender()).collect();
    for acc in mine {
        ctx.db.account().username().update(Account {
            color, build, hood, marking, emissive_intensity, height,
            ..acc
        });
    }
    // Mark avatar creation complete (idempotent — PK on identity).
    if ctx.db.avatar_done().identity().find(ctx.sender()).is_none() {
        ctx.db.avatar_done().insert(AvatarDone { identity: ctx.sender() });
    }
}

/// Create a new match, seed its anchors, and join it. Returns nothing; the
/// client reads its own player.match_id + the match row.
#[spacetimedb::reducer]
pub fn create_match(ctx: &ReducerContext) {
    let p = match ctx.db.player().identity().find(ctx.sender()) { Some(p) => p, None => return };
    let code = gen_code(ctx);
    let m = ctx.db.game_match().insert(GameMatch {
        id: 0, code, state: "lobby".to_string(), time_left: 600.0, phase: 1,
        anchors_placed: 0, exit_open: false, warden_identity: None,
        warden_last_action: ctx.timestamp, created_at: ctx.timestamp,
    });
    seed_anchors(ctx, m.id);
    let (name, color) = assign_identity(ctx, m.id);
    ctx.db.player().identity().update(Player {
        match_id: m.id, name, color, x: 0.0, z: 26.0, state: "active".to_string(),
        carrying_anchor_id: None, ..p
    });
}

#[spacetimedb::reducer]
pub fn join_match(ctx: &ReducerContext, code: String) -> Result<(), String> {
    let p = ctx.db.player().identity().find(ctx.sender()).ok_or("no player")?;
    let code = code.trim().to_uppercase();
    let m = ctx.db.game_match().iter().find(|m| m.code == code).ok_or("no such match")?;
    let (name, color) = assign_identity(ctx, m.id);
    ctx.db.player().identity().update(Player {
        match_id: m.id, name, color, x: 0.0, z: 26.0, state: "active".to_string(),
        carrying_anchor_id: None, ..p
    });
    Ok(())
}

#[spacetimedb::reducer]
pub fn leave_match(ctx: &ReducerContext) {
    if let Some(p) = ctx.db.player().identity().find(ctx.sender()) {
        ctx.db.player().identity().update(Player { match_id: 0, carrying_anchor_id: None, ..p });
    }
}

#[spacetimedb::reducer]
pub fn start_match(ctx: &ReducerContext) {
    if let Some(p) = ctx.db.player().identity().find(ctx.sender()) {
        if p.match_id != 0 {
            if let Some(m) = ctx.db.game_match().id().find(p.match_id) {
                if m.state == "lobby" {
                    ctx.db.game_match().id().update(GameMatch { state: "playing".to_string(), ..m });
                }
            }
        }
    }
}

// ============================================================
//  IN-MATCH PLAYER REDUCERS
// ============================================================

#[spacetimedb::reducer]
pub fn move_player(ctx: &ReducerContext, x: f32, z: f32, yaw: f32) {
    // SERVER-AUTHORITATIVE: the client may only move. `state` (active/absorbed) and
    // `carrying_anchor_id` are owned by absorb/rescue/pickup/place and preserved via
    // the row spread (..p), so a 15Hz move tick can no longer un-absorb a player or
    // silently drop a carry (the two bugs that broke the absorb + carry loops).
    if let Some(p) = ctx.db.player().identity().find(ctx.sender()) {
        ctx.db.player().identity().update(Player { x, z, yaw, last_seen: ctx.timestamp, ..p });
    }
}

#[spacetimedb::reducer]
pub fn send_chat(ctx: &ReducerContext, text: String) {
    let p = match ctx.db.player().identity().find(ctx.sender()) { Some(p) => p, None => return };
    let mid = p.match_id;
    if mid == 0 { return; }
    let text = text.chars().take(240).collect::<String>();
    if text.trim().is_empty() { return; }
    ctx.db.chat_message().insert(ChatMessage {
        id: 0, match_id: mid, sender: ctx.sender(), sender_name: p.name, sender_color: p.color,
        text, created_at: ctx.timestamp,
    });
}

#[spacetimedb::reducer]
pub fn pickup_anchor(ctx: &ReducerContext, anchor_id: u64) {
    let p = match ctx.db.player().identity().find(ctx.sender()) { Some(p) => p, None => return };
    let a = match ctx.db.anchor().id().find(anchor_id) { Some(a) => a, None => return };
    if a.match_id != p.match_id || a.placed || a.carried_by.is_some() { return; }
    ctx.db.anchor().id().update(Anchor { carried_by: Some(ctx.sender()), ..a });
    ctx.db.player().identity().update(Player { carrying_anchor_id: Some(anchor_id), ..p });
}

#[spacetimedb::reducer]
pub fn place_anchor(ctx: &ReducerContext, anchor_id: u64) {
    let p = match ctx.db.player().identity().find(ctx.sender()) { Some(p) => p, None => return };
    let a = match ctx.db.anchor().id().find(anchor_id) { Some(a) => a, None => return };
    if a.carried_by != Some(ctx.sender()) { return; }
    let mid = a.match_id;
    ctx.db.player().identity().update(Player { carrying_anchor_id: None, ..p });
    let m = match ctx.db.game_match().id().find(mid) { Some(m) => m, None => return };
    if a.kind == "fake" {
        ctx.db.anchor().id().update(Anchor { carried_by: None, ..a });
        ctx.db.game_match().id().update(GameMatch { state: "lost".to_string(), ..m });
        return;
    }
    ctx.db.anchor().id().update(Anchor { carried_by: None, placed: true, ..a });
    let placed = m.anchors_placed + 1;
    let exit = placed >= 3;
    // The loop was UNWINNABLE: exit_open was set but no reducer ever set "won".
    // Placing the final real anchor opens the way AND completes the escape.
    let state = if exit { "won".to_string() } else { m.state.clone() };
    ctx.db.game_match().id().update(GameMatch { anchors_placed: placed, exit_open: exit, state, ..m });
}

#[spacetimedb::reducer]
pub fn rescue(ctx: &ReducerContext, tether_id: u64) {
    let t = match ctx.db.tether().id().find(tether_id) { Some(t) => t, None => return };
    if let Some(v) = ctx.db.player().identity().find(t.absorbed) {
        ctx.db.player().identity().update(Player { state: "active".to_string(), ..v });
    }
    ctx.db.tether().id().delete(tether_id);
}

// ============================================================
//  WARDEN (privileged client) REDUCERS — per match
// ============================================================

/// Claim (or refresh / stale-take-over) the Warden seat for a match. Gated by a
/// shared `secret`: a wrong/absent secret is a SILENT no-op, so an ordinary
/// player cannot claim the seat OR probe whether one exists (the seat lives in
/// the NON-public `warden_seat` table and is never streamed to game clients).
/// game_match.warden_* is NO LONGER touched — the seat lives entirely here.
#[spacetimedb::reducer]
pub fn claim_warden(ctx: &ReducerContext, match_id: u64, secret: String) {
    if secret != WARDEN_SECRET { return; } // silent: no client can observe timing here
    if ctx.db.game_match().id().find(match_id).is_none() { return; }
    match ctx.db.warden_seat().match_id().find(match_id) {
        None => {
            ctx.db.warden_seat().insert(WardenSeat {
                match_id,
                warden_identity: ctx.sender(),
                last_action: ctx.timestamp,
            });
        }
        Some(seat) => {
            let age = ctx.timestamp.to_micros_since_unix_epoch()
                - seat.last_action.to_micros_since_unix_epoch();
            let stale = age > WARDEN_STALE_MICROS;
            if seat.warden_identity == ctx.sender() || stale {
                ctx.db.warden_seat().match_id().update(WardenSeat {
                    warden_identity: ctx.sender(),
                    last_action: ctx.timestamp,
                    ..seat
                });
            }
        }
    }
}

#[spacetimedb::reducer]
pub fn warden_heartbeat(ctx: &ReducerContext, match_id: u64) {
    if let Some(seat) = ctx.db.warden_seat().match_id().find(match_id) {
        if seat.warden_identity == ctx.sender() {
            ctx.db.warden_seat().match_id().update(WardenSeat { last_action: ctx.timestamp, ..seat });
        }
    }
}

/// Keep the seat fresh after a successful Warden action (replaces the old
/// game_match.warden_last_action heartbeat write).
fn touch_seat(ctx: &ReducerContext, match_id: u64) {
    if let Some(seat) = ctx.db.warden_seat().match_id().find(match_id) {
        ctx.db.warden_seat().match_id().update(WardenSeat { last_action: ctx.timestamp, ..seat });
    }
}

#[spacetimedb::reducer]
pub fn warden_mimic(ctx: &ReducerContext, match_id: u64, victim: Identity, text: String) {
    let m = match ctx.db.game_match().id().find(match_id) { Some(m) => m, None => return };
    if !is_warden_of(ctx, &m) { return; }
    let v = match ctx.db.player().identity().find(victim) { Some(v) => v, None => return };
    if v.match_id != match_id { return; }
    // NO warden_action row for MIMIC: a public warden_action would reveal to any
    // subscribed client that this message was forged (and name the victim),
    // defeating the core deception. The forged chat_message must be
    // indistinguishable from a real one — trust breaks only via line-of-sight.
    ctx.db.chat_message().insert(ChatMessage {
        id: 0, match_id, sender: victim, sender_name: v.name, sender_color: v.color,
        text: text.chars().take(240).collect(), created_at: ctx.timestamp,
    });
    touch_seat(ctx, match_id);
}

/// Legacy / MANIFEST FX entrypoint. The phase is still public on game_match
/// (FX scaling needs it). DISTORT is migrating off this path to the location-only
/// `world_event` table (see `warden_event`); MANIFEST also emits a location-only
/// world_event so the client never reads a victim name out of `target`.
/// `warden_action` is kept (now NON-public) for any legacy consumers but is no
/// longer streamed to game clients. game_match.warden_last_action is NO LONGER
/// written — the seat clock lives in `warden_seat`.
#[spacetimedb::reducer]
pub fn warden_act(ctx: &ReducerContext, match_id: u64, action_type: String, target: String, phase: u8) {
    let m = match ctx.db.game_match().id().find(match_id) { Some(m) => m, None => return };
    if !is_warden_of(ctx, &m) { return; }
    ctx.db.warden_action().insert(WardenAction {
        id: 0, match_id, action_type: action_type.clone(), target, created_at: ctx.timestamp,
    });
    // phase still public/needed for FX scaling; warden_last_action no longer touched.
    ctx.db.game_match().id().update(GameMatch { phase, ..m });
    touch_seat(ctx, match_id);
}

/// Location-only deception FX. Warden-only. Inserts ONE `world_event` row at
/// (x,z) with a `kind` tag and NOTHING that identifies a victim. The three
/// pure-FX actions (GHOST_STEP -> "ghost_step", REVEAL_FALSE -> "phantom_anchor",
/// DISTORT_ROOM -> "distort") all flow through here; the client distance-gates
/// rendering so only nearby players ever perceive the event.
#[spacetimedb::reducer]
pub fn warden_event(ctx: &ReducerContext, match_id: u64, kind: String, x: f32, z: f32) {
    let m = match ctx.db.game_match().id().find(match_id) { Some(m) => m, None => return };
    if !is_warden_of(ctx, &m) { return; }
    // Guard: MIMIC must never ride the public world_event spine.
    if kind == "MIMIC" { return; }
    ctx.db.world_event().insert(WorldEvent {
        id: 0, match_id, kind, x, z, created_at: ctx.timestamp,
    });
    touch_seat(ctx, match_id);
}

/// SPAWN_LURE: drop a brand-new FAKE anchor (unplaced) near a target. The
/// existing place_anchor fake->LOST path pays it off untouched, and the minimap
/// deliberately does NOT distinguish real/fake unplaced anchors, so this reads as
/// a real objective. Warden-only.
#[spacetimedb::reducer]
pub fn warden_spawn_lure(ctx: &ReducerContext, match_id: u64, x: f32, z: f32) {
    let m = match ctx.db.game_match().id().find(match_id) { Some(m) => m, None => return };
    if !is_warden_of(ctx, &m) { return; }
    ctx.db.anchor().insert(Anchor {
        id: 0, match_id, kind: "fake".to_string(), x, z, carried_by: None, placed: false,
    });
    touch_seat(ctx, match_id);
}

/// CORRUPT_ITEM: silently RELOCATE an unplaced, uncarried REAL anchor to (x,z) —
/// but ONLY if NO active player in the match can currently see EITHER its old or
/// its new position. A visible teleport would be a tell, so an observed move is a
/// no-op. The team's mental map silently goes wrong. Warden-only.
#[spacetimedb::reducer]
pub fn warden_corrupt_anchor(ctx: &ReducerContext, match_id: u64, anchor_id: u64, x: f32, z: f32) {
    let m = match ctx.db.game_match().id().find(match_id) { Some(m) => m, None => return };
    if !is_warden_of(ctx, &m) { return; }
    let a = match ctx.db.anchor().id().find(anchor_id) { Some(a) => a, None => return };
    // Must be an unplaced, uncarried REAL anchor in THIS match.
    if a.match_id != match_id || a.placed || a.carried_by.is_some() || a.kind != "real" { return; }
    // The move must be unobserved at BOTH endpoints or it's a visible teleport.
    if point_observed(ctx, match_id, a.x, a.z) { return; }
    if point_observed(ctx, match_id, x, z) { return; }
    ctx.db.anchor().id().update(Anchor { x, z, ..a });
    touch_seat(ctx, match_id);
}

#[spacetimedb::reducer]
pub fn absorb(ctx: &ReducerContext, match_id: u64, victim: Identity) {
    let m = match ctx.db.game_match().id().find(match_id) { Some(m) => m, None => return };
    if !is_warden_of(ctx, &m) { return; }
    let v = match ctx.db.player().identity().find(victim) { Some(v) => v, None => return };
    if v.match_id != match_id { return; }
    let (vx, vz) = (v.x, v.z);
    ctx.db.player().identity().update(Player { state: "absorbed".to_string(), ..v });
    ctx.db.tether().insert(Tether { id: 0, match_id, absorbed: victim, x: vx, z: vz });
    touch_seat(ctx, match_id);
}
