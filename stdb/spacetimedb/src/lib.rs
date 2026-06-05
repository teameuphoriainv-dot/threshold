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
#[spacetimedb::table(accessor = warden_action, public)]
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

// ============================================================
//  HELPERS
// ============================================================

const NAMES: [&str; 8] = ["Mara", "Cass", "Ezra", "Wren", "Sol", "Vale", "Juno", "Rook"];
const COLORS: [u32; 8] = [0xff9a5c, 0xffc46b, 0xff7a8a, 0xffd27a, 0xc98bff, 0x7ad1ff, 0x8affc4, 0xff6f5e];
const CODE_ALPHA: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous chars
const WARDEN_STALE_MICROS: i64 = 30_000_000; // 30s

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

fn is_warden_of(ctx: &ReducerContext, m: &GameMatch) -> bool {
    m.warden_identity == Some(ctx.sender())
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
    // Snapshot the caller's current avatar (or defaults if no player row yet).
    let p = ctx.db.player().identity().find(ctx.sender());
    let (name, color, build, hood, marking, emissive_intensity, height) = match &p {
        Some(p) => (p.name.clone(), p.color, p.build, p.hood, p.marking, p.emissive_intensity, p.height),
        None => (username.clone(), COLORS[0], DEF_BUILD, DEF_HOOD, DEF_MARKING, DEF_EMISSIVE, DEF_HEIGHT),
    };
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
            color, build, hood, marking, emissive_intensity, height, ..acc
        });
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
pub fn move_player(ctx: &ReducerContext, x: f32, z: f32, yaw: f32, state: String, carrying_anchor_id: Option<u64>) {
    if let Some(p) = ctx.db.player().identity().find(ctx.sender()) {
        ctx.db.player().identity().update(Player { x, z, yaw, state, carrying_anchor_id, last_seen: ctx.timestamp, ..p });
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
    ctx.db.game_match().id().update(GameMatch { anchors_placed: placed, exit_open: exit, ..m });
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

#[spacetimedb::reducer]
pub fn claim_warden(ctx: &ReducerContext, match_id: u64) {
    if let Some(m) = ctx.db.game_match().id().find(match_id) {
        let age = ctx.timestamp.to_micros_since_unix_epoch() - m.warden_last_action.to_micros_since_unix_epoch();
        let stale = age > WARDEN_STALE_MICROS;
        if m.warden_identity.is_none() || m.warden_identity == Some(ctx.sender()) || stale {
            ctx.db.game_match().id().update(GameMatch { warden_identity: Some(ctx.sender()), warden_last_action: ctx.timestamp, ..m });
        }
    }
}

#[spacetimedb::reducer]
pub fn warden_heartbeat(ctx: &ReducerContext, match_id: u64) {
    if let Some(m) = ctx.db.game_match().id().find(match_id) {
        if is_warden_of(ctx, &m) {
            ctx.db.game_match().id().update(GameMatch { warden_last_action: ctx.timestamp, ..m });
        }
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
}

#[spacetimedb::reducer]
pub fn warden_act(ctx: &ReducerContext, match_id: u64, action_type: String, target: String, phase: u8) {
    let m = match ctx.db.game_match().id().find(match_id) { Some(m) => m, None => return };
    if !is_warden_of(ctx, &m) { return; }
    ctx.db.warden_action().insert(WardenAction { id: 0, match_id, action_type, target, created_at: ctx.timestamp });
    ctx.db.game_match().id().update(GameMatch { phase, warden_last_action: ctx.timestamp, ..m });
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
}
