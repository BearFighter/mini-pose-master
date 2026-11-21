# Fixtures

Original, procedural weapon props with exact ground truth. Nothing here is third-party content.

There is no procedural figure. Character behaviour (import, joint finding, rigging, skinning, baking) is
tested only on real character kits, which live outside this repository and are named by a local,
git-ignored config: see `tests/engine/kits.py`. Tests that need a kit are skipped when none is configured.

Generate (headless, under a second):

```
"C:/Program Files/Blender Foundation/Blender 5.2/blender.exe" -b --factory-startup --python-exit-code 1     -P fixtures/generate.py -- --out fixtures/out [--only sword,rifle]
```

Output goes to `fixtures/out/<name>/` (git-ignored): `<name>.glb`, `<name>.fbx` and `<name>.truth.json`.
The engine test harness (`tests/engine/run.py`) generates missing fixtures first; `MPM_FIXTURES` overrides
the folder.

## Fixtures

| name | purpose |
|---|---|
| `sword` | Blade 0.80 m, grip origin, grip axis +Z, blade toward +Z. GLB and FBX. |
| `rifle` | Barrel along +Y, origin at the pistol-grip centre. GLB and FBX. The truth gives main and support grip point, axis and palm normal (weapon-local). |

## Truth file

`mpm.fixture/1` JSON: `name`, `up`, `forward`, `export` and `grips` (`main` and `support`, each with
`point`, `axis` and `palm_normal`, weapon-local, metres).

## Other test data

- Pure synthetic data that involves no figure (a known height field and its normal map in both green
  conventions, a flat UV-mapped grid, plain boxes): `tests/engine/synthetic.py`.
- Real kits given a skeleton in an exporter's naming convention (Mixamo, Unreal mannequin, 3ds Max
  Biped) for the "use the model's own skeleton" path: `tests/engine/rigged_kit.py`.
- Real kits written out again as Y up / in centimetres, and the `.obj` shipped beside a kit's `.fbx`:
  `tests/engine/kit_variants.py`.
