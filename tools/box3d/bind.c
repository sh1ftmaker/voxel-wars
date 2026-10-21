// Flat C binding over box3d for voxel-wars (src/physics/box3d/). Built to wasm by tools/box3d/build.sh.
//
// Bodies and shapes are referred to by int handles: (generation << 17) | slot. Every entry point checks the handle
// against the slot's live generation and does nothing (or returns 0 / -1) for a stale one, so JS can never reach a
// destroyed box3d object. Nothing calls back into JS: events and queries write into static buffers that JS reads
// through typed-array views after the call.
//
// Collision filters are 32-bit (category, mask) pairs (the same bits as the old Rapier groups); a disabled shape keeps
// its filter aside and collides with nothing.
#include "box3d/box3d.h"
#include "box3d/collision.h"
#include "box3d/math_functions.h"
#ifdef BW_NATIVE
#define API
#else
#include <emscripten/emscripten.h>
#define API EMSCRIPTEN_KEEPALIVE
#endif
#include <float.h>
#include <math.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define MAXB 32768
#define MAXS 131072
#define SLOT_BITS 17
#define SLOT_MASK 0x1ffff
#define GEN_MASK 0x3fff
#define XF 8          // floats per body in the transform table: p xyz, q xyzw, awake
#define MAX_HITS 2048
#define HIT 10        // floats (or int bits) per hit event
#define MAX_PLANES 16
#define MAX_IGNORE 32

typedef struct { b3BodyId id; uint16_t gen; uint8_t used; } BSlot;
typedef struct { b3ShapeId id; int body; uint16_t gen; uint8_t used; uint8_t disabled; uint32_t cat, mask; b3MeshData* mesh; b3HullData* hull; } SSlot;

static b3WorldId world;
static int hasWorld = 0;
static BSlot bs[MAXB];
static SSlot ss[MAXS];
static int bFree[MAXB], bFreeN = 0, bHigh = 0;
static int sFree[MAXS], sFreeN = 0, sHigh = 0;
static float xf[MAXB * XF];
static float hits[MAX_HITS * HIT];
static int hitCount = 0;
static float out[64];
static int ignoreList[MAX_IGNORE];
static int ignoreN = 0;
static int meshMedian = 1;

static inline int bslot(int h) {
    if(h < 0) return -1;
    int s = h & SLOT_MASK, g = (h >> SLOT_BITS) & GEN_MASK;
    if(s >= MAXB || !bs[s].used || bs[s].gen != g || !b3Body_IsValid(bs[s].id)) return -1;
    return s;
}
static inline int sslot(int h) {
    if(h < 0) return -1;
    int s = h & SLOT_MASK, g = (h >> SLOT_BITS) & GEN_MASK;
    if(s >= MAXS || !ss[s].used || ss[s].gen != g || !b3Shape_IsValid(ss[s].id)) return -1;
    return s;
}
static inline int bhandle(int s) { return (bs[s].gen << SLOT_BITS) | s; }
static inline int shandle(int s) { return (ss[s].gen << SLOT_BITS) | s; }
static inline int shapeSlotOf(b3ShapeId id) { return (int)(intptr_t)b3Shape_GetUserData(id) - 1; }
static inline int bodySlotOf(b3BodyId id) { return (int)(intptr_t)b3Body_GetUserData(id) - 1; }
static inline b3Filter mkfilter(uint32_t cat, uint32_t mask) { b3Filter f = b3DefaultFilter(); f.categoryBits = cat; f.maskBits = mask; return f; }

static void writeXf(int s) {
    b3WorldTransform t = b3Body_GetTransform(bs[s].id);
    float* o = xf + s * XF;
    o[0] = (float)t.p.x; o[1] = (float)t.p.y; o[2] = (float)t.p.z;
    o[3] = t.q.v.x; o[4] = t.q.v.y; o[5] = t.q.v.z; o[6] = t.q.s;
    o[7] = b3Body_IsAwake(bs[s].id) ? 1.0f : 0.0f;
}

