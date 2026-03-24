/**
 * 2.5D Camera pipeline — pure math, zero dependencies.
 *
 * Implements the exact algorithm from `GeoForge_25D_Rendering_Pipeline.md`:
 *   - Web Mercator coordinate conversions (§II)
 *   - Camera matrix computation with dynamic farZ (§III)
 *   - Screen ↔ world un/projection via inverse VP (§III.5)
 *   - Frustum-culled, LOD-aware covering-tiles (§IV)
 *
 * All matrices are **column-major Float32Array[16]** (WebGPU / wgpu-matrix convention).
 *
 * @module useCamera25D
 * @stability experimental
 */

// ═══════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════

/**
 * World-coordinate tile size (matches the design doc, NOT the 256 px OSM raster).
 * worldSize = TILE_SIZE × 2^zoom.
 */
const TILE_SIZE = 512;

// ═══════════════════════════════════════════════════════════
// Type definitions
// ═══════════════════════════════════════════════════════════

/** Viewport dimensions in CSS / device pixels. */
interface Viewport {
    /** Horizontal extent (px). */
    width: number;
    /** Vertical extent (px). */
    height: number;
}

/**
 * Full camera state produced by {@link computeCamera25D}.
 *
 * Every matrix is a column-major `Float32Array[16]`.
 */
interface Camera25DState {
    /** Perspective projection matrix (Z ∈ [0,1], near→0 far→1). */
    projMatrix: Float32Array;
    /** LookAt view matrix. */
    viewMatrix: Float32Array;
    /** Combined view-projection matrix (`proj × view`). */
    vpMatrix: Float32Array;
    /** Inverse of `vpMatrix` — used by {@link screenToWorld}. */
    inverseVP: Float32Array;

    /** Near clip distance (world-pixel units). */
    nearZ: number;
    /** Far clip distance (world-pixel units). */
    farZ: number;

    /** Distance from camera to the look-at center on the ground plane. */
    cameraToCenterDist: number;
    /** Camera position in world-pixel coordinates [x, y, z]. */
    cameraPosition: [number, number, number];
    /** TILE_SIZE × 2^zoom. */
    worldSize: number;

    /** Original center [lng, lat] passed to {@link computeCamera25D}. */
    center: [number, number];
    /** Original zoom. */
    zoom: number;
    /** Original pitch (radians). */
    pitch: number;
    /** Original bearing (radians). */
    bearing: number;
    /** Original vertical FOV (radians). */
    fov: number;
    /** Original viewport. */
    viewport: Viewport;
}

/** Tile identifier with distance for painter-sort. */
interface TileID {
    /** Integer zoom level of this tile. */
    z: number;
    /** Column index (may exceed 2^z for world copies). */
    x: number;
    /** Row index. */
    y: number;
    /** Dedup key `"z/x/y"`. */
    key: string;
    /** Euclidean distance to the camera center tile (tile-coord units). */
    distToCamera: number;
}

// ═══════════════════════════════════════════════════════════
// Coordinate conversions  (§II)
// ═══════════════════════════════════════════════════════════

/**
 * Geographic longitude/latitude → Mercator normalised [0, 1].
 *
 * Origin is top-left (−180°, +85.05°).
 *
 * @param lng - Longitude in degrees (−180 … +180).
 * @param lat - Latitude in degrees (−85.05 … +85.05).
 * @returns [mx, my] each in [0, 1].
 *
 * @example
 * lngLatToMercator(0, 0); // → [0.5, 0.5]
 */
function lngLatToMercator(lng: number, lat: number): [number, number] {
    /* Normalised x: shift by 180° then divide full 360° range */
    const x = (lng + 180) / 360;

    /* Mercator y via the Gudermannian inverse (Web Mercator formula) */
    const sinLat = Math.sin(lat * Math.PI / 180);
    const y = 0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI);

    return [x, y];
}

/**
 * Geographic → world-pixel coordinates.
 *
 * @param lng       - Longitude (degrees).
 * @param lat       - Latitude (degrees).
 * @param worldSize - TILE_SIZE × 2^zoom.
 * @returns [wx, wy] in [0, worldSize].
 *
 * @example
 * lngLatToWorld(0, 0, 524288); // → [262144, 262144]
 */
