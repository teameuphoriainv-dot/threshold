# World kit models (LIVE — dark Poly Haven CC0 set)

Auto-wired by `web/src/Kit.tsx`. All CC0 from Poly Haven, optimized
(draco + webp 1k) via gltf-transform.

| File             | Source (Poly Haven) | Slot                          |
|------------------|---------------------|-------------------------------|
| `wall.glb`       | rock_face_02        | tiled cave walls              |
| `pillar.glb`     | dead_quiver_trunk   | dead-tree monoliths (corners) |
| `prop_root.glb`  | single_root         | scattered prop                |
| `prop_roots2.glb`| root_cluster_02     | scattered prop                |
| `prop_stump.glb` | tree_stump_01       | scattered prop                |
| `prop_log.glb`   | dead_tree_trunk_02  | scattered prop                |
| `prop_rock.glb`  | rock_07             | scattered prop                |

Floor stays the PBR alien terrain (`Ground.tsx`), not a kit tile.

## Tuning (in Kit.tsx)
- `KIT = {...}` — toggle walls/floor/pillars/props.
- `WALL_MODULE` — wall piece width (m); smaller = more, narrower segments.
- `PROP_BASE` — base prop size before per-instance variation.
- Pillars uniform-scale to `WALL_H` (9). Walls force DoubleSide (no see-through).

## Add more
npx @gltf-transform/cli optimize raw.glb web/public/models/NAME.glb \
  --compress draco --texture-compress webp --texture-size 1024
Then reference it (single slot) or add to `PROP_MODELS[]`.

Note: draco decoded via drei's CDN decoder at runtime (needs network).

## Character model (rigged player avatar)

`survivor.glb` — wired by `web/src/Character.tsx` (default `<Character>` for the
local + remote players, named `<Character>` for the Customizer preview). A rigged
humanoid with one skin and one walk-cycle clip; the skeleton is cloned per player
(three `SkeletonUtils.clone`) and the clip is full-speed when moving, time-scaled
to a near-frozen idle otherwise. All materials are overridden in code (no source
`map`), so the model's bundled logo texture never renders — the body is recolored
to the shadowed survivor look tinted by each player's `AvatarConfig`.

| File           | Source (Khronos glTF-Sample-Assets) | License   | Attribution            |
|----------------|-------------------------------------|-----------|------------------------|
| `survivor.glb` | CesiumMan                           | CC-BY 4.0 | © 2017, Cesium — CC-BY 4.0 |

Alternative (cleaner license, no trademark): **RiggedFigure** (Khronos
glTF-Sample-Assets, CC-BY 4.0). Same topology; its single clip is a subtle idle
rather than a walk, so locomotion reads less clearly — CesiumMan was chosen for
the real walk cycle, and its trademark texture is fully overridden in code.