// ------------------------------------------------------------------ world

API void bw_world_create(float gx, float gy, float gz, float hitThreshold) {
    if(hasWorld) b3DestroyWorld(world);
    b3WorldDef def = b3DefaultWorldDef();
    def.gravity = (b3Vec3){ gx, gy, gz };
    def.hitEventThreshold = hitThreshold;
    world = b3CreateWorld(&def);
    hasWorld = 1;
    memset(bs, 0, sizeof(bs)); memset(ss, 0, sizeof(ss));
    bFreeN = sFreeN = bHigh = sHigh = 0;
    hitCount = 0;
}
API void bw_world_destroy(void) { if(hasWorld) b3DestroyWorld(world); hasWorld = 0; }
API void bw_mesh_median(int on) { meshMedian = on; }
API void bw_set_contact_tuning(float hertz, float damping, float speed) { b3World_SetContactTuning(world, hertz, damping, speed); }
API void bw_set_max_speed(float v) { b3World_SetMaximumLinearSpeed(world, v); }

API float* bw_xf(void) { return xf; }
API float* bw_hits(void) { return hits; }
API float* bw_out(void) { return out; }
API int* bw_ignore(void) { return ignoreList; }
API void bw_ignore_count(int n) { ignoreN = n < 0 ? 0 : n > MAX_IGNORE ? MAX_IGNORE : n; }
API void* bw_malloc(int n) { return malloc(n); }
API void bw_free(void* p) { free(p); }

/** Step; then the transform table rows of every body that moved are refreshed (move events) and the hit events are
 *  copied out. Returns the hit count. */
API int bw_step(float dt, int substeps) {
    b3World_Step(world, dt, substeps);
    b3BodyEvents be = b3World_GetBodyEvents(world);
    for(int i = 0; i < be.moveCount; i++) {
        const b3BodyMoveEvent* e = be.moveEvents + i;
        int s = (int)(intptr_t)e->userData - 1;
        if(s < 0 || s >= MAXB || !bs[s].used) continue;
        float* o = xf + s * XF;
        o[0] = (float)e->transform.p.x; o[1] = (float)e->transform.p.y; o[2] = (float)e->transform.p.z;
        o[3] = e->transform.q.v.x; o[4] = e->transform.q.v.y; o[5] = e->transform.q.v.z; o[6] = e->transform.q.s;
        o[7] = e->fellAsleep ? 0.0f : 1.0f;
    }
    b3ContactEvents ce = b3World_GetContactEvents(world);
    int n = 0;
    for(int i = 0; i < ce.hitCount && n < MAX_HITS; i++) {
        const b3ContactHitEvent* e = ce.hitEvents + i;
        if(!b3Shape_IsValid(e->shapeIdA) || !b3Shape_IsValid(e->shapeIdB)) continue;
        int a = shapeSlotOf(e->shapeIdA), b = shapeSlotOf(e->shapeIdB);
        if(a < 0 || b < 0) continue;
        float* o = hits + n * HIT;
        int* oi = (int*)o;
        oi[0] = shandle(a); oi[1] = shandle(b);
        o[2] = (float)e->point.x; o[3] = (float)e->point.y; o[4] = (float)e->point.z;
        o[5] = e->normal.x; o[6] = e->normal.y; o[7] = e->normal.z;
        o[8] = e->approachSpeed; o[9] = 0;
        n++;
    }
    hitCount = n;
    return n;
}
API int bw_awake_count(void) { return b3World_GetAwakeBodyCount(world); }

// ------------------------------------------------------------------ bodies