function lngLatToWorld(lng: number, lat: number, worldSize: number): [number, number] {
    const [mx, my] = lngLatToMercator(lng, lat);
    return [mx * worldSize, my * worldSize];
}

/**
 * Mercator normalised [0, 1] → geographic [lng, lat].
 *
 * @param mx - Normalised x in [0, 1].
 * @param my - Normalised y in [0, 1].
 * @returns [lng, lat] in degrees.
 *
 * @example
 * mercatorToLngLat(0.5, 0.5); // → [0, 0]
 */
function mercatorToLngLat(mx: number, my: number): [number, number] {
    const lng = mx * 360 - 180;
    /* Inverse Gudermannian */
    const latRad = Math.atan(Math.sinh(Math.PI * (1 - 2 * my)));
    const lat = latRad * 180 / Math.PI;
    return [lng, lat];
}

/**
 * World-pixel coordinates → geographic [lng, lat].
 *
 * @param wx        - World x in [0, worldSize].
 * @param wy        - World y in [0, worldSize].
 * @param worldSize - TILE_SIZE × 2^zoom.
 * @returns [lng, lat] in degrees.
 *
 * @example
 * worldToLngLat(262144, 262144, 524288); // → [0, 0]
 */
function worldToLngLat(wx: number, wy: number, worldSize: number): [number, number] {
    return mercatorToLngLat(wx / worldSize, wy / worldSize);
}

// ═══════════════════════════════════════════════════════════
// mat4 helpers  (§III.4)
// ═══════════════════════════════════════════════════════════

/**
 * Standard Z [0,1] perspective projection (WebGPU convention).
 *
 * Column-major layout:
 * ```
 * col0  col1  col2          col3
 * f/a    0     0             0
 *  0     f     0             0
 *  0     0   far/(n-f)     -1
 *  0     0   n*f/(n-f)      0
 * ```
 *
 * @param out    - Destination Float32Array[16].
 * @param fovY   - Vertical field-of-view (radians).
 * @param aspect - width / height.
 * @param near   - Near clip distance (> 0).
 * @param far    - Far clip distance (> near).
 * @returns `out` for chaining.
 */
function mat4_perspectiveZO(
    out: Float32Array,
    fovY: number,
    aspect: number,
    near: number,
    far: number,
): Float32Array {
    /* f = cot(fovY/2) = 1 / tan(fovY/2) */
    const f = 1.0 / Math.tan(fovY / 2);
    /* Denominator for Z mapping: 1/(near − far) */
    const nf = 1.0 / (near - far);

    out.fill(0);
    out[0] = f / aspect;           // col0.x
    out[5] = f;                    // col1.y
    out[10] = far * nf;            // col2.z  = far / (near − far), negative
    out[11] = -1.0;                // col2.w  → enables perspective divide
    out[14] = near * far * nf;     // col3.z  = (near × far) / (near − far), negative
    return out;
}

/**
 * LookAt view matrix (column-major).
 *
 * Constructs an orthonormal basis from `eye`, `center`, and `up`,
 * then applies the camera translation.
 *
 * @param out    - Destination Float32Array[16].
 * @param eye    - Camera position [x, y, z].
 * @param center - Look-at target [x, y, z].
 * @param up     - World up direction [x, y, z].
 * @returns `out` for chaining.
 */
