// ============================================================
// algorithm/cluster.ts — 聚类算法
// Supercluster（层级点聚合）、DBSCAN（密度聚类）、K-Means
// 零 npm 依赖，全部自研实现。
// ============================================================

// ======================== 类型定义 ========================

/**
 * Supercluster 配置项。
 */
export interface SuperclusterOptions {
    /** 聚合的最小缩放级别，默认 0 */
    readonly minZoom?: number;
    /** 聚合的最大缩放级别，默认 16 */
    readonly maxZoom?: number;
    /** 聚合半径（像素），默认 40 */
    readonly radius?: number;
    /** 瓦片像素大小（用于将半径转换为地理距离），默认 256 */
    readonly extent?: number;
}

/**
 * Supercluster 实例接口。
 */
export interface Supercluster {
    /**
     * 获取给定视口范围和缩放级别下的聚合结果。
     *
     * @param bbox - 视口范围 [westLng, southLat, eastLng, northLat]
     * @param zoom - 当前缩放级别
     * @returns 聚合后的点/簇数组
     */
    getClusters(bbox: [number, number, number, number], zoom: number): ClusterFeature[];

    /**
     * 获取展开某个聚合簇所需的缩放级别。
     *
     * @param clusterId - 簇 ID
     * @returns 展开缩放级别
     */
    getClusterExpansionZoom(clusterId: number): number;
}

/**
 * 聚合结果中的单个要素（点或簇）。
 */
export interface ClusterFeature {
    /** 经度 */
    readonly x: number;
    /** 纬度 */
    readonly y: number;
    /** 是否为聚合簇（true = 簇，false = 原始点） */
    readonly isCluster: boolean;
    /** 簇 ID（仅当 isCluster=true）*/
    readonly clusterId: number;
    /** 簇内点数（仅当 isCluster=true）*/
    readonly pointCount: number;
    /** 原始点索引（仅当 isCluster=false）*/
    readonly index: number;
}

/**
 * K-Means 聚类结果。
 */
export interface KMeansResult {
    /** 聚类中心点坐标 */
    readonly centroids: number[][];
    /** 每个输入点的聚类标签（0-based 索引） */
    readonly labels: number[];
}

// ======================== 常量 ========================

/** DBSCAN 噪声点标签 */
const NOISE_LABEL: number = -1;

/** DBSCAN 未分类标签 */
const UNCLASSIFIED: number = -2;

// ======================== Supercluster ========================

/**
 * 创建 Supercluster 层级点聚合索引。
 *
 * 算法概述：
 *   1. 在每个缩放级别，将点投影到像素坐标
 *   2. 使用网格索引查找半径内的邻近点
 *   3. 将邻近点合并为簇，记录簇的中心和计数
 *   4. 自底向上（高缩放→低缩放）逐级构建
 *
 * @param points - 输入点 [[x, y], ...]，x=经度，y=纬度
 * @param options - 配置项
 * @returns Supercluster 实例
 *
 * @example
 * const index = supercluster([[116.4, 39.9], [116.41, 39.91], [121.5, 31.2]], { radius: 60 });
 * const clusters = index.getClusters([110, 30, 130, 45], 5);
 */
