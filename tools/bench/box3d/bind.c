// Minimal flat C binding over box3d for the voxel-wars evaluation (tools/bench/box3d/README.md).
// Handles are plain ints into a JS-side table; ids never cross as structs. Bodies are referenced by index.
#include "box3d/box3d.h"
#include "box3d/collision.h"
#ifdef BW_NATIVE
#define EMSCRIPTEN_KEEPALIVE
#else
#include <emscripten/emscripten.h>
#endif
#include <stdlib.h>
#include <string.h>

#define MAX_BODIES 4096
static b3WorldId world;
static b3BodyId ground;
static b3BodyId bodies[MAX_BODIES];
static int bodyCount = 0;
#define MAX_MESHES 8192
static b3ShapeId meshShapes[MAX_MESHES];
static b3MeshData* meshData[MAX_MESHES];
static int meshCount = 0;
static int medianSplit = 0;

EMSCRIPTEN_KEEPALIVE void bw_create(float gx, float gy, float gz, int sleep) {
    b3WorldDef def = b3DefaultWorldDef();
    def.gravity = (b3Vec3){ gx, gy, gz };
    world = b3CreateWorld(&def);
    meshCount = 0;
    b3World_EnableSleeping(world, sleep != 0);
    b3BodyDef bd = b3DefaultBodyDef();
    ground = b3CreateBody(world, &bd);
    bodyCount = 0;
}

EMSCRIPTEN_KEEPALIVE void bw_destroy(void) { b3DestroyWorld(world); }

EMSCRIPTEN_KEEPALIVE void bw_mesh_median(int on) { medianSplit = on; }

// static triangle mesh (vertices xyz f32, indices i32); returns its slot (bw_remove_mesh)
EMSCRIPTEN_KEEPALIVE int bw_add_mesh(float* verts, int vcount, int* idx, int tcount) {
    b3MeshDef md = { 0 };
    md.vertices = (b3Vec3*)verts;
    md.vertexCount = vcount;
    md.indices = idx;
    md.triangleCount = tcount;
    md.identifyEdges = true;
    md.weldVertices = true;
    md.weldTolerance = 0.001f;
    md.useMedianSplit = medianSplit != 0;
    b3MeshData* mesh = b3CreateMesh(&md, NULL, 0);
    if(!mesh) return -1;
    b3ShapeDef sd = b3DefaultShapeDef();
    // b3CreateMeshShape does not copy: the mesh must outlive the shape (freed in bw_remove_mesh)
    if(meshCount >= MAX_MESHES) return -1;
    meshShapes[meshCount] = b3CreateMeshShape(ground, &sd, mesh, (b3Vec3){ 1, 1, 1 });
    meshData[meshCount] = mesh;
    return meshCount++;
}

EMSCRIPTEN_KEEPALIVE void bw_remove_mesh(int i) {
    if(!b3Shape_IsValid(meshShapes[i])) return;
    b3DestroyShape(meshShapes[i], false);
    b3DestroyMesh(meshData[i]);
    meshData[i] = NULL;
}

EMSCRIPTEN_KEEPALIVE int bw_add_body(float px, float py, float pz, float vx, float vy, float vz, float wx, float wy, float wz, int bullet) {
    if(bodyCount >= MAX_BODIES) return -1;
    b3BodyDef bd = b3DefaultBodyDef();
    bd.type = b3_dynamicBody;
    bd.position = (b3Pos){ px, py, pz };
    bd.linearVelocity = (b3Vec3){ vx, vy, vz };
    bd.angularVelocity = (b3Vec3){ wx, wy, wz };
    bd.isBullet = bullet != 0;
    bodies[bodyCount] = b3CreateBody(world, &bd);
    return bodyCount++;
}

// box collider (half extents, local centre) on body i
EMSCRIPTEN_KEEPALIVE void bw_add_box(int i, float hx, float hy, float hz, float cx, float cy, float cz, float density) {
    b3Transform t = { { cx, cy, cz }, b3Quat_identity };
    b3BoxHull box = b3MakeTransformedBoxHull(hx, hy, hz, t);
    b3ShapeDef sd = b3DefaultShapeDef();
    sd.density = density;
    sd.enableContactEvents = true;
    b3CreateHullShape(bodies[i], &sd, &box.base);
}

EMSCRIPTEN_KEEPALIVE void bw_step(float dt, int substeps) { b3World_Step(world, dt, substeps); }

// out: 7 floats per body (p xyz, q xyzw); returns awake count
EMSCRIPTEN_KEEPALIVE int bw_read(float* out) {
    int awake = 0;
    for(int i = 0; i < bodyCount; i++) {
        b3WorldTransform x = b3Body_GetTransform(bodies[i]);
        float* o = out + i * 7;
        o[0] = x.p.x; o[1] = x.p.y; o[2] = x.p.z;
        o[3] = x.q.v.x; o[4] = x.q.v.y; o[5] = x.q.v.z; o[6] = x.q.s;
        awake += b3Body_IsAwake(bodies[i]);
    }
    return awake;
}

EMSCRIPTEN_KEEPALIVE int bw_contact_begin_count(void) { return b3World_GetContactEvents(world).beginCount; }

EMSCRIPTEN_KEEPALIVE void* bw_malloc(int n) { return malloc(n); }
EMSCRIPTEN_KEEPALIVE void bw_free(void* p) { free(p); }