/** type 0 static, 1 kinematic, 2 dynamic. Returns a handle or -1. */
API int bw_body_create(int type, float px, float py, float pz, float qx, float qy, float qz, float qw,
                       float vx, float vy, float vz, float wx, float wy, float wz,
                       float linDamp, float angDamp, int bullet, int enabled, float gravityScale) {
    int s;
    if(bFreeN) s = bFree[--bFreeN]; else if(bHigh < MAXB) s = bHigh++; else return -1;
    b3BodyDef bd = b3DefaultBodyDef();
    bd.type = (b3BodyType)type;
    bd.position = (b3Pos){ px, py, pz };
    bd.rotation = (b3Quat){ { qx, qy, qz }, qw };
    bd.linearVelocity = (b3Vec3){ vx, vy, vz };
    bd.angularVelocity = (b3Vec3){ wx, wy, wz };
    bd.linearDamping = linDamp;
    bd.angularDamping = angDamp;
    bd.isBullet = bullet != 0;
    bd.isEnabled = enabled != 0;
    bd.gravityScale = gravityScale;
    bd.userData = (void*)(intptr_t)(s + 1);
    bs[s].id = b3CreateBody(world, &bd);
    bs[s].used = 1;
    bs[s].gen = (uint16_t)((bs[s].gen + 1) & GEN_MASK);
    if(bs[s].gen == 0) bs[s].gen = 1;
    writeXf(s);
    return bhandle(s);
}

static void freeShapeSlot(int s) {
    if(ss[s].mesh) { b3DestroyMesh(ss[s].mesh); ss[s].mesh = NULL; }
    if(ss[s].hull) { b3DestroyHull(ss[s].hull); ss[s].hull = NULL; }
    ss[s].used = 0;
    sFree[sFreeN++] = s;
}