function mat4_lookAt(
    out: Float32Array,
    eye: number[],
    center: number[],
    up: number[],
): Float32Array {
    /* Forward axis z = normalise(eye − center) */
    let z0 = eye[0] - center[0];
    let z1 = eye[1] - center[1];
    let z2 = eye[2] - center[2];
    let len = 1 / Math.sqrt(z0 * z0 + z1 * z1 + z2 * z2);
    z0 *= len; z1 *= len; z2 *= len;

    /* Right axis x = normalise(up × z) */
    let x0 = up[1] * z2 - up[2] * z1;
    let x1 = up[2] * z0 - up[0] * z2;
    let x2 = up[0] * z1 - up[1] * z0;
    len = Math.sqrt(x0 * x0 + x1 * x1 + x2 * x2);
    if (len > 1e-10) { len = 1 / len; x0 *= len; x1 *= len; x2 *= len; }

    /* Recomputed up y = z × x (guaranteed orthogonal) */
    let y0 = z1 * x2 - z2 * x1;
    let y1 = z2 * x0 - z0 * x2;
    let y2 = z0 * x1 - z1 * x0;
    len = Math.sqrt(y0 * y0 + y1 * y1 + y2 * y2);
    if (len > 1e-10) { len = 1 / len; y0 *= len; y1 *= len; y2 *= len; }

    /* Column-major storage */
    out[0] = x0; out[1] = y0; out[2] = z0; out[3] = 0;
    out[4] = x1; out[5] = y1; out[6] = z1; out[7] = 0;
    out[8] = x2; out[9] = y2; out[10] = z2; out[11] = 0;
    out[12] = -(x0 * eye[0] + x1 * eye[1] + x2 * eye[2]);
    out[13] = -(y0 * eye[0] + y1 * eye[1] + y2 * eye[2]);
    out[14] = -(z0 * eye[0] + z1 * eye[1] + z2 * eye[2]);
    out[15] = 1;
    return out;
}

/**
 * 4 × 4 matrix multiply `out = a × b` (column-major).
 *
 * @param out - Destination Float32Array[16] (may alias neither `a` nor `b`).
 * @param a   - Left operand.
 * @param b   - Right operand.
 * @returns `out` for chaining.
 */
function mat4_multiply(
    out: Float32Array,
    a: Float32Array,
    b: Float32Array,
): Float32Array {
    /* Each output element out[col*4+row] = Σ_k a[k*4+row] * b[col*4+k] */
    for (let col = 0; col < 4; col++) {
        for (let row = 0; row < 4; row++) {
            out[col * 4 + row] =
                a[row]      * b[col * 4]     +
                a[4 + row]  * b[col * 4 + 1] +
                a[8 + row]  * b[col * 4 + 2] +
                a[12 + row] * b[col * 4 + 3];
        }
    }
    return out;
}

/**
 * Full 4 × 4 matrix inversion via Cramer's Rule.
 *
 * Based on the classic 24-cofactor expansion.  Returns `false` if the
 * matrix is singular (determinant ≈ 0); in that case `out` is zeroed.
 *
 * @param out - Destination Float32Array[16].
 * @param a   - Source matrix.
 * @returns `true` on success, `false` if the matrix is not invertible.
 */
function mat4_invert(out: Float32Array, a: Float32Array): boolean {
    /* Alias source elements for readability (column-major indices). */
    const a00 = a[0],  a01 = a[1],  a02 = a[2],  a03 = a[3];
    const a10 = a[4],  a11 = a[5],  a12 = a[6],  a13 = a[7];
    const a20 = a[8],  a21 = a[9],  a22 = a[10], a23 = a[11];
    const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];

    /* 2×2 sub-determinants (reused across cofactors) */
    const b00 = a00 * a11 - a01 * a10;
    const b01 = a00 * a12 - a02 * a10;
    const b02 = a00 * a13 - a03 * a10;
    const b03 = a01 * a12 - a02 * a11;
    const b04 = a01 * a13 - a03 * a11;
    const b05 = a02 * a13 - a03 * a12;
    const b06 = a20 * a31 - a21 * a30;
    const b07 = a20 * a32 - a22 * a30;
    const b08 = a20 * a33 - a23 * a30;
    const b09 = a21 * a32 - a22 * a31;
    const b10 = a21 * a33 - a23 * a31;
    const b11 = a22 * a33 - a23 * a32;

    /* Full 4×4 determinant */
    let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;

    if (Math.abs(det) < 1e-12) {
        /* Singular — zero out destination and signal failure */
        out.fill(0);
        return false;
    }

    det = 1.0 / det;

    /* Write adjugate / det into out (column-major order) */
    out[0]  = ( a11 * b11 - a12 * b10 + a13 * b09) * det;
    out[1]  = (-a01 * b11 + a02 * b10 - a03 * b09) * det;
    out[2]  = ( a31 * b05 - a32 * b04 + a33 * b03) * det;
    out[3]  = (-a21 * b05 + a22 * b04 - a23 * b03) * det;

    out[4]  = (-a10 * b11 + a12 * b08 - a13 * b07) * det;
    out[5]  = ( a00 * b11 - a02 * b08 + a03 * b07) * det;
    out[6]  = (-a30 * b05 + a32 * b02 - a33 * b01) * det;
    out[7]  = ( a20 * b05 - a22 * b02 + a23 * b01) * det;

    out[8]  = ( a10 * b10 - a11 * b08 + a13 * b06) * det;
    out[9]  = (-a00 * b10 + a01 * b08 - a03 * b06) * det;
    out[10] = ( a30 * b04 - a31 * b02 + a33 * b00) * det;
    out[11] = (-a20 * b04 + a21 * b02 - a23 * b00) * det;

    out[12] = (-a10 * b09 + a11 * b07 - a12 * b06) * det;
    out[13] = ( a00 * b09 - a01 * b07 + a02 * b06) * det;
    out[14] = (-a30 * b03 + a31 * b01 - a32 * b00) * det;
    out[15] = ( a20 * b03 - a21 * b01 + a22 * b00) * det;

    return true;
}

