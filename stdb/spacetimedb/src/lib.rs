//! WHISPERS — SpacetimeDB module (Rust).
//!
//! The nervous system (PRD §2.2/§10). All shared mutable state lives here:
//! players, world topology, anchors, chat, the Warden's state + action log.
//!
//! THE TRUST SECRET (PRD §5.2): a forged message is just a normal `chat_message`
//! row STAMPED WITH THE VICTIM'S identity/name/color (written by the privileged
//! `warden_mimic` reducer). There is no `forged` column for clients to inspect —
//! the distinction does not exist in any data a player can read, so a forged row
//! is provably indistinguishable; only line-of-sight (client-side) exposes it.
//! The Warden process is the sole keeper of which rows it forged. WASM reducers
//! can't call an LLM, so the Warden runs externally (`claim_warden`/`warden_mimic`).

use spacetimedb::{Identity, ReducerContext, Table, Timestamp};

// ============================================================
//  TABLES
// ============================================================

/// One row per connected human (PRD §10.2 players).
#[spacetimedb::table(accessor = player, public)]
pub struct Player {
    #[primary_key]
    pub identity: Identity,
    pub name: String,
    pub color: u32,
    pub x: f32,
    pub z: f32,
    pub yaw: f32,
    pub room_id: u64,
    pub state: String, // "active" | "absorbed"
    pub carrying_anchor_id: Option<u64>,
    pub last_seen: Timestamp,
}

/// World cells — non-Euclidean topology lives in rooms + room_exits.
#[spacetimedb::table(accessor = room, public)]
pub struct Room {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub template: String,
    pub transform_state: String,
    pub distortion: f32,
}

/// The topology graph. A reshape/seal is a row mutation all clients see.
#[spacetimedb::table(accessor = room_exit, public)]
pub struct RoomExit {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub from_room: u64,
    pub to_room: u64,
    pub direction: String,
    pub sealed: bool,
}

/// Anchors — real or fake (the Warden's lure). Identical until placed (PRD §4.4).
#[spacetimedb::table(accessor = anchor, public)]
pub struct Anchor {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub kind: String, // "real" | "fake"
    pub x: f32,
    pub z: f32,
    pub room_id: u64,
    pub carried_by: Option<Identity>,
    pub placed: bool,
}

/// Chat rows. A forged row is identical to a real one — stamped with the
/// victim's identity/name/color by `warden_mimic`. No `forged` column exists,
/// so clients cannot tell them apart (the integrity guarantee). Only the Warden
/// process knows which rows it wrote.
#[spacetimedb::table(accessor = chat_message, public)]
pub struct ChatMessage {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub sender: Identity,
    pub sender_name: String,
    pub sender_color: u32,
    pub text: String,
    pub room_id: u64,
    pub created_at: Timestamp,
}

/// The Warden's energy/phase + which identity is the privileged Warden client.
#[spacetimedb::table(accessor = warden_state, public)]
pub struct WardenState {
    #[primary_key]
    pub id: u64, // always 0 (single row)
    pub energy: f32,
    pub phase: u8,
    pub manifest_cd: f32,
    pub warden_identity: Option<Identity>,
    pub last_action_at: Timestamp,
}

/// Append-only log of Warden actions — clients read it to fire FX.
#[spacetimedb::table(accessor = warden_action, public)]
pub struct WardenAction {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub action_type: String,
    pub target: String,
    pub room_id: u64,
    pub created_at: Timestamp,
}

/// A tether where an absorbed teammate can be pulled back (PRD §5.4).
#[spacetimedb::table(accessor = tether, public)]
pub struct Tether {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub absorbed: Identity,
    pub x: f32,
    pub z: f32,
    pub room_id: u64,
}

/// Ephemeral world FX log (lightning, reshape, portal cut).
#[spacetimedb::table(accessor = world_event, public)]
pub struct WorldEvent {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub kind: String,
    pub room_id: u64,
    pub description: String,
    pub created_at: Timestamp,
}

