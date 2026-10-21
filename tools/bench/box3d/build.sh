#!/usr/bin/env bash
# Build box3d + bind.c to wasm (SIMD and scalar) and a native x86 build for determinism cross-checks.
#   tools/bench/box3d/build.sh <box3d checkout> <emsdk dir> <out dir>
set -euo pipefail
B3=$1; EMSDK=$2; OUT=$3
HERE=$(cd "$(dirname "$0")" && pwd)
EMCC=$EMSDK/upstream/emscripten/emcc
export EM_CONFIG=$EMSDK/.emscripten
mkdir -p "$OUT"
SRCS=("$B3"/src/*.c)
COMMON=(-O3 -ffp-contract=off -std=gnu17 -I"$B3/include" -I"$B3/src" -Wno-everything)
EMFLAGS=(-sMODULARIZE -sEXPORT_ES6 -sALLOW_MEMORY_GROWTH -sENVIRONMENT=node,web,worker
  -sEXPORTED_RUNTIME_METHODS=HEAPF32,HEAP32,HEAPU8 -sFILESYSTEM=0)
"$EMCC" "${COMMON[@]}" "${EMFLAGS[@]}" -msimd128 -msse2 "${SRCS[@]}" "$HERE/bind.c" -o "$OUT/box3d-simd.mjs"
"$EMCC" "${COMMON[@]}" "${EMFLAGS[@]}" -DBOX3D_DISABLE_SIMD "${SRCS[@]}" "$HERE/bind.c" -o "$OUT/box3d-scalar.mjs"
# native (SSE2 + AVX2 width-8 paths), same binding driven by native.c
clang "${COMMON[@]}" -DBW_NATIVE -mavx2 -mfma "${SRCS[@]}" "$HERE/bind.c" "$HERE/native.c" -lm -lpthread -o "$OUT/native-avx2"
clang "${COMMON[@]}" -DBW_NATIVE -DBOX3D_DISABLE_AVX2 "${SRCS[@]}" "$HERE/bind.c" "$HERE/native.c" -lm -lpthread -o "$OUT/native-sse2"
ls -la "$OUT"