/**
 * Multiply a column-major 4×4 matrix by a 4-component vector.
 *
 * @param m - Column-major Float32Array[16].
 * @param v - [x, y, z, w].
 * @returns Resulting [x, y, z, w].
 */
function transformVec4(m: Float32Array, v: number[]): number[] {
    return [
        m[0] * v[0] + m[4] * v[1] + m[8]  * v[2] + m[12] * v[3],
        m[1] * v[0] + m[5] * v[1] + m[9]  * v[2] + m[13] * v[3],
        m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14] * v[3],
        m[3] * v[0] + m[7] * v[1] + m[11] * v[2] + m[15] * v[3],
    ];
}

// ═══════════════════════════════════════════════════════════
// Camera computation  (§III.3)
// ═══════════════════════════════════════════════════════════

/**
 * Compute the full 2.5D camera state from user parameters.
 *
 * Geometry:
 * ```
 *   Camera ●─── cameraToCenterDist ───● Center (ground)
 *         ╱                              ↑
 *   h = ctcd×cos(pitch)                  │
 *       ╱                                │
 *      ╱  pitch                          │
 * ════╱═══════════════════ ground z=0 ═══
 * ```
 *
 * @param center   - [lng, lat] in degrees.
 * @param zoom     - Fractional zoom level.
 * @param pitch    - Tilt angle in **radians** (0 = top-down).
 * @param bearing  - Rotation in **radians** (0 = north-up, CW positive).
 * @param fov      - Vertical field-of-view in **radians** (default 0.6435 ≈ 36.87°).
 * @param viewport - { width, height } in pixels.
 * @returns Complete {@link Camera25DState}.
 *
 * @example
 * const cam = computeCamera25D([0, 0], 10, 0.611, 0, 0.6435, { width: 1232, height: 960 });
 */