/// Single-row match clock + win/lose state.
#[spacetimedb::table(accessor = match_state, public)]
pub struct MatchState {
    #[primary_key]
    pub id: u64, // always 0
    pub time_left: f32,
    pub started: bool,
    pub phase: u8,
    pub anchors_placed: u8,
    pub exit_open: bool,
    pub outcome: String, // "playing" | "won" | "lost"
}

// ============================================================
//  HELPERS
// ============================================================

const NAMES: [&str; 8] = ["Mara", "Cass", "Ezra", "Wren", "Sol", "Vale", "Juno", "Rook"];
const COLORS: [u32; 8] = [
    0xff9a5c, 0xffc46b, 0xff7a8a, 0xffd27a, 0xc98bff, 0x7ad1ff, 0x8affc4, 0xff6f5e,
];

fn assign_name(ctx: &ReducerContext) -> (String, u32) {
    let used: Vec<String> = ctx.db.player().iter().map(|p| p.name).collect();
    for (i, n) in NAMES.iter().enumerate() {
        if !used.iter().any(|u| u == n) {
            return ((*n).to_string(), COLORS[i]);
        }
    }
    let n = ctx.db.player().count();
    (format!("Lost-{}", n), COLORS[(n as usize) % COLORS.len()])
}

fn warden_identity(ctx: &ReducerContext) -> Option<Identity> {
    ctx.db.warden_state().id().find(0).and_then(|w| w.warden_identity)
}

fn is_warden(ctx: &ReducerContext) -> bool {
    warden_identity(ctx) == Some(ctx.sender())
}

// ============================================================
//  LIFECYCLE
// ============================================================

#[spacetimedb::reducer(init)]
pub fn init(ctx: &ReducerContext) {
    ctx.db.match_state().insert(MatchState {
        id: 0, time_left: 600.0, started: false, phase: 1,
        anchors_placed: 0, exit_open: false, outcome: "playing".to_string(),
    });
    ctx.db.warden_state().insert(WardenState {
        id: 0, energy: 3.0, phase: 1, manifest_cd: 0.0,
        warden_identity: None, last_action_at: ctx.timestamp,
    });
    ctx.db.room().insert(Room {
        id: 0, template: "hub".to_string(), transform_state: "A".to_string(), distortion: 0.0,
    });
    // anchors — 3 real + 1 fake, matching the client layout
    let reals = [(0.0f32, -30.0f32), (-34.0, 5.0), (34.0, 5.0)];
    for (x, z) in reals {
        ctx.db.anchor().insert(Anchor {
            id: 0, kind: "real".to_string(), x, z, room_id: 0, carried_by: None, placed: false,
        });
    }
    ctx.db.anchor().insert(Anchor {
        id: 0, kind: "fake".to_string(), x: 12.0, z: -18.0, room_id: 0, carried_by: None, placed: false,
    });
    log::info!("WHISPERS module initialized");
}

#[spacetimedb::reducer(client_connected)]
pub fn on_connect(ctx: &ReducerContext) {
    if ctx.db.player().identity().find(ctx.sender()).is_some() {
        return;
    }
    let (name, color) = assign_name(ctx);
    ctx.db.player().insert(Player {
        identity: ctx.sender(), name, color,
        x: 0.0, z: 26.0, yaw: 0.0, room_id: 0,
        state: "active".to_string(), carrying_anchor_id: None, last_seen: ctx.timestamp,
    });
}

#[spacetimedb::reducer(client_disconnected)]
pub fn on_disconnect(ctx: &ReducerContext) {
    // free any tether for this player
    let mine: Vec<u64> = ctx.db.tether().iter().filter(|t| t.absorbed == ctx.sender()).map(|t| t.id).collect();
    for id in mine {
        ctx.db.tether().id().delete(id);
    }
    // release a carried anchor
    if let Some(p) = ctx.db.player().identity().find(ctx.sender()) {
        if let Some(aid) = p.carrying_anchor_id {
            if let Some(a) = ctx.db.anchor().id().find(aid) {
                ctx.db.anchor().id().update(Anchor { carried_by: None, ..a });
            }
        }
    }
    ctx.db.player().identity().delete(ctx.sender());
    if warden_identity(ctx) == Some(ctx.sender()) {
        if let Some(w) = ctx.db.warden_state().id().find(0) {
            ctx.db.warden_state().id().update(WardenState { warden_identity: None, ..w });
        }
    }
}

