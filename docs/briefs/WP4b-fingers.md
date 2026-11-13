# WP4b — Finger markers + hand weight fractions (coder: Sonnet)

Read first: `docs/coding-rules.md`, `docs/contracts.md` (§3, §4, §8, §21), `resources/skeleton.json`,
`docs/briefs/WP4a-body-markers.md` (WP4a supplies wrist/elbow markers).

Blender's Python has **numpy only (no scipy)**. Geodesics use a hand-written `heapq` Dijkstra.
`mathutils.kdtree.KDTree` is available for neighbour queries.

## Files to create
- `engine/mpm/rig/fingers.py`
- `tests/engine/test_fingers.py`

## API
```python
suggest_finger_markers(objs, body_markers: dict, H: float) -> (markers: dict, warnings: list[str], hand_info: dict)
hand_info_from_markers(objs, joints: dict, H: float) -> dict
hand_weight_fractions(mesh_obj, joints: dict, side: str, hand_info: dict) -> dict[int, dict[str, float]]
```
`hand_info_from_markers` builds the same `hand_info` structure from **given** joints, for when the
user has edited markers. It builds the proxy and geodesics as in steps 2–3, takes the tips as the
proxy vertices nearest each given `<f>_tip`, the knuckles as the given `<f>_0`, and the hand frame per
§4 from the given joints, with `fallback = False`. The rig job (WP4c) always uses this.
- `markers`: for each side, the editable finger joints `thumb_0, thumb_tip, index_0, index_tip,
  middle_0, middle_tip, ring_0, ring_tip, pinky_0, pinky_tip` (suffix `_L`/`_R`), in the §4 format
  with `source: "auto"`.
- `hand_info[side]`: the hand proxy (as numpy arrays `verts`, `edges`), the per-vertex
  `dist_from_wrist`, the tip vertex indices, knuckle points, a `fallback` flag, and the hand frame
  (`hand_axis`, `lateral`, `palm_normal`, `hand_width`, per §4). `hand_weight_fractions` uses it.
- The function **never raises**. Failures fall back to the template, with confidence 0.2 and a warning.

## Algorithm (per side s, sign = +1 for L and −1 for R)
1. **Forearm axis**: `a = normalize(wrist − elbow)`.
2. **Hand proxy**:
   - Duplicate every mesh and bisect it with the plane through `wrist − 0.02·H·a` (normal a), keeping
     the hand side.
   - Discard geometry farther than 0.16 H from the wrist.
   - Join, then voxel-remesh at `voxel = 0.0025·H` and keep the largest connected component.
   - Build the graph from the remeshed vertices and edges (edge weight = length).
3. **Geodesics**: Dijkstra from every proxy vertex within `0.01·H` of the cut plane (multi-source,
   distance 0) gives `dist_from_wrist` and the predecessor array.
4. **Tips**: vertex v is a tip candidate if `dist_from_wrist[v] > 0.04·H` and **no vertex with a
   larger distance lies within Euclidean `r = 0.02·H` of v**. Use a KDTree radius query. This rejects
   points partway down a finger, because a vertex nearer the tip is always within r. Keep the 5
   candidates with the largest distance. If fewer than 4 are found, use the **template fallback** for
   the whole hand.
5. **Thumb**: among the tips, the one whose `(tip − wrist)` makes the largest angle with `a`. Then
   `hand_axis = normalize(mean(other tips) − wrist)`.
6. **Finger order**: `lat_thumb` = the component of `(thumb_tip − wrist)` perpendicular to
   `hand_axis`, normalised. Sort the other 4 tips by `dot(tip − wrist, lat_thumb)` descending: index,
   middle, ring, pinky.
7. **Knuckles** (`<f>_0`):
   - Walk the predecessor path from the tip toward the wrist.
   - At each path vertex p, with path direction t (from the next vertex toward the tip), compute the
     cross-section radius `ρ(p)` = the mean distance from p of proxy vertices q with
     `|dot(q − p, t)| < voxel` and `|q − p| < 0.03·H`.
   - Let `ρ_f` be the median ρ over the first 40 % of the path length from the tip.
   - The knuckle is the first path vertex (from the tip) where `ρ > 1.8·ρ_f`, stepped back toward the
     tip by `ρ_f`.
   - For the thumb, `thumb_0 = lerp(that point, wrist, 0.35)`.
   - If no jump is found, use the template knuckle for that finger and confidence 0.4.