function computeCamera25D(
    center: [number, number],
    zoom: number,
    pitch: number,
    bearing: number,
    fov: number,
    viewport: Viewport,
): Camera25DState {

    const halfFov = fov / 2;
    const worldSize = TILE_SIZE * Math.pow(2, zoom);
    const aspect = viewport.width / viewport.height;

    // ── 1. Distance from camera to center point on ground ──
    const cameraToCenterDist = viewport.height / 2 / Math.tan(halfFov);

    // ── 2. Dynamic farZ (§III.2 look-up table logic) ──
    let farZ: number;
    if (pitch < 0.01) {
        /* pitch ≈ 0: orthographic-equivalent fast path */
        farZ = cameraToCenterDist * 2.0;
    } else {
        const angleToHorizon = Math.PI / 2 - pitch - halfFov;
        if (angleToHorizon > 0.01) {
            /* Surface distance from center to the top frustum edge on the ground */
            const topHalfSurfaceDist =
                Math.sin(pitch) * cameraToCenterDist / Math.sin(angleToHorizon);
            farZ = topHalfSurfaceDist * 1.5;
        } else {
            /* Near-horizontal gaze — cap at 100× to avoid extreme depth range */
            farZ = cameraToCenterDist * 100.0;
        }
        /* Never less than the 2× floor (so even low pitches get adequate range) */
        farZ = Math.max(farZ, cameraToCenterDist * 2.0);
    }

    // ── 3. nearZ ──
    const nearZ = cameraToCenterDist * 0.1;

    // ── 4. Projection matrix (standard Z [0,1], non-Reversed-Z) ──
    const projMatrix = new Float32Array(16);
    mat4_perspectiveZO(projMatrix, fov, aspect, nearZ, farZ);

    // ── 5. Camera position in world-pixel space ──
    const [centerWX, centerWY] = lngLatToWorld(center[0], center[1], worldSize);
    const offsetBack = Math.sin(pitch) * cameraToCenterDist;
    const height = Math.cos(pitch) * cameraToCenterDist;
    const camX = centerWX + Math.sin(bearing) * offsetBack;
    const camY = centerWY - Math.cos(bearing) * offsetBack;
    const camZ = height;

    // ── 6. View matrix (up = world-Z, always [0,0,1]) ──
    const viewMatrix = new Float32Array(16);
    mat4_lookAt(
        viewMatrix,
        [camX, camY, camZ],
        [centerWX, centerWY, 0],
        [0, 0, 1],
    );

    // ── 7. VP = proj × view ──
    const vpMatrix = new Float32Array(16);
    mat4_multiply(vpMatrix, projMatrix, viewMatrix);

    // ── 8. Inverse VP (needed by screenToWorld) ──
    const inverseVP = new Float32Array(16);
    mat4_invert(inverseVP, vpMatrix);

    return {
        projMatrix, viewMatrix, vpMatrix, inverseVP,
        nearZ, farZ, cameraToCenterDist,
        cameraPosition: [camX, camY, camZ],
        worldSize, center, zoom, pitch, bearing, fov, viewport,
    };
}

// ═══════════════════════════════════════════════════════════
// Screen ↔ World  (§III.5)
// ═══════════════════════════════════════════════════════════

/**
 * Un-project a screen pixel to the z = 0 ground plane.
 *
 * Shoots a ray from the near to the far clip plane through the given pixel,
 * then intersects with z = 0.
 *
 * @param sx     - Screen x (CSS pixels, 0 = left).
 * @param sy     - Screen y (CSS pixels, 0 = top).
 * @param camera - {@link Camera25DState} from {@link computeCamera25D}.
 * @returns [wx, wy] world-pixel coords, or `null` when the ray is parallel to / points away from the ground.
 */
function screenToWorld(
    sx: number,
    sy: number,
    camera: Camera25DState,
): [number, number] | null {
    const { inverseVP, viewport } = camera;

    /* Screen → NDC: x ∈ [-1, 1], y ∈ [-1, 1] (y-up) */
    const ndcX = (sx / viewport.width) * 2 - 1;
    const ndcY = 1 - (sy / viewport.height) * 2;

    /* Unproject two points at z_ndc = 0 (near) and z_ndc = 1 (far) */
    const a = transformVec4(inverseVP, [ndcX, ndcY, 0, 1]);
    const b = transformVec4(inverseVP, [ndcX, ndcY, 1, 1]);

    /* Perspective divide → world coords */
    const nearPt = [a[0] / a[3], a[1] / a[3], a[2] / a[3]];
    const farPt = [b[0] / b[3], b[1] / b[3], b[2] / b[3]];

    /* Solve for t where nearPt + t*(farPt − nearPt) has z = 0 */
    const dz = farPt[2] - nearPt[2];
    if (Math.abs(dz) < 1e-10) return null;
    const t = -nearPt[2] / dz;
    if (t < 0) return null;

    return [
        nearPt[0] + t * (farPt[0] - nearPt[0]),
        nearPt[1] + t * (farPt[1] - nearPt[1]),
    ];
}

/**
 * Project a ground-plane world coordinate to screen pixels.
 *
 * @param wx     - World x.
 * @param wy     - World y.
 * @param camera - {@link Camera25DState}.
 * @returns [sx, sy] in CSS pixel coordinates (0,0 = top-left).
 */