// ============================================================
//  PLAYER REDUCERS
// ============================================================

#[spacetimedb::reducer]
pub fn set_name(ctx: &ReducerContext, name: String) {
    if let Some(p) = ctx.db.player().identity().find(ctx.sender()) {
        let name = name.chars().take(16).collect::<String>();
        ctx.db.player().identity().update(Player { name, ..p });
    }
}

#[spacetimedb::reducer]
pub fn move_player(
    ctx: &ReducerContext, x: f32, z: f32, yaw: f32, room_id: u64,
    state: String, carrying_anchor_id: Option<u64>,
) {
    if let Some(p) = ctx.db.player().identity().find(ctx.sender()) {
        ctx.db.player().identity().update(Player {
            x, z, yaw, room_id, state, carrying_anchor_id, last_seen: ctx.timestamp, ..p
        });
    }
}

#[spacetimedb::reducer]
pub fn send_chat(ctx: &ReducerContext, text: String) {
    let p = match ctx.db.player().identity().find(ctx.sender()) { Some(p) => p, None => return };
    let text = text.chars().take(240).collect::<String>();
    if text.trim().is_empty() { return; }
    // A REAL message: stamped with the true sender. (Players cannot stamp another identity.)
    ctx.db.chat_message().insert(ChatMessage {
        id: 0, sender: ctx.sender(), sender_name: p.name, sender_color: p.color,
        text, room_id: p.room_id, created_at: ctx.timestamp,
    });
}

#[spacetimedb::reducer]
pub fn pickup_anchor(ctx: &ReducerContext, anchor_id: u64) {
    let a = match ctx.db.anchor().id().find(anchor_id) { Some(a) => a, None => return };
    if a.placed || a.carried_by.is_some() { return; }
    ctx.db.anchor().id().update(Anchor { carried_by: Some(ctx.sender()), ..a });
    if let Some(p) = ctx.db.player().identity().find(ctx.sender()) {
        ctx.db.player().identity().update(Player { carrying_anchor_id: Some(anchor_id), ..p });
    }
}

#[spacetimedb::reducer]
pub fn place_anchor(ctx: &ReducerContext, anchor_id: u64) {
    let a = match ctx.db.anchor().id().find(anchor_id) { Some(a) => a, None => return };
    if a.carried_by != Some(ctx.sender()) { return; }
    if let Some(p) = ctx.db.player().identity().find(ctx.sender()) {
        ctx.db.player().identity().update(Player { carrying_anchor_id: None, ..p });
    }
    let mut ms = match ctx.db.match_state().id().find(0) { Some(m) => m, None => return };
    if a.kind == "fake" {
        // PRD §4.2: the lure succeeded — loss.
        ms.outcome = "lost".to_string();
        ctx.db.match_state().id().update(ms);
        ctx.db.anchor().id().update(Anchor { carried_by: None, ..a });
        ctx.db.world_event().insert(WorldEvent {
            id: 0, kind: "lure_revealed".to_string(), room_id: a.room_id,
            description: "a fake anchor reached convergence".to_string(), created_at: ctx.timestamp,
        });
        return;
    }
    ctx.db.anchor().id().update(Anchor { carried_by: None, placed: true, ..a });
    ms.anchors_placed += 1;
    if ms.anchors_placed >= 3 { ms.exit_open = true; }
    ctx.db.match_state().id().update(ms);
}

#[spacetimedb::reducer]
pub fn start_match(ctx: &ReducerContext) {
    if let Some(m) = ctx.db.match_state().id().find(0) {
        if !m.started {
            ctx.db.match_state().id().update(MatchState { started: true, ..m });
        }
    }
}

/// Any player can rescue: reach a tether and call this.
#[spacetimedb::reducer]
pub fn rescue(ctx: &ReducerContext, tether_id: u64) {
    let t = match ctx.db.tether().id().find(tether_id) { Some(t) => t, None => return };
    if let Some(v) = ctx.db.player().identity().find(t.absorbed) {
        ctx.db.player().identity().update(Player { state: "active".to_string(), ..v });
    }
    ctx.db.tether().id().delete(tether_id);
}

