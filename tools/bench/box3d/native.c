// Native runner for the scene file written by run.mjs: same binding as the wasm build, prints step cost and a
// transform hash (FNV-1a over the raw float bits) so runs on different instruction paths can be compared.
//   native-avx2 scene.bin [steps]
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <time.h>

void bw_create(float gx, float gy, float gz, int sleep);
int bw_add_mesh(float* verts, int vcount, int* idx, int tcount);
int bw_add_body(float px, float py, float pz, float vx, float vy, float vz, float wx, float wy, float wz, int bullet);
void bw_add_box(int i, float hx, float hy, float hz, float cx, float cy, float cz, float density);
void bw_step(float dt, int substeps);
int bw_read(float* out);

static double now(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec * 1e3 + t.tv_nsec / 1e6; }

int main(int argc, char** argv) {
    FILE* fp = fopen(argv[1], "rb");
    fseek(fp, 0, SEEK_END); long n = ftell(fp) / 4; fseek(fp, 0, SEEK_SET);
    float* f = malloc(n * 4); fread(f, 4, n, fp); fclose(fp);
    int steps = argc > 2 ? atoi(argv[2]) : 240;
    int o = 0;
    bw_create(0, -30, 0, 1);
    int nm = (int)f[o++];
    for(int m = 0; m < nm; m++) {
        int nv = (int)f[o++], nt = (int)f[o++];
        float* v = f + o; o += nv * 3;
        int* idx = malloc(nt * 3 * sizeof(int));
        for(int i = 0; i < nt * 3; i++) idx[i] = (int)f[o + i];
        o += nt * 3;
        bw_add_mesh(v, nv, idx, nt);
    }
    int nb = (int)f[o++];
    for(int b = 0; b < nb; b++) {
        float* p = f + o; o += 9;
        int id = bw_add_body(p[0], p[1], p[2], p[3], p[4], p[5], p[6], p[7], p[8], 0);
        int nx = (int)f[o++];
        for(int k = 0; k < nx; k++, o += 7) bw_add_box(id, f[o], f[o + 1], f[o + 2], f[o + 3], f[o + 4], f[o + 5], f[o + 6]);
    }
    float* out = malloc(nb * 7 * 4);
    double worst = 0, t0 = now();
    for(int s = 0; s < steps; s++) { double a = now(); bw_step(1.0f / 60, 4); double d = now() - a; if(d > worst) worst = d; }
    double tt = now() - t0;
    int awake = bw_read(out);
    uint32_t h = 2166136261u; const uint8_t* bytes = (const uint8_t*)out;
    for(int i = 0; i < nb * 7 * 4; i++) { h ^= bytes[i]; h *= 16777619u; }
    float minY = 1e9f; for(int b = 0; b < nb; b++) if(out[b * 7 + 1] < minY) minY = out[b * 7 + 1];
    printf("native bodies %d: %d steps %.0f ms (avg %.2f, worst %.1f), awake %d, min y %.2f, hash %08x\n", nb, steps, tt, tt / steps, worst, awake, minY, h);
    return 0;
}