function worldToScreen(
    wx: number,
    wy: number,
    camera: Camera25DState,
): [number, number] {
    /* World point on z = 0 ground plane → clip space */
    const clip = transformVec4(camera.vpMatrix, [wx, wy, 0, 1]);

    /* Perspective divide → NDC */
    const ndcX = clip[0] / clip[3];
    const ndcY = clip[1] / clip[3];

    /* NDC → screen (y flipped: NDC +1 is screen top = 0) */
    return [
        (ndcX + 1) / 2 * camera.viewport.width,
        (1 - ndcY) / 2 * camera.viewport.height,
    ];
}

/**
 * Fallback for {@link screenToWorld} when the ray misses the ground (looks above horizon).
 *
 * Projects the ray horizontally and takes a point at ~0.9× farZ distance.
 *
 * @param sx     - Screen x.
 * @param sy     - Screen y.
 * @param camera - {@link Camera25DState}.
 * @returns [wx, wy] approximate ground coordinate at the far edge.
 */
function screenToHorizon(
    sx: number,
    sy: number,
    camera: Camera25DState,
): [number, number] {
    const { inverseVP, viewport, cameraPosition, farZ } = camera;

    /* Unproject the far-plane point */
    const ndcX = (sx / viewport.width) * 2 - 1;
    const ndcY = 1 - (sy / viewport.height) * 2;
    const fp = transformVec4(inverseVP, [ndcX, ndcY, 1, 1]);
    const farPt = [fp[0] / fp[3], fp[1] / fp[3], fp[2] / fp[3]];

    /* Horizontal direction from camera to far point */
    const dx = farPt[0] - cameraPosition[0];
    const dy = farPt[1] - cameraPosition[1];
    const hLen = Math.sqrt(dx * dx + dy * dy);

    if (hLen < 1e-6) return [cameraPosition[0], cameraPosition[1]];

    /* Walk 90% of farZ along the horizontal direction */
    const t = farZ * 0.9 / hLen;
    return [
        cameraPosition[0] + dx * t,
        cameraPosition[1] + dy * t,
    ];
}

// ═══════════════════════════════════════════════════════════
// Frustum culling  (§IV.3)
// ═══════════════════════════════════════════════════════════

/**
 * Normalise a plane equation [a,b,c,d] so that (a²+b²+c²) = 1.
 *
 * @param a - Plane normal x.
 * @param b - Plane normal y.
 * @param c - Plane normal z.
 * @param d - Signed distance.
 * @returns Float32Array[4] with unit normal.
 */
function normalizePlane(a: number, b: number, c: number, d: number): Float32Array {
    const len = Math.sqrt(a * a + b * b + c * c);
    return new Float32Array([a / len, b / len, c / len, d / len]);
}

/**
 * Extract the six frustum planes from a VP matrix (Gribb-Hartmann method).
 *
 * Each plane [a,b,c,d]: `a·x + b·y + c·z + d ≥ 0` ⟹ inside.
 *
 * @param vp - Column-major VP matrix.
 * @returns Array of 6 Float32Array[4] planes (left, right, bottom, top, near, far).
 */
function extractFrustumPlanes(vp: Float32Array): Float32Array[] {
    /* Column-major accessor: element at row `r`, column `c`. */
    const row = (r: number, c: number) => vp[c * 4 + r];

    const planes: Float32Array[] = [];

    /* Left:   row3 + row0 */
    planes.push(normalizePlane(
        row(3, 0) + row(0, 0), row(3, 1) + row(0, 1),
        row(3, 2) + row(0, 2), row(3, 3) + row(0, 3)));
    /* Right:  row3 − row0 */
    planes.push(normalizePlane(
        row(3, 0) - row(0, 0), row(3, 1) - row(0, 1),
        row(3, 2) - row(0, 2), row(3, 3) - row(0, 3)));
    /* Bottom: row3 + row1 */
    planes.push(normalizePlane(
        row(3, 0) + row(1, 0), row(3, 1) + row(1, 1),
        row(3, 2) + row(1, 2), row(3, 3) + row(1, 3)));
    /* Top:    row3 − row1 */
    planes.push(normalizePlane(
        row(3, 0) - row(1, 0), row(3, 1) - row(1, 1),
        row(3, 2) - row(1, 2), row(3, 3) - row(1, 3)));
    /* Near:   row3 + row2 (standard Z) */
    planes.push(normalizePlane(
        row(3, 0) + row(2, 0), row(3, 1) + row(2, 1),
        row(3, 2) + row(2, 2), row(3, 3) + row(2, 3)));
    /* Far:    row3 − row2 */
    planes.push(normalizePlane(
        row(3, 0) - row(2, 0), row(3, 1) - row(2, 1),
        row(3, 2) - row(2, 2), row(3, 3) - row(2, 3)));

    return planes;
}

