# box3d evaluation (vs Rapier 0.21)

Hands-on check of [box3d](https://github.com/erincatto/box3d) (Erin Catto, MIT, C17, public since May 2026, v0.1.0
tagged June 2026) as a replacement for `@dimforge/rapier3d-compat` in voxel-wars.

## Files

- `bind.c`: a flat C shim (world, static trimeshes, dynamic box-compound bodies, step, batched transform read-out). It is the seed of the binding we would need.
- `native.c`: a native runner for the same shim.
- `build.sh <box3d checkout> <emsdk> <out>`: builds the wasm SIMD build, the wasm scalar build, and native SSE2 and AVX2 builds.
- `scene.mjs`: the real Fort War terrain chunk trimeshes, plus the red corner tower cut into Voronoi box-compound pieces (as `tools/test/colliders.mjs`).
- `run.mjs <out> [copies] [steps]`: runs Rapier against box3d on that scene, printing step cost and an FNV transform hash.
- `churn.mjs <out>`: creates and destroys every chunk trimesh, which is the per-edit collider cost.

Build artifacts stay outside the repo (the scratchpad).

## Results (node 22, RTX 4090 box, single thread, 1/60 s steps, box3d 4 substeps)

| scene | Rapier ms/step (worst) | box3d wasm SIMD | box3d wasm scalar | box3d native AVX2 |
|---|---|---|---|---|
| 40 bodies, 1204 boxes, 156k terrain tris | 2.30 (32.1) | **0.78–0.84 (2.8–7.3)** | 1.13 (8.2) | 0.64 (2.2) |
| 200 bodies, 6020 boxes, 241k tris | 15.8 (59.1) | **6.1 (17–22)** | 7.6 (24.3) | 4.9 (14.3) |

**Determinism.** The four builds use different compilers, ISAs and SIMD widths: native SSE2, native AVX2 (8-wide), wasm SIMD128, and wasm scalar. All four give the **same final transform hash** (`9cafdc88` on the 40-body scene, `353486f3` on the 200-body scene), and so do repeated runs.

**Terrain collider churn** (64 chunk meshes, about 2.4k tris each):

| | create, ms/mesh (worst) | remove, ms/mesh |
|---|---|---|
| Rapier | 0.61 (2.5) | ~0 |
| box3d, SAH | 0.68 (2.7) | ~0 |
| box3d, median split | 0.42 (1.6) | ~0 |

`b3MeshData` is a relocatable blob (byte offsets plus `byteCount`), so it could be built in the mesher worker and copied into the physics heap. That makes collider cooking almost free on the main thread.

**Size.** The box3d wasm is 505 KB (199 KB gzipped). Rapier compat is 4.3 MB (1.65 MB gzipped), because its wasm is inlined as base64.

**Threads.** The wasm build needs pthreads and SharedArrayBuffer, so cross-origin isolation, which GitHub Pages does not provide. The numbers above are single-threaded.