// ============================================================
//  WARDEN (privileged client) REDUCERS
// ============================================================

// If the live Warden hasn't heartbeat in this long, its claim is considered dead
// and another Warden process may take over. Makes the adversary self-healing.
const WARDEN_STALE_MICROS: i64 = 30_000_000; // 30s

#[spacetimedb::reducer]
pub fn claim_warden(ctx: &ReducerContext) {
    if let Some(w) = ctx.db.warden_state().id().find(0) {
        let age = ctx.timestamp.to_micros_since_unix_epoch() - w.last_action_at.to_micros_since_unix_epoch();
        let stale = age > WARDEN_STALE_MICROS;
        if w.warden_identity.is_none() || w.warden_identity == Some(ctx.sender()) || stale {
            ctx.db.warden_state().id().update(WardenState {
                warden_identity: Some(ctx.sender()), last_action_at: ctx.timestamp, ..w
            });
            log::info!("Warden identity claimed");
        }
    }
}

/// The live Warden bumps this every tick so its claim doesn't go stale.
#[spacetimedb::reducer]
pub fn warden_heartbeat(ctx: &ReducerContext) {
    if let Some(w) = ctx.db.warden_state().id().find(0) {
        if w.warden_identity == Some(ctx.sender()) {
            ctx.db.warden_state().id().update(WardenState { last_action_at: ctx.timestamp, ..w });
        }
    }
}

/// Forge a chat message AS a victim. Privileged: only the registered Warden.
#[spacetimedb::reducer]
pub fn warden_mimic(ctx: &ReducerContext, victim: Identity, text: String) {
    if !is_warden(ctx) { return; } // integrity: players can't forge
    let v = match ctx.db.player().identity().find(victim) { Some(v) => v, None => return };
    let room = v.room_id;
    let name = v.name.clone();
    // forged row: identical shape to a real one, stamped with the victim's identity.
    ctx.db.chat_message().insert(ChatMessage {
        id: 0, sender: victim, sender_name: v.name, sender_color: v.color,
        text: text.chars().take(240).collect(), room_id: room,
        created_at: ctx.timestamp,
    });
    ctx.db.warden_action().insert(WardenAction {
        id: 0, action_type: "MIMIC".to_string(), target: name, room_id: room, created_at: ctx.timestamp,
    });
}

#[spacetimedb::reducer]
pub fn warden_act(ctx: &ReducerContext, action_type: String, target: String, room_id: u64, energy: f32, phase: u8) {
    if !is_warden(ctx) { return; }
    ctx.db.warden_action().insert(WardenAction {
        id: 0, action_type, target, room_id, created_at: ctx.timestamp,
    });
    if let Some(w) = ctx.db.warden_state().id().find(0) {
        ctx.db.warden_state().id().update(WardenState { energy, phase, last_action_at: ctx.timestamp, ..w });
    }
}

#[spacetimedb::reducer]
pub fn seal_corridor(ctx: &ReducerContext, exit_id: u64, sealed: bool) {
    if !is_warden(ctx) { return; }
    if let Some(e) = ctx.db.room_exit().id().find(exit_id) {
        ctx.db.room_exit().id().update(RoomExit { sealed, ..e });
    }
}

#[spacetimedb::reducer]
pub fn spawn_lure(ctx: &ReducerContext, x: f32, z: f32, room_id: u64) {
    if !is_warden(ctx) { return; }
    ctx.db.anchor().insert(Anchor {
        id: 0, kind: "fake".to_string(), x, z, room_id, carried_by: None, placed: false,
    });
}

#[spacetimedb::reducer]
pub fn absorb(ctx: &ReducerContext, victim: Identity) {
    if !is_warden(ctx) { return; }
    let v = match ctx.db.player().identity().find(victim) { Some(v) => v, None => return };
    let (vx, vz, vroom) = (v.x, v.z, v.room_id);
    ctx.db.player().identity().update(Player { state: "absorbed".to_string(), ..v });
    ctx.db.tether().insert(Tether { id: 0, absorbed: victim, x: vx, z: vz, room_id: vroom });
}