API void bw_body_destroy(int h) {
    int s = bslot(h); if(s < 0) return;
    // the body's shapes go with it: free their slots (and meshes/hulls) first
    int n = b3Body_GetShapeCount(bs[s].id);
    int* slots = NULL;
    if(n > 0) {
        b3ShapeId* ids = (b3ShapeId*)malloc(sizeof(b3ShapeId) * n);
        slots = (int*)malloc(sizeof(int) * n);
        n = b3Body_GetShapes(bs[s].id, ids, n);
        for(int i = 0; i < n; i++) slots[i] = shapeSlotOf(ids[i]);
        free(ids);
    }
    b3DestroyBody(bs[s].id);
    for(int i = 0; i < n; i++) if(slots[i] >= 0 && ss[slots[i]].used && ss[slots[i]].body == s) freeShapeSlot(slots[i]);
    free(slots);
    bs[s].used = 0;
    bFree[bFreeN++] = s;
}
API int bw_body_valid(int h) { return bslot(h) >= 0; }
API void bw_body_set_type(int h, int type) { int s = bslot(h); if(s >= 0) b3Body_SetType(bs[s].id, (b3BodyType)type); }
API int bw_body_type(int h) { int s = bslot(h); return s < 0 ? -1 : (int)b3Body_GetType(bs[s].id); }
API void bw_body_set_transform(int h, float px, float py, float pz, float qx, float qy, float qz, float qw, int wake) {
    int s = bslot(h); if(s < 0) return;
    b3Body_SetTransform(bs[s].id, (b3Pos){ px, py, pz }, (b3Quat){ { qx, qy, qz }, qw });
    if(wake && b3Body_GetType(bs[s].id) != b3_staticBody) b3Body_SetAwake(bs[s].id, true);
    writeXf(s);
}
API void bw_body_set_target(int h, float px, float py, float pz, float qx, float qy, float qz, float qw, float dt) {
    int s = bslot(h); if(s < 0) return;
    b3Body_SetTargetTransform(bs[s].id, (b3WorldTransform){ { px, py, pz }, { { qx, qy, qz }, qw } }, dt, true);
}
API void bw_body_set_linvel(int h, float x, float y, float z, int wake) {
    int s = bslot(h); if(s < 0) return;
    if(wake) b3Body_SetAwake(bs[s].id, true);
    b3Body_SetLinearVelocity(bs[s].id, (b3Vec3){ x, y, z });
}
API void bw_body_set_angvel(int h, float x, float y, float z, int wake) {
    int s = bslot(h); if(s < 0) return;
    if(wake) b3Body_SetAwake(bs[s].id, true);
    b3Body_SetAngularVelocity(bs[s].id, (b3Vec3){ x, y, z });
}
/** out[0..2] linear velocity, out[3..5] angular velocity, out[6] awake, out[7] mass, out[8..10] world centre of mass. */
API int bw_body_get(int h) {
    int s = bslot(h); if(s < 0) return 0;
    b3BodyId id = bs[s].id;
    b3Vec3 v = b3Body_GetLinearVelocity(id), w = b3Body_GetAngularVelocity(id);
    b3Pos c = b3Body_GetWorldCenter(id);
    out[0] = v.x; out[1] = v.y; out[2] = v.z; out[3] = w.x; out[4] = w.y; out[5] = w.z;
    out[6] = b3Body_IsAwake(id) ? 1.0f : 0.0f; out[7] = b3Body_GetMass(id);
    out[8] = (float)c.x; out[9] = (float)c.y; out[10] = (float)c.z;
    return 1;
}
API void bw_body_impulse(int h, float jx, float jy, float jz, float px, float py, float pz, int atPoint, int wake) {
    int s = bslot(h); if(s < 0 || b3Body_GetType(bs[s].id) != b3_dynamicBody) return;
    if(atPoint) b3Body_ApplyLinearImpulse(bs[s].id, (b3Vec3){ jx, jy, jz }, (b3Pos){ px, py, pz }, wake != 0);
    else b3Body_ApplyLinearImpulseToCenter(bs[s].id, (b3Vec3){ jx, jy, jz }, wake != 0);
}
API void bw_body_angular_impulse(int h, float x, float y, float z, int wake) {
    int s = bslot(h); if(s < 0 || b3Body_GetType(bs[s].id) != b3_dynamicBody) return;
    b3Body_ApplyAngularImpulse(bs[s].id, (b3Vec3){ x, y, z }, wake != 0);
}
API void bw_body_set_awake(int h, int awake) { int s = bslot(h); if(s >= 0 && b3Body_GetType(bs[s].id) != b3_staticBody) { b3Body_SetAwake(bs[s].id, awake != 0); xf[s * XF + 7] = awake ? 1.0f : 0.0f; } }
API void bw_body_enable(int h, int on) { int s = bslot(h); if(s < 0) return; if(on) b3Body_Enable(bs[s].id); else b3Body_Disable(bs[s].id); }
API void bw_body_set_damping(int h, float lin, float ang) { int s = bslot(h); if(s < 0) return; b3Body_SetLinearDamping(bs[s].id, lin); b3Body_SetAngularDamping(bs[s].id, ang); }
API void bw_body_set_bullet(int h, int on) { int s = bslot(h); if(s >= 0) b3Body_SetBullet(bs[s].id, on != 0); }
API void bw_body_set_gravity_scale(int h, float g) { int s = bslot(h); if(s >= 0) b3Body_SetGravityScale(bs[s].id, g); }
/** Scale the mass (and inertia) computed from the shapes to `mass`. */
API void bw_body_set_mass(int h, float mass) {
    int s = bslot(h); if(s < 0) return;
    b3MassData md = b3Body_GetMassData(bs[s].id);
    if(!(md.mass > 0.0f) || !(mass > 0.0f)) return;
    float k = mass / md.mass;
    md.mass = mass;
    md.inertia.cx = b3MulSV(k, md.inertia.cx); md.inertia.cy = b3MulSV(k, md.inertia.cy); md.inertia.cz = b3MulSV(k, md.inertia.cz);
    b3Body_SetMassData(bs[s].id, md);
}

// ------------------------------------------------------------------ shapes