export function supercluster(
    points: number[][],
    options?: SuperclusterOptions,
): Supercluster {
    const minZoom = options?.minZoom ?? 0;
    const maxZoom = options?.maxZoom ?? 16;
    const radius = options?.radius ?? 40;
    const extent = options?.extent ?? 256;

    // 所有缩放级别的数据（zoom → 聚合点数组）
    const trees: InternalPoint[][] = new Array(maxZoom + 2);

    // 初始化最高缩放级别的原始点
    const initial: InternalPoint[] = new Array(points.length);
    for (let i = 0; i < points.length; i++) {
        // 经纬度→墨卡托 [0,1] 坐标
        const lngX = lngToX(points[i][0]);
        const latY = latToY(points[i][1]);
        initial[i] = {
            x: lngX,
            y: latY,
            zoom: Infinity,
            index: i,
            parentId: -1,
            numPoints: 1,
        };
    }
    trees[maxZoom + 1] = initial;

    // 自底向上逐级构建聚合
    for (let z = maxZoom; z >= minZoom; z--) {
        // 当前缩放级别的聚合半径（归一化坐标）
        const r = radius / (extent * Math.pow(2, z));
        trees[z] = clusterAtZoom(trees[z + 1], r, z);
    }

    return {
        getClusters(
            bbox: [number, number, number, number],
            zoom: number,
        ): ClusterFeature[] {
            // 限制缩放到有效范围
            const z = Math.max(minZoom, Math.min(Math.floor(zoom), maxZoom + 1));
            const data = trees[z];
            if (!data) return [];

            // 转换 bbox 到墨卡托 [0,1]
            const minLngX = lngToX(bbox[0]);
            const minLatY = latToY(bbox[3]);
            const maxLngX = lngToX(bbox[2]);
            const maxLatY = latToY(bbox[1]);

            const results: ClusterFeature[] = [];
            for (let i = 0; i < data.length; i++) {
                const p = data[i];
                // 检查点是否在 bbox 内
                if (p.x >= minLngX && p.x <= maxLngX && p.y >= minLatY && p.y <= maxLatY) {
                    if (p.numPoints > 1) {
                        results.push({
                            x: xToLng(p.x),
                            y: yToLat(p.y),
                            isCluster: true,
                            clusterId: i,
                            pointCount: p.numPoints,
                            index: -1,
                        });
                    } else {
                        results.push({
                            x: xToLng(p.x),
                            y: yToLat(p.y),
                            isCluster: false,
                            clusterId: -1,
                            pointCount: 1,
                            index: p.index,
                        });
                    }
                }
            }
            return results;
        },

        getClusterExpansionZoom(clusterId: number): number {
            // 向上查找直到簇被拆分
            let expansionZoom = minZoom;
            for (let z = minZoom; z <= maxZoom; z++) {
                const data = trees[z];
                if (!data || clusterId >= data.length) break;
                const p = data[clusterId];
                if (p.numPoints <= 1) {
                    expansionZoom = z;
                    break;
                }
                expansionZoom = z + 1;
            }
            return Math.min(expansionZoom, maxZoom + 1);
        },
    };
}

// ======================== DBSCAN ========================

/**
 * DBSCAN（Density-Based Spatial Clustering of Applications with Noise）密度聚类。
 *
 * 算法概述：
 *   1. 对每个未分类点，查找 ε 邻域内的邻居
 *   2. 若邻居数 ≥ minPoints，以该点为核心开始扩展聚类
 *   3. 递归将密度可达的点加入同一聚类
 *   4. 无法归类的点标记为噪声（-1）
 *
 * @param points - 输入点 [[x, y], ...]
 * @param epsilon - 邻域半径（与坐标单位一致）
 * @param minPoints - 形成聚类所需的最少邻居数
 * @returns 聚类标签数组，长度与 points 相同。-1 表示噪声，≥0 表示聚类编号
 *
 * @example
 * dbscan([[0,0], [0.1,0], [0.2,0], [10,10], [10.1,10]], 0.5, 2);
 * // → [0, 0, 0, 1, 1]（两个聚类）
 */
export function dbscan(
    points: number[][],
    epsilon: number,
    minPoints: number,
): number[] {
    const n = points.length;
    // 空点集返回空
    if (n === 0) {
        return [];
    }

    // 初始化所有点为未分类
    const labels = new Array<number>(n);
    for (let i = 0; i < n; i++) {
        labels[i] = UNCLASSIFIED;
    }

    // 预计算 epsilon 的平方，避免每次比较时开方
    const epsSq = epsilon * epsilon;

    let currentCluster = 0;

    // 遍历每个点
    for (let i = 0; i < n; i++) {
        // 跳过已分类的点
        if (labels[i] !== UNCLASSIFIED) {
            continue;
        }

        // 查找 ε 邻域内的邻居
        const neighbors = rangeQuery(points, i, epsSq);

        if (neighbors.length < minPoints) {
            // 邻居不足，标记为噪声
            labels[i] = NOISE_LABEL;
            continue;
        }

        // 以该点为核心开始新聚类
        labels[i] = currentCluster;

        // 种子集：邻居点（用栈模拟队列，避免递归）
        const seeds: number[] = neighbors.slice();
        let seedIdx = 0;

        while (seedIdx < seeds.length) {
            const q = seeds[seedIdx];
            seedIdx++;

            // 噪声点可以被吸收到聚类中
            if (labels[q] === NOISE_LABEL) {
                labels[q] = currentCluster;
            }

            // 已属于某聚类的点跳过
            if (labels[q] !== UNCLASSIFIED) {
                continue;
            }

            // 将点加入当前聚类
            labels[q] = currentCluster;

            // 查找该点的邻居
            const qNeighbors = rangeQuery(points, q, epsSq);

            // 如果该点也是核心点，扩展种子集
            if (qNeighbors.length >= minPoints) {
                for (let j = 0; j < qNeighbors.length; j++) {
                    const neighbor = qNeighbors[j];
                    if (labels[neighbor] === UNCLASSIFIED || labels[neighbor] === NOISE_LABEL) {
                        seeds.push(neighbor);
                    }
                }
            }
        }

        currentCluster++;
    }

    return labels;
}