8. **Tip marker** = the tip vertex position, moved inward along `−(tip − path point at 2·ρ_f back)`
   by `0.5·ρ_f`, so it sits inside the finger.
9. **Hand frame** (§4), from the found markers, with no extra flipping. The thumb-based ordering in
   step 6 already fixes the side; the tests check the sign.
10. **Confidence**: 1.0 per marker when 5 tips and that finger's knuckle were found; 0.4 for a
    template knuckle; 0.2 under the fallback. Multiply by 0.8 if the 4 fingers' knuckles aren't
    roughly in a row, i.e. the knuckle line spreads out of the palm plane by more than
    `0.25·hand_width`.

**Template fallback**:
- `hl` = the distance from the wrist to the farthest proxy vertex along a (or 0.10 H if there's no
  proxy).
- `l` = the default lateral, `(0, −1, 0)` projected perpendicular to a.
- `n` = the §4 palm normal from a and l.
- These ratios reproduce the WP2 fixture hand exactly:

| joint | template |
|---|---|
| middle_0 | wrist + 0.500·hl·a |
| index_0 | wrist + 0.472·hl·a + 0.139·hl·l |
| ring_0 | wrist + 0.472·hl·a − 0.111·hl·l |
| pinky_0 | wrist + 0.417·hl·a − 0.222·hl·l |
| index_tip | index_0 + 0.444·hl·a |
| middle_tip | middle_0 + 0.500·hl·a |
| ring_tip | ring_0 + 0.472·hl·a |
| pinky_tip | pinky_0 + 0.378·hl·a |
| thumb_0 | wrist + 0.111·hl·a + 0.167·hl·l + 0.083·hl·n |
| thumb_tip | thumb_0 + 0.389·hl·normalize(0.55·a + 0.75·l + 0.35·n) |

## `hand_weight_fractions`
Returns `{mesh_vertex_index: {bone_name: fraction}}` for the mesh vertices in the hand region (beyond
the wrist plane, within 0.16 H). The fractions sum to 1 per vertex, over the bones `hand.s`,
`thumb.01–03.s`, `index…`, `middle…`, `ring…`, `pinky….01–03.s`.
1. Multi-source Dijkstra on the hand proxy from the 5 tip vertices at once. Each proxy vertex is
   labelled with the finger of its nearest tip.
2. A proxy vertex belongs to its finger if `dist_from_wrist[v] ≥ dist_from_wrist[knuckle_f] − 0.25·L_f`,
   where `L_f = |tip − knuckle|`; otherwise it belongs to the palm (`hand.s` = 1).
3. Finger vertices: project onto the polyline knuckle→`_1`→`_2`→tip (the joints from §4 rules). The
   parameter along the polyline gives the bone. Blend linearly between adjacent bones within ±15 % of
   the shorter segment around each interior joint, and between `hand.s` and the `.01` bone within
   ±15 % around the knuckle.
4. Mesh vertex → the nearest proxy vertex (KDTree), copying its fractions.

## Tests (`tests/engine/test_fingers.py`)
Use fixtures `apose`, `tpose`, `curled`, `mitten`. Feed in the **truth** wrist and elbow, so WP4a
errors don't mix in, with `H` = the mesh height.

| Check | Fixtures | Requirement |
|---|---|---|
| Tips | apose, tpose | every tip within **15 % of hand length** (hand length = `|middle_tip − wrist|` truth) |
| Knuckles | apose, tpose | within 20 % |
| Thumb, finger order, palm-normal sign | apose, tpose | correct |
| Tips | curled | within 20 % (the truth stores the actual curled positions) |
| Fallback | mitten | `fallback = True`, all confidences ≤ 0.3, no exception |
| Weights | apose | vertices within 1 cm of truth `index_tip_L` have fraction > 0.9 on `index.03.L` |
| Weights | apose | vertices within 1.5 cm of `lerp(wrist_L, middle_0_L, 0.4)` have > 0.6 on `hand.L` |
| Weights | apose | all fractions sum to 1 ± 1e-6 |
| Speed | — | each side under 10 s |

## Acceptance
`blender … -P tests/engine/run.py -- fingers` passes, and the earlier suites still pass. Report the
per-finger error table.
