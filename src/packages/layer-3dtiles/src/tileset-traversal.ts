// ============================================================
// layer-3dtiles/tileset-traversal.ts — 3D Tiles BVH 遍历器
// 从 tileset.json 根节点出发，按 SSE（Screen-Space Error）策略
// 进行视锥剔除 + LOD 选择，返回可见瓦片列表（按优先级排序）。
// 零 npm 依赖——纯数学运算。
// 依赖层级：L4 场景层，消费 L0 类型。
// ============================================================

/** 构建时由打包器注入；未定义时视为生产环境。 */
declare const __DEV__: boolean;

// ===================== 常量 =====================

/**
 * 默认 SSE 阈值（像素）。
 * 当瓦片在屏幕上的几何误差低于此阈值时，认为精度足够，不继续细分。
 * 16 px 是 Cesium 的默认值。
 */
const DEFAULT_SSE_THRESHOLD = 16;

/**
 * 最大遍历深度（安全阈值，防止恶意/损坏的 tileset.json 导致栈溢出）。
 */
const MAX_TRAVERSAL_DEPTH = 32;

/**
 * 包围球在视锥外的距离容差（米）。
 * 略大于 0 以避免弹出效应（pop-in）。
 */
const FRUSTUM_TOLERANCE_M = 1;

// ===================== 类型接口 =====================

/**
 * 3D Tiles 包围体（Bounding Volume）。
 * 支持 BoundingSphere（OGC 3D Tiles 核心规范）。
 */
export interface BoundingVolume {
    /**
     * 包围球：[centerX, centerY, centerZ, radius]。
     * 坐标系为 ECEF（地心地固坐标系），单位米。
     */
    readonly sphere?: readonly [number, number, number, number];

    /**
     * 包围盒（OBB）：12 个浮点数 [cx,cy,cz, x0,x1,x2, y0,y1,y2, z0,z1,z2]。
     * 中心 + 三个半轴向量。
     */
    readonly box?: readonly number[];

    /**
     * 包围区域（Region）：[west, south, east, north, minHeight, maxHeight]。
     * 弧度 + 米。
     */
    readonly region?: readonly [number, number, number, number, number, number];
}

/**
 * 3D Tiles 节点（Tile）。
 */
export interface TileNode {
    /** 包围体。 */
    readonly boundingVolume: BoundingVolume;

    /** 几何误差（米），值越大表示简化越粗糙。 */
    readonly geometricError: number;

    /** 细化策略：'ADD'（加法）或 'REPLACE'（替换）。 */
    readonly refine?: 'ADD' | 'REPLACE';

    /** 内容 URL（相对或绝对路径）。 */
    readonly content?: {
        readonly uri?: string;
        readonly url?: string;
    };

    /** 变换矩阵（4×4 列主序，可选）。 */
    readonly transform?: readonly number[];

    /** 子节点列表。 */
    readonly children?: readonly TileNode[];
}

/**
 * 相机状态（遍历所需的最小子集）。
 */
export interface TraversalCamera {
    /** 相机位置（ECEF 坐标，米）。 */
    readonly position: readonly [number, number, number];

    /** 视锥平面法线列表（6 个平面，每平面 [nx, ny, nz, d]）。 */
    readonly frustumPlanes: readonly (readonly [number, number, number, number])[];

    /** 屏幕高度（像素）。 */
    readonly screenHeight: number;

    /** 相机垂直视场角的 tan 值的一半：tan(fovY / 2)。 */
    readonly sseDenominator: number;
}

/**
 * 可见瓦片条目（遍历结果）。
 */
export interface VisibleTile {
    /** 节点引用。 */
    readonly node: TileNode;

    /** 瓦片到相机的距离（米）。 */
    readonly distanceToCamera: number;

    /** 瓦片在屏幕上的估计像素误差。 */
    readonly screenSpaceError: number;

    /** 遍历深度。 */
    readonly depth: number;

    /** 优先级分数（越小越优先加载渲染）。 */
    readonly priority: number;

    /** 内容 URI（如有）。 */
    readonly contentUri: string | null;
}

// ===================== 纯数学辅助函数 =====================

/**
 * 计算三维点到相机的欧氏距离。
 *
 * @param cx - 点 X
 * @param cy - 点 Y
 * @param cz - 点 Z
 * @param px - 相机 X
 * @param py - 相机 Y
 * @param pz - 相机 Z
 * @returns 距离（米）
 */