// ======================== K-Means ========================

/**
 * K-Means 聚类算法。
 *
 * 算法概述（Lloyd 迭代）：
 *   1. 随机选择 k 个初始聚类中心（使用 K-Means++ 初始化）
 *   2. 将每个点分配到最近的聚类中心
 *   3. 重新计算每个聚类的中心（所有成员的平均坐标）
 *   4. 重复步骤 2-3 直到收敛或达到最大迭代次数
 *
 * @param points - 输入点 [[x, y], ...]
 * @param k - 聚类数量，必须 ≥ 1 且 ≤ points.length
 * @param maxIter - 最大迭代次数，默认 100
 * @returns 聚类结果 { centroids, labels }
 *
 * @example
 * const result = kMeans([[0,0], [0.1,0], [10,10], [10.1,10]], 2);
 * // result.labels → [0, 0, 1, 1]
 * // result.centroids → [[0.05, 0], [10.05, 10]]
 */
export function kMeans(
    points: number[][],
    k: number,
    maxIter = 100,
): KMeansResult {
    const n = points.length;

    // 边界检查
    if (n === 0 || k <= 0) {
        return { centroids: [], labels: [] };
    }

    // k 不能超过点数
    const actualK = Math.min(k, n);

    // --- K-Means++ 初始化 ---
    const centroids: number[][] = kMeansPlusPlusInit(points, actualK);

    // 分配标签数组
    const labels = new Array<number>(n);
    for (let i = 0; i < n; i++) {
        labels[i] = 0;
    }

    // --- Lloyd 迭代 ---
    for (let iter = 0; iter < maxIter; iter++) {
        let changed = false;

        // Step 1：将每个点分配到最近的聚类中心
        for (let i = 0; i < n; i++) {
            let bestDist = Infinity;
            let bestLabel = 0;
            const px = points[i][0];
            const py = points[i][1];

            for (let c = 0; c < actualK; c++) {
                const dx = px - centroids[c][0];
                const dy = py - centroids[c][1];
                const dist = dx * dx + dy * dy;
                if (dist < bestDist) {
                    bestDist = dist;
                    bestLabel = c;
                }
            }

            if (labels[i] !== bestLabel) {
                labels[i] = bestLabel;
                changed = true;
            }
        }

        // 如果没有点改变标签，已收敛
        if (!changed) {
            break;
        }

        // Step 2：重新计算聚类中心
        // 清零聚类中心
        const sums: number[][] = new Array(actualK);
        const counts = new Array<number>(actualK);
        for (let c = 0; c < actualK; c++) {
            sums[c] = [0, 0];
            counts[c] = 0;
        }

        // 累加各聚类成员坐标
        for (let i = 0; i < n; i++) {
            const label = labels[i];
            sums[label][0] += points[i][0];
            sums[label][1] += points[i][1];
            counts[label]++;
        }

        // 计算新中心（平均值）
        for (let c = 0; c < actualK; c++) {
            if (counts[c] > 0) {
                centroids[c][0] = sums[c][0] / counts[c];
                centroids[c][1] = sums[c][1] / counts[c];
            }
            // 空聚类保持原位
        }
    }

    return { centroids, labels };
}

// ======================== 内部辅助函数 ========================

/** Supercluster 内部点结构 */
interface InternalPoint {
    /** 墨卡托 x [0,1] */
    x: number;
    /** 墨卡托 y [0,1] */
    y: number;
    /** 所属缩放级别 */
    zoom: number;
    /** 原始点索引（非簇时有效） */
    index: number;
    /** 父簇 ID */
    parentId: number;
    /** 簇内点数 */
    numPoints: number;
}

/**
 * 经度→墨卡托 x [0,1]。
 *
 * @param lng - 经度（度）
 * @returns 墨卡托 x
 */
function lngToX(lng: number): number {
    return lng / 360.0 + 0.5;
}

/**
 * 纬度→墨卡托 y [0,1]。
 *
 * @param lat - 纬度（度）
 * @returns 墨卡托 y
 */
function latToY(lat: number): number {
    const sinLat = Math.sin(lat * Math.PI / 180.0);
    // clamp 以避免极点处的无穷大
    const clampedSin = Math.max(-0.9999, Math.min(0.9999, sinLat));
    return 0.5 - 0.25 * Math.log((1 + clampedSin) / (1 - clampedSin)) / Math.PI;
}