static int newShape(int bodySlot, b3ShapeId id, uint32_t cat, uint32_t mask, b3MeshData* mesh, b3HullData* hull) {
    int s;
    if(sFreeN) s = sFree[--sFreeN]; else if(sHigh < MAXS) s = sHigh++; else { b3DestroyShape(id, false); if(mesh) b3DestroyMesh(mesh); if(hull) b3DestroyHull(hull); return -1; }
    ss[s].id = id; ss[s].body = bodySlot; ss[s].used = 1; ss[s].disabled = 0; ss[s].cat = cat; ss[s].mask = mask;
    ss[s].mesh = mesh; ss[s].hull = hull;
    ss[s].gen = (uint16_t)((ss[s].gen + 1) & GEN_MASK);
    if(ss[s].gen == 0) ss[s].gen = 1;
    b3Shape_SetUserData(id, (void*)(intptr_t)(s + 1));
    return shandle(s);
}
static b3ShapeDef shapeDef(float density, float friction, float restitution, uint32_t cat, uint32_t mask, int hitEvents, int updateMass) {
    b3ShapeDef sd = b3DefaultShapeDef();
    sd.density = density;
    sd.baseMaterial.friction = friction;
    sd.baseMaterial.restitution = restitution;
    sd.filter = mkfilter(cat, mask);
    sd.enableHitEvents = hitEvents != 0;
    sd.enableContactEvents = false;
    sd.updateBodyMass = updateMass != 0;
    return sd;
}

/** Box (half extents) at a local offset and rotation. */
API int bw_shape_box(int body, float hx, float hy, float hz, float cx, float cy, float cz, float qx, float qy, float qz, float qw,
                     float density, float friction, float restitution, uint32_t cat, uint32_t mask, int hitEvents, int updateMass) {
    int b = bslot(body); if(b < 0) return -1;
    b3Transform t = { { cx, cy, cz }, { { qx, qy, qz }, qw } };
    b3BoxHull box = b3MakeTransformedBoxHull(hx, hy, hz, t);
    b3ShapeDef sd = shapeDef(density, friction, restitution, cat, mask, hitEvents, updateMass);
    return newShape(b, b3CreateHullShape(bs[b].id, &sd, &box.base), cat, mask, NULL, NULL);
}
API int bw_shape_sphere(int body, float r, float cx, float cy, float cz, float density, float friction, float restitution, uint32_t cat, uint32_t mask, int hitEvents, int updateMass) {
    int b = bslot(body); if(b < 0) return -1;
    b3Sphere sp = { { cx, cy, cz }, r };
    b3ShapeDef sd = shapeDef(density, friction, restitution, cat, mask, hitEvents, updateMass);
    return newShape(b, b3CreateSphereShape(bs[b].id, &sd, &sp), cat, mask, NULL, NULL);
}
/** Capsule along y: centres at +-halfHeight. */
API int bw_shape_capsule(int body, float halfHeight, float r, float density, float friction, float restitution, uint32_t cat, uint32_t mask, int hitEvents, int updateMass) {
    int b = bslot(body); if(b < 0) return -1;
    b3Capsule cp = { { 0, -halfHeight, 0 }, { 0, halfHeight, 0 }, r };
    b3ShapeDef sd = shapeDef(density, friction, restitution, cat, mask, hitEvents, updateMass);
    return newShape(b, b3CreateCapsuleShape(bs[b].id, &sd, &cp), cat, mask, NULL, NULL);
}
/** Convex hull of points (xyz f32, body-local). -1 when no hull can be made. */
API int bw_shape_hull(int body, float* pts, int n, float density, float friction, float restitution, uint32_t cat, uint32_t mask, int hitEvents, int updateMass) {
    int b = bslot(body); if(b < 0 || n < 4) return -1;
    b3HullData* hull = b3CreateHull((b3Vec3*)pts, n, 64);
    if(!hull) return -1;
    b3ShapeDef sd = shapeDef(density, friction, restitution, cat, mask, hitEvents, updateMass);
    // the hull is copied into the world's hull database: ours can go now
    b3ShapeId id = b3CreateHullShape(bs[b].id, &sd, hull);
    b3DestroyHull(hull);
    return newShape(b, id, cat, mask, NULL, NULL);
}
/** Static triangle mesh (world-space vertices, CCW outward) on `body`. The mesh data lives as long as the shape. */
API int bw_shape_mesh(int body, float* verts, int vcount, int* idx, int tcount, float friction, uint32_t cat, uint32_t mask) {
    int b = bslot(body); if(b < 0 || tcount <= 0) return -1;
    b3MeshDef md = { 0 };
    md.vertices = (b3Vec3*)verts;
    md.stride = sizeof(b3Vec3);
    md.vertexCount = vcount;
    md.indices = idx;
    md.triangleCount = tcount;
    md.identifyEdges = true;
    md.weldVertices = false;
    md.useMedianSplit = meshMedian != 0;
    b3MeshData* mesh = b3CreateMesh(&md, NULL, 0);
    if(!mesh) return -1;
    b3ShapeDef sd = shapeDef(0, friction, 0, cat, mask, 0, 0);
    return newShape(b, b3CreateMeshShape(bs[b].id, &sd, mesh, (b3Vec3){ 1, 1, 1 }), cat, mask, mesh, NULL);
}
API void bw_shape_destroy(int h, int updateMass) {
    int s = sslot(h); if(s < 0) return;
    b3DestroyShape(ss[s].id, updateMass != 0);
    freeShapeSlot(s);
}
API int bw_shape_valid(int h) { return sslot(h) >= 0; }
API int bw_shape_body(int h) { int s = sslot(h); return s < 0 ? -1 : bhandle(ss[s].body); }
API void bw_shape_set_filter(int h, uint32_t cat, uint32_t mask) {
    int s = sslot(h); if(s < 0) return;
    ss[s].cat = cat; ss[s].mask = mask;
    if(!ss[s].disabled) b3Shape_SetFilter(ss[s].id, mkfilter(cat, mask), true);
}
API void bw_shape_enable(int h, int on) {
    int s = sslot(h); if(s < 0) return;
    if((!on) == ss[s].disabled) return;
    ss[s].disabled = !on;
    b3Shape_SetFilter(ss[s].id, on ? mkfilter(ss[s].cat, ss[s].mask) : mkfilter(0, 0), true);
}

