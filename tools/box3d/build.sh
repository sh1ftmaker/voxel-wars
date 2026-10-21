#!/usr/bin/env bash
# Build the box3d physics module (src/physics/box3d/) from a pinned box3d commit:
#   vendor/box3d/box3d.mjs           Emscripten glue (ES module; the wasm bytes are passed in by src/physics/box3d/B3.js)
#   vendor/box3d/box3d-simd.wasm     wasm SIMD128 build (box3d's SSE2 paths through Emscripten's SSE emulation)
#   vendor/box3d/box3d-scalar.wasm   scalar fallback (browsers without wasm SIMD)
# The outputs are committed, so neither the dev server nor the Pages build need emsdk. Run this after changing
# tools/box3d/bind.c or the pin. Checkouts go to .cache/ (git-ignored); override with BOX3D_DIR / EMSDK.
#   tools/box3d/build.sh
set -euo pipefail
BOX3D_COMMIT=f36d061ba26998c87cb7dc593a4065aaa03fb7eb   # erincatto/box3d main, 2026-10-20
EMSDK_VERSION=6.0.13
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
B3=${BOX3D_DIR:-$ROOT/.cache/box3d}
EMSDK=${EMSDK:-$ROOT/.cache/emsdk}
OUT=$ROOT/vendor/box3d
if [ ! -d "$B3/src" ]; then
  git clone https://github.com/erincatto/box3d.git "$B3"
  git -C "$B3" checkout "$BOX3D_COMMIT"
fi
if [ ! -x "$EMSDK/upstream/emscripten/emcc" ]; then
  git clone https://github.com/emscripten-core/emsdk.git "$EMSDK"
  "$EMSDK/emsdk" install "$EMSDK_VERSION" && "$EMSDK/emsdk" activate "$EMSDK_VERSION"
fi
EMCC=$EMSDK/upstream/emscripten/emcc
export EM_CONFIG=$EMSDK/.emscripten
mkdir -p "$OUT"
# -ffp-contract=off: no fused multiply-add, so every build gives bit-identical results (box3d's cross-platform
# determinism). B3_MAX_MESH_CONTACT_TRIANGLES: a 4 m debris box on the 0.25 m voxel terrain touches ~500 triangles,
# the default cap (box3d issue #184) would silently drop contacts.
COMMON=(-O3 -DNDEBUG -ffp-contract=off -std=gnu17 -I"$B3/include" -I"$B3/src" -Wno-everything -DB3_MAX_MESH_CONTACT_TRIANGLES=2048)
EMFLAGS=(-sMODULARIZE -sEXPORT_ES6 -sEXPORT_NAME=createBox3d -sALLOW_MEMORY_GROWTH -sINITIAL_MEMORY=67108864 -sSTACK_SIZE=1048576
  -sENVIRONMENT=web,worker,node -sEXPORTED_RUNTIME_METHODS=HEAPF32,HEAP32,HEAPU8 -sFILESYSTEM=0 -sASSERTIONS=0)
TMP=$(mktemp -d)
"$EMCC" "${COMMON[@]}" "${EMFLAGS[@]}" -msimd128 -msse2 "$B3"/src/*.c "$ROOT/tools/box3d/bind.c" -o "$TMP/box3d.mjs"
"$EMCC" "${COMMON[@]}" "${EMFLAGS[@]}" -DBOX3D_DISABLE_SIMD "$B3"/src/*.c "$ROOT/tools/box3d/bind.c" -o "$TMP/box3d-scalar.mjs"
cp "$TMP/box3d.mjs" "$OUT/box3d.mjs"
cp "$TMP/box3d.wasm" "$OUT/box3d-simd.wasm"
cp "$TMP/box3d-scalar.wasm" "$OUT/box3d-scalar.wasm"
echo "$BOX3D_COMMIT" > "$OUT/COMMIT"
rm -rf "$TMP"
ls -la "$OUT"