function distance3D(
    cx: number, cy: number, cz: number,
    px: number, py: number, pz: number,
): number {
    const dx = cx - px;
    const dy = cy - py;
    const dz = cz - pz;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * 计算包围球到视锥平面的有符号距离（正=在平面正侧/内部）。
 *
 * @param plane - [nx, ny, nz, d] 平面方程
 * @param cx - 球心 X
 * @param cy - 球心 Y
 * @param cz - 球心 Z
 * @returns 有符号距离
 */
function signedDistanceToPlane(
    plane: readonly [number, number, number, number],
    cx: number, cy: number, cz: number,
): number {
    return plane[0] * cx + plane[1] * cy + plane[2] * cz + plane[3];
}

/**
 * 判断包围球是否在视锥内（或与视锥相交）。
 * 使用 6 平面测试：若球完全在任一平面外侧，则不可见。
 *
 * @param planes - 视锥 6 个平面
 * @param cx - 球心 X
 * @param cy - 球心 Y
 * @param cz - 球心 Z
 * @param radius - 半径
 * @returns true=可见（完全在内或相交），false=完全在外
 */
function isSphereInFrustum(
    planes: readonly (readonly [number, number, number, number])[],
    cx: number, cy: number, cz: number,
    radius: number,
): boolean {
    for (let i = 0; i < planes.length; i++) {
        const d = signedDistanceToPlane(planes[i], cx, cy, cz);
        // 球完全在平面外侧（带容差）
        if (d < -(radius + FRUSTUM_TOLERANCE_M)) {
            return false;
        }
    }
    return true;
}

/**
 * 计算瓦片的屏幕空间误差（SSE）。
 * SSE = geometricError × screenHeight / (distance × 2 × tan(fovY/2))
 *
 * @param geometricError - 几何误差（米）
 * @param distance - 到相机的距离（米）
 * @param screenHeight - 屏幕高度（像素）
 * @param sseDenominator - 2 × tan(fovY/2)
 * @returns 屏幕像素误差
 */
function computeSSE(
    geometricError: number,
    distance: number,
    screenHeight: number,
    sseDenominator: number,
): number {
    // 距离为零或负时视为无限近，SSE 取极大值
    if (distance <= 0) {
        return Infinity;
    }
    return (geometricError * screenHeight) / (distance * sseDenominator);
}

/**
 * 从 BoundingVolume 提取球心与半径。
 * 当前仅支持 `sphere` 字段；`box` 和 `region` 转换为包围球近似。
 *
 * @param bv - 包围体
 * @returns [cx, cy, cz, radius] 或 null
 */
function extractBoundingSphere(bv: BoundingVolume): [number, number, number, number] | null {
    if (bv.sphere !== undefined && bv.sphere.length >= 4) {
        return [bv.sphere[0], bv.sphere[1], bv.sphere[2], bv.sphere[3]];
    }

    if (bv.box !== undefined && bv.box.length >= 12) {
        // OBB 转包围球：球心 = 盒中心，半径 = 三半轴长度之和
        const cx = bv.box[0];
        const cy = bv.box[1];
        const cz = bv.box[2];
        // 三个半轴向量
        const ax = Math.sqrt(bv.box[3] * bv.box[3] + bv.box[4] * bv.box[4] + bv.box[5] * bv.box[5]);
        const ay = Math.sqrt(bv.box[6] * bv.box[6] + bv.box[7] * bv.box[7] + bv.box[8] * bv.box[8]);
        const az = Math.sqrt(bv.box[9] * bv.box[9] + bv.box[10] * bv.box[10] + bv.box[11] * bv.box[11]);
        // 保守估计：取三半轴长度的最大对角线
        const radius = Math.sqrt(ax * ax + ay * ay + az * az);
        return [cx, cy, cz, radius];
    }

    if (bv.region !== undefined && bv.region.length >= 6) {
        // Region → 包围球近似（取区域中心 + 对角线半径）
        const west = bv.region[0];
        const south = bv.region[1];
        const east = bv.region[2];
        const north = bv.region[3];
        const minH = bv.region[4];
        const maxH = bv.region[5];

        // 取中心经纬（弧度）和平均高度
        const centerLon = (west + east) * 0.5;
        const centerLat = (south + north) * 0.5;
        const centerH = (minH + maxH) * 0.5;

        // 简化 ECEF 转换（球面近似，R = 6371000m）
        const R = 6371000 + centerH;
        const cosLat = Math.cos(centerLat);
        const cx = R * cosLat * Math.cos(centerLon);
        const cy = R * cosLat * Math.sin(centerLon);
        const cz = R * Math.sin(centerLat);

        // 半径：经度跨度 × R × cosLat / 2 与纬度跨度 × R / 2 与高度跨度 / 2 的空间对角线
        const dLon = (east - west) * 0.5 * R * cosLat;
        const dLat = (north - south) * 0.5 * R;
        const dH = (maxH - minH) * 0.5;
        const radius = Math.sqrt(dLon * dLon + dLat * dLat + dH * dH);

        return [cx, cy, cz, radius];
    }

    return null;
}

/**
 * 提取节点的内容 URI。
 *
 * @param node - 瓦片节点
 * @returns URI 字符串或 null
 */
function getContentUri(node: TileNode): string | null {
    if (node.content === undefined) {
        return null;
    }
    return node.content.uri ?? node.content.url ?? null;
}

// ===================== 公共遍历函数 =====================

/**
 * 遍历 3D Tiles BVH 树，返回当前帧可见的瓦片列表（按优先级排序）。
 *
 * 遍历策略：
 * 1. 从根节点开始，递归检查每个节点的包围体是否在视锥内
 * 2. 计算每个可见节点的 SSE
 * 3. SSE ≤ sseThreshold → 当前节点足够精细，加入可见列表
 * 4. SSE > sseThreshold → 继续细分到子节点
 * 5. ADD 模式：父子同时渲染；REPLACE 模式：仅渲染叶子
 *
 * @param root - tileset.json 根节点
 * @param camera - 相机状态
 * @param sseThreshold - SSE 阈值（像素），默认 16
 * @returns 按优先级排序的可见瓦片列表（priority 越小越优先）
 *
 * @stability stable
 *
 * @example
 * const visible = traverseTileset(root, camera, 16);
 * for (const tile of visible) {
 *   requestTileContent(tile.contentUri, tile.priority);
 * }
 */
export function traverseTileset(
    root: TileNode,
    camera: TraversalCamera,
    sseThreshold: number = DEFAULT_SSE_THRESHOLD,
): VisibleTile[] {
    // 参数校验
    const sse = Math.max(1, Number.isFinite(sseThreshold) ? sseThreshold : DEFAULT_SSE_THRESHOLD);
    const result: VisibleTile[] = [];

    // 使用迭代栈代替递归（防深层 tileset 栈溢出）
    interface StackEntry {
        node: TileNode;
        depth: number;
        parentRefine: 'ADD' | 'REPLACE';
    }

    const stack: StackEntry[] = [{
        node: root,
        depth: 0,
        parentRefine: root.refine ?? 'REPLACE',
    }];

    while (stack.length > 0) {
        const entry = stack.pop()!;
        const { node, depth, parentRefine } = entry;

        // 深度保护
        if (depth > MAX_TRAVERSAL_DEPTH) {
            if (__DEV__) {
                // eslint-disable-next-line no-console
                console.warn('[3DTiles] 遍历深度超限:', depth);
            }
            continue;
        }

        // 提取包围球
        const sphere = extractBoundingSphere(node.boundingVolume);
        if (sphere === null) {
            // 无法识别的包围体，跳过
            if (__DEV__) {
                // eslint-disable-next-line no-console
                console.warn('[3DTiles] 无法解析包围体');
            }
            continue;
        }

        const [cx, cy, cz, radius] = sphere;

        // 视锥剔除
        if (!isSphereInFrustum(camera.frustumPlanes, cx, cy, cz, radius)) {
            continue;
        }

        // 计算到相机的距离
        const dist = Math.max(
            distance3D(cx, cy, cz, camera.position[0], camera.position[1], camera.position[2]) - radius,
            0.001,
        );

        // 计算 SSE
        const tileSSE = computeSSE(
            node.geometricError,
            dist,
            camera.screenHeight,
            camera.sseDenominator,
        );

        const refine = node.refine ?? parentRefine;
        const hasChildren = node.children !== undefined && node.children.length > 0;
        const contentUri = getContentUri(node);

        // 决策：是否需要继续细分
        const needsRefinement = tileSSE > sse && hasChildren;

        if (needsRefinement) {
            // 需要细分：检查子节点
            if (refine === 'ADD') {
                // ADD 模式：父节点也要渲染（如果有内容）
                if (contentUri !== null) {
                    result.push({
                        node,
                        distanceToCamera: dist,
                        screenSpaceError: tileSSE,
                        depth,
                        priority: dist,
                        contentUri,
                    });
                }
            }
            // REPLACE 模式：不渲染父节点，只渲染子节点

            // 将子节点压入栈
            const children = node.children!;
            for (let i = children.length - 1; i >= 0; i--) {
                stack.push({
                    node: children[i],
                    depth: depth + 1,
                    parentRefine: refine,
                });
            }
        } else {
            // 不需要细分（SSE 足够小或无子节点）：加入可见列表
            if (contentUri !== null) {
                result.push({
                    node,
                    distanceToCamera: dist,
                    screenSpaceError: tileSSE,
                    depth,
                    priority: dist,
                    contentUri,
                });
            }
        }
    }

    // 按优先级排序（距离近的优先渲染/加载）
    result.sort((a, b) => a.priority - b.priority);

    return result;
}