/**
 * 墨卡托 x → 经度（度）。
 *
 * @param x - 墨卡托 x [0,1]
 * @returns 经度
 */
function xToLng(x: number): number {
    return (x - 0.5) * 360.0;
}

/**
 * 墨卡托 y → 纬度（度）。
 *
 * @param y - 墨卡托 y [0,1]
 * @returns 纬度
 */
function yToLat(y: number): number {
    const y2 = (0.5 - y) * 2.0 * Math.PI;
    return Math.atan(Math.exp(y2)) * 360.0 / Math.PI - 90.0;
}

/**
 * 在指定缩放级别进行点聚合。
 * 使用简单网格索引查找邻近点并合并。
 *
 * @param points - 上一级的点/簇数组
 * @param r - 聚合半径（归一化坐标）
 * @param zoom - 当前缩放级别
 * @returns 聚合后的点/簇数组
 */
function clusterAtZoom(
    points: InternalPoint[],
    r: number,
    zoom: number,
): InternalPoint[] {
    const clusters: InternalPoint[] = [];
    const visited = new Uint8Array(points.length);

    for (let i = 0; i < points.length; i++) {
        // 跳过已处理的点
        if (visited[i] === 1) continue;

        const p = points[i];
        let wx = p.x * p.numPoints;
        let wy = p.y * p.numPoints;
        let numPoints = p.numPoints;

        visited[i] = 1;

        // 查找半径内的邻居并合并
        for (let j = i + 1; j < points.length; j++) {
            if (visited[j] === 1) continue;

            const q = points[j];
            const dx = p.x - q.x;
            const dy = p.y - q.y;

            if (dx * dx + dy * dy <= r * r) {
                // 加权合并
                wx += q.x * q.numPoints;
                wy += q.y * q.numPoints;
                numPoints += q.numPoints;
                visited[j] = 1;
                q.parentId = clusters.length;
            }
        }

        // 创建合并后的簇（或保留原始点）
        clusters.push({
            x: wx / numPoints,
            y: wy / numPoints,
            zoom,
            index: numPoints === 1 ? p.index : -1,
            parentId: -1,
            numPoints,
        });
    }

    return clusters;
}

/**
 * DBSCAN 范围查询：找到 ε 邻域内的所有邻居（不包括自身）。
 *
 * @param points - 点集
 * @param idx - 查询点索引
 * @param epsSq - ε² 的平方
 * @returns 邻居索引数组
 */
function rangeQuery(
    points: number[][],
    idx: number,
    epsSq: number,
): number[] {
    const neighbors: number[] = [];
    const px = points[idx][0];
    const py = points[idx][1];

    // 暴力搜索 O(n)，对于大数据集应结合空间索引
    for (let i = 0; i < points.length; i++) {
        if (i === idx) continue;
        const dx = points[i][0] - px;
        const dy = points[i][1] - py;
        if (dx * dx + dy * dy <= epsSq) {
            neighbors.push(i);
        }
    }

    return neighbors;
}

/**
 * K-Means++ 初始化：选择距已选中心尽量远的初始中心，
 * 避免随机初始化导致的局部最优。
 *
 * @param points - 输入点集
 * @param k - 聚类数
 * @returns 初始聚类中心
 */
function kMeansPlusPlusInit(points: number[][], k: number): number[][] {
    const n = points.length;
    const centroids: number[][] = [];

    // 选择第一个中心：使用确定性方法——取第一个点
    centroids.push([points[0][0], points[0][1]]);

    // 依次选择后续中心
    const dists = new Float64Array(n);

    for (let c = 1; c < k; c++) {
        // 计算每个点到最近已选中心的距离平方
        let totalDist = 0;
        for (let i = 0; i < n; i++) {
            let minDist = Infinity;
            for (let j = 0; j < centroids.length; j++) {
                const dx = points[i][0] - centroids[j][0];
                const dy = points[i][1] - centroids[j][1];
                const dist = dx * dx + dy * dy;
                if (dist < minDist) {
                    minDist = dist;
                }
            }
            dists[i] = minDist;
            totalDist += minDist;
        }

        // 使用确定性选择：选距离最远的点（而非概率采样，保证可重现）
        let bestIdx = 0;
        let bestDist = -1;
        for (let i = 0; i < n; i++) {
            if (dists[i] > bestDist) {
                bestDist = dists[i];
                bestIdx = i;
            }
        }

        centroids.push([points[bestIdx][0], points[bestIdx][1]]);
    }

    return centroids;
}

declare const __DEV__: boolean;