/**
 * AABB-vs-frustum visibility test for a ground-plane tile.
 *
 * The tile's AABB is flat (z = 0 everywhere), so only the x/y
 * P-vertex matters.
 *
 * @param tx        - Tile column index at zoom `tz`.
 * @param ty        - Tile row index at zoom `tz`.
 * @param tz        - Tile zoom level.
 * @param worldSize - TILE_SIZE × 2^zoom (the camera's floating-point worldSize).
 * @param planes    - Frustum planes from {@link extractFrustumPlanes}.
 * @returns `true` if the tile may be visible (conservative).
 */
function tileInFrustum(
    tx: number,
    ty: number,
    tz: number,
    worldSize: number,
    planes: Float32Array[],
): boolean {
    /* Scale factor: worldSize / (TILE_SIZE × 2^tz) maps tile-grid coords → world pixels */
    const scale = worldSize / (TILE_SIZE * (1 << tz));
    const x0 = tx * TILE_SIZE * scale;
    const y0 = ty * TILE_SIZE * scale;
    const x1 = (tx + 1) * TILE_SIZE * scale;
    const y1 = (ty + 1) * TILE_SIZE * scale;

    /* For each frustum plane, pick the AABB corner farthest along the plane normal
       (P-vertex). If the P-vertex is outside the plane, the entire AABB is outside. */
    for (const p of planes) {
        const px = p[0] >= 0 ? x1 : x0;
        const py = p[1] >= 0 ? y1 : y0;
        /* z is always 0 for ground tiles, so p[2]*pz is always 0. */
        if (p[0] * px + p[1] * py + p[3] < 0) return false;
    }
    return true;
}

// ═══════════════════════════════════════════════════════════
// Covering tiles  (§IV.2)
// ═══════════════════════════════════════════════════════════

/**
 * Determine which tiles are visible in the current 2.5D camera view.
 *
 * Steps:
 *   1. Sample 20 screen-edge points + center → un-project to ground.
 *   2. Compute bounding tile range at `floor(zoom)`.
 *   3. Enumerate candidates with LOD drop for distant tiles.
 *   4. Frustum-cull each candidate.
 *   5. (zoom < 3) add world copies for wrap-around.
 *   6. Sort near→far (caller may reverse for painter's algorithm).
 *
 * @param camera - {@link Camera25DState} from {@link computeCamera25D}.
 * @returns Sorted array of visible {@link TileID}s.
 *
 * @example
 * const cam = computeCamera25D([0, 0], 10, 0.611, 0, 0.6435, { width: 1232, height: 960 });
 * const tiles = coveringTiles(cam); // ~30-200 tiles at pitch=35°
 */