// ------------------------------------------------------------------ queries

static inline int ignored(int shapeSlot) {
    if(shapeSlot < 0 || ss[shapeSlot].disabled) return 1;
    int bh = bhandle(ss[shapeSlot].body);
    for(int i = 0; i < ignoreN; i++) if(ignoreList[i] == bh) return 1;
    return 0;
}

typedef struct { int hit; int shape; float fraction; b3Pos p; b3Vec3 n; } RayCtx;
static float rayCb(b3ShapeId id, b3Pos point, b3Vec3 normal, float fraction, uint64_t mat, int tri, int child, void* ctx) {
    (void)mat; (void)tri; (void)child;
    RayCtx* c = (RayCtx*)ctx;
    int s = shapeSlotOf(id);
    if(ignored(s) || b3Shape_IsSensor(id)) return -1.0f;
    if(c->hit && fraction >= c->fraction) return c->fraction;
    c->hit = 1; c->shape = s; c->fraction = fraction; c->p = point; c->n = normal;
    return fraction;
}
/** Closest hit along origin + t * dir (t <= maxDist) against shapes accepted by (cat, mask), skipping the ignore list.
 *  out: [hit, shape handle (int bits), distance, px, py, pz, nx, ny, nz] */
API int bw_raycast(float ox, float oy, float oz, float dx, float dy, float dz, float maxDist, uint32_t cat, uint32_t mask) {
    b3QueryFilter f = b3DefaultQueryFilter();
    f.categoryBits = cat; f.maskBits = mask;
    RayCtx c = { 0 };
    b3World_CastRay(world, (b3Pos){ ox, oy, oz }, (b3Vec3){ dx * maxDist, dy * maxDist, dz * maxDist }, f, rayCb, &c);
    out[0] = (float)c.hit;
    if(!c.hit) return 0;
    ((int*)out)[1] = shandle(c.shape);
    out[2] = c.fraction * maxDist;
    out[3] = (float)c.p.x; out[4] = (float)c.p.y; out[5] = (float)c.p.z;
    out[6] = c.n.x; out[7] = c.n.y; out[8] = c.n.z;
    return 1;
}

