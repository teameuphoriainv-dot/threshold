# Drop kit models here

WHISPERS auto-dresses the world from CC0 modules. Each piece is independent —
add only what you want. Recommended kits: KayKit Dungeon Remastered, Quaternius.

| File         | What it tiles                          | Flag in Kit.tsx |
|--------------|----------------------------------------|-----------------|
| `wall.glb`   | walls along every level footprint      | `KIT.walls`     |
| `floor.glb`  | floor-tile grid over the arena         | `KIT.floor`     |
| `pillar.glb` | pillars at room corners (floor->ceiling)| `KIT.pillars`  |
| `prop.glb`   | scattered debris/roots                 | `KIT.props`     |

## Steps (per file)
1. Download the module as `.glb`.
2. Optimize + place:
   npx @gltf-transform/cli optimize raw.glb web/public/models/wall.glb \
     --compress draco --texture-compress webp --simplify
3. In `web/src/Kit.tsx`: set that piece's flag in `KIT = {...}` to `true`.
   Tune `WALL_MODULE` / `FLOOR_TILE` to the piece's native size if it stretches.

Missing or broken file = safe fallback (walls->boxes, others->nothing).