function coveringTiles(camera: Camera25DState): TileID[] {
    const { zoom, viewport, worldSize } = camera;
    const tileZoom = Math.floor(zoom);
    const numTilesPerAxis = 1 << tileZoom;

    // ── Step 1: Sample screen boundary → ground coordinates ──
    const screenPts: [number, number][] = [];
    const W = viewport.width;
    const H = viewport.height;

    /* Top edge: 5 equally-spaced points */
    for (let i = 0; i <= 4; i++) screenPts.push([W * i / 4, 0]);
    /* Bottom edge: 5 points */
    for (let i = 0; i <= 4; i++) screenPts.push([W * i / 4, H]);
    /* Left edge: 3 interior points */
    for (let i = 1; i <= 3; i++) screenPts.push([0, H * i / 4]);
    /* Right edge: 3 interior points */
    for (let i = 1; i <= 3; i++) screenPts.push([W, H * i / 4]);
    /* Centre */
    screenPts.push([W / 2, H / 2]);

    const groundPts: [number, number][] = [];
    for (const [sx, sy] of screenPts) {
        const wp = screenToWorld(sx, sy, camera);
        /* Fallback to horizon estimate when the ray misses the ground */
        groundPts.push(wp ?? screenToHorizon(sx, sy, camera));
    }

    // ── Step 2: Bounding tile range at tileZoom ──
    let minTX = Infinity, minTY = Infinity;
    let maxTX = -Infinity, maxTY = -Infinity;
    for (const [wx, wy] of groundPts) {
        /* World → normalised → tile-grid coordinate at tileZoom */
        const tx = (wx / worldSize) * numTilesPerAxis;
        const ty = (wy / worldSize) * numTilesPerAxis;
        minTX = Math.min(minTX, tx);
        minTY = Math.min(minTY, ty);
        maxTX = Math.max(maxTX, tx);
        maxTY = Math.max(maxTY, ty);
    }
    /* Clamp to valid tile range */
    minTX = Math.max(0, Math.floor(minTX));
    minTY = Math.max(0, Math.floor(minTY));
    maxTX = Math.min(numTilesPerAxis - 1, Math.ceil(maxTX));
    maxTY = Math.min(numTilesPerAxis - 1, Math.ceil(maxTY));

    // ── Step 3: Enumerate + LOD + frustum cull ──
    const centerMerc = lngLatToMercator(camera.center[0], camera.center[1]);
    const centerTX = centerMerc[0] * numTilesPerAxis;
    const centerTY = centerMerc[1] * numTilesPerAxis;

    const frustumPlanes = extractFrustumPlanes(camera.vpMatrix);
    const seen = new Set<string>();
    const tiles: TileID[] = [];

    for (let y = minTY; y <= maxTY; y++) {
        for (let x = minTX; x <= maxTX; x++) {
            /* Distance from tile centre to camera centre (in tile units) */
            const dist = Math.sqrt((x + 0.5 - centerTX) ** 2 + (y + 0.5 - centerTY) ** 2);

            /* LOD: drop zoom level for distant tiles (max 4 levels) */
            const lodDrop = Math.min(Math.floor(Math.log2(Math.max(1, dist / 3))), 4);
            const z = Math.max(0, tileZoom - lodDrop);

            /* Map the tileZoom-level coords to the parent tile at level z */
            const shift = tileZoom - z;
            const px = x >> shift;
            const py = y >> shift;
            const key = `${z}/${px}/${py}`;

            /* Dedup — many tileZoom children map to the same parent */
            if (seen.has(key)) continue;
            seen.add(key);

            /* Frustum cull */
            if (!tileInFrustum(px, py, z, worldSize, frustumPlanes)) continue;

            tiles.push({ z, x: px, y: py, key, distToCamera: dist });
        }
    }

    // ── Step 4: World copies at low zoom ──
    if (zoom < 3) {
        const copies = [...tiles];
        for (const t of copies) {
            for (const offset of [-1, 1]) {
                const cx = t.x + offset * (1 << t.z);
                const ck = `${t.z}/${cx}/${t.y}`;
                if (!seen.has(ck)) {
                    seen.add(ck);
                    tiles.push({ ...t, x: cx, key: ck });
                }
            }
        }
    }

    /* Sort near→far (early-Z optimal; Canvas 2D callers reverse for painter). */
    tiles.sort((a, b) => a.distToCamera - b.distToCamera);

    return tiles;
}

// ═══════════════════════════════════════════════════════════
// Public exports
// ═══════════════════════════════════════════════════════════

export type { Camera25DState, TileID };

export {
    TILE_SIZE,
    computeCamera25D,
    coveringTiles,
    screenToWorld,
    worldToScreen,
    lngLatToWorld,
    worldToLngLat,
    lngLatToMercator,
    mercatorToLngLat,
};