// ------------------------------------------------------------------ character mover

typedef struct { b3CollisionPlane planes[MAX_PLANES]; b3Pos points[MAX_PLANES]; int shapes[MAX_PLANES]; int count; b3Pos origin; } PlaneCtx;
static bool moverFilter(b3ShapeId id, void* ctx) { (void)ctx; return !ignored(shapeSlotOf(id)) && !b3Shape_IsSensor(id); }
static bool planeCb(b3ShapeId id, const b3PlaneResult* pr, int count, void* ctx) {
    PlaneCtx* c = (PlaneCtx*)ctx;
    int s = shapeSlotOf(id);
    if(ignored(s) || b3Shape_IsSensor(id)) return true;
    for(int i = 0; i < count && c->count < MAX_PLANES; i++) {
        c->planes[c->count] = (b3CollisionPlane){ .plane = pr[i].plane, .pushLimit = FLT_MAX, .push = 0, .clipVelocity = true };
        c->points[c->count] = b3OffsetPos(c->origin, pr[i].point);
        c->shapes[c->count] = s;
        c->count++;
    }
    return true;
}
static void gather(PlaneCtx* pc, b3Pos pos, const b3Capsule* cap, b3QueryFilter f) {
    pc->count = 0; pc->origin = pos;
    b3World_CollideMover(world, pos, cap, f, planeCb, pc);
}
/** Walking: steep planes (normal.y below floorCos, above -0.1) become vertical walls, so they block instead of
 *  being climbed. */
static void wallify(PlaneCtx* pc, float floorCos) {
    for(int i = 0; i < pc->count; i++) {
        b3Plane* p = &pc->planes[i].plane;
        float ny = p->normal.y;
        if(ny >= floorCos || ny < -0.1f) continue;
        float l = sqrtf(p->normal.x * p->normal.x + p->normal.z * p->normal.z);
        if(l < 1e-4f) continue;
        p->normal = (b3Vec3){ p->normal.x / l, 0, p->normal.z / l };
        p->offset = p->offset / l;
    }
}
static int floorIn(const PlaneCtx* pc, float floorCos, float* ny) {
    int f = 0; float best = -2;
    for(int i = 0; i < pc->count; i++) {
        float y = pc->planes[i].plane.normal.y;
        // only planes the capsule actually rests on (pushes it, or touches within a few mm)
        float sep = -pc->planes[i].plane.offset;
        if(y >= floorCos && sep < 0.02f) { f = 1; if(y > best) best = y; }
    }
    *ny = best;
    return f;
}

/**
 * Move a capsule (centre c, half height hh, radius r) by t against the world: collide, solve the contact planes, cast,
 * up to 5 times (box3d's mover recipe). mode bit 2 (cast only): one swept cast, stopping at the first contact (no
 * sliding; a step-down onto a ledge). mode bit 1 (walk): on the ground (no vertical intent beyond `snap`: steep planes are walls,
 * and after the move the capsule is snapped down onto walkable ground up to `snap` metres below). pushMass > 0 pushes
 * dynamic bodies touched at the end (impulse of a body of that mass moving at t / dt).
 * The ignore list (bw_ignore) holds body handles whose shapes are skipped.
 * out: [dx, dy, dz, grounded, floor normal y, plane count]
 */
API void bw_move(float cx, float cy, float cz, float hh, float r, float tx, float ty, float tz, int mode, float floorCos, float snap,
                 float pushMass, float dt, uint32_t cat, uint32_t mask) {
    b3QueryFilter f = b3DefaultQueryFilter();
    f.categoryBits = cat; f.maskBits = mask;
    b3Capsule cap = { { 0, -hh, 0 }, { 0, hh, 0 }, r };
    b3Pos start = { cx, cy, cz }, pos = start;
    b3Pos target = { cx + tx, cy + ty, cz + tz };
    PlaneCtx pc;
    int walk = mode & 1;
    if(mode & 2) {
        b3Vec3 d = { tx, ty, tz };
        float frac = b3World_CastMover(world, pos, &cap, d, f, moverFilter, NULL);
        pos = b3OffsetPos(pos, b3MulSV(frac, d));
    }
    else for(int it = 0; it < 5; it++) {
        gather(&pc, pos, &cap, f);
        if(walk) wallify(&pc, floorCos);
        b3Vec3 want = { (float)(target.x - pos.x), (float)(target.y - pos.y), (float)(target.z - pos.z) };
        b3PlaneSolverResult res = b3SolvePlanes(want, pc.planes, pc.count);
        b3Vec3 d = res.delta;
        float frac = b3World_CastMover(world, pos, &cap, d, f, moverFilter, NULL);
        d = b3MulSV(frac, d);
        pos = b3OffsetPos(pos, d);
        if(b3LengthSquared(d) < 1e-6f) break;
    }
    gather(&pc, pos, &cap, f);
    float ny = -2;
    int grounded = floorIn(&pc, floorCos, &ny);
    if(walk && !grounded && snap > 0) {
        // stay on the ground going downhill and over small drops
        b3Vec3 down = { 0, -snap, 0 };
        float frac = b3World_CastMover(world, pos, &cap, down, f, moverFilter, NULL);
        if(frac < 1.0f) {
            b3Pos p2 = b3OffsetPos(pos, b3MulSV(frac, down));
            PlaneCtx pc2;
            gather(&pc2, p2, &cap, f);
            float ny2;
            if(floorIn(&pc2, floorCos, &ny2)) { pos = p2; pc = pc2; grounded = 1; ny = ny2; }
        }
    }
    if(pushMass > 0 && dt > 0) {
        b3Vec3 vc = { tx / dt, ty / dt, tz / dt };
        float invMassA = 1.0f / pushMass;
        for(int i = 0; i < pc.count; i++) {
            int s = pc.shapes[i];
            if(s < 0) continue;
            b3BodyId bid = bs[ss[s].body].id;
            if(b3Body_GetType(bid) != b3_dynamicBody) continue;
            b3Pos point = pc.points[i];
            b3Vec3 normal = b3Neg(pc.planes[i].plane.normal);
            float invMassB = b3Body_GetInverseMass(bid);
            b3Matrix3 invIB = b3Body_GetWorldInverseRotationalInertia(bid);
            b3Vec3 rB = b3SubPos(point, b3Body_GetWorldCenter(bid));
            b3Vec3 rnB = b3Cross(rB, normal);
            float k = invMassA + invMassB + b3Dot(rnB, b3MulMV(invIB, rnB));
            float nm = k > 0 ? 1.0f / k : 0;
            b3Vec3 vB = b3Add(b3Body_GetLinearVelocity(bid), b3Cross(b3Body_GetAngularVelocity(bid), rB));
            float vn = b3Dot(b3Sub(vB, vc), normal);
            float imp = -nm * vn;
            if(imp <= 0) continue;
            b3Body_ApplyLinearImpulse(bid, b3MulSV(imp, normal), point, true);
        }
    }
    out[0] = (float)(pos.x - start.x); out[1] = (float)(pos.y - start.y); out[2] = (float)(pos.z - start.z);
    out[3] = (float)grounded; out[4] = ny; out[5] = (float)pc.count;
}
