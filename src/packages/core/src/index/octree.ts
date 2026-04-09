// ============================================================
// index/octree.ts — 八叉树空间索引（3D）
// ============================================================
// 3D 版四叉树。每个节点细分为 8 个子立方体（八分体）。
// 用途：3D 点云、粒子系统、体渲染加速、3D Tiles 层次索引。
// 零外部依赖，全部 Float64 数学。
// ============================================================

const DEFAULT_MAX_ITEMS = 8;
const MAX_DEPTH = 20;

/**
 * 八叉树数据项：世界坐标 + 关联载荷。
 */
export interface OctreeItem<T = unknown> {
    readonly x: number;
    readonly y: number;
    readonly z: number;
    readonly data: T;
}

/**
 * 八叉树公共接口。
 */
export interface Octree<T = unknown> {
    /** 插入一个点。 */
    insert(x: number, y: number, z: number, data: T): void;
    /** AABB 范围查询（返回所有命中项）。 */
    search(
        minX: number, minY: number, minZ: number,
        maxX: number, maxY: number, maxZ: number,
    ): OctreeItem<T>[];
    /** 球形范围查询。 */
    searchRadius(cx: number, cy: number, cz: number, radius: number): OctreeItem<T>[];
    /** 按引用相等删除一个项。 */
    remove(x: number, y: number, z: number, data: T): boolean;
    /** 清空所有项。 */
    clear(): void;
    /** 当前树中的总项数。 */
    size(): number;
    /** 遍历所有项。 */
    each(fn: (item: OctreeItem<T>) => void): void;
}

/** 内部节点结构。 */
interface OctreeNode<T> {
    readonly minX: number;
    readonly minY: number;
    readonly minZ: number;
    readonly maxX: number;
    readonly maxY: number;
    readonly maxZ: number;
    readonly depth: number;
    items: OctreeItem<T>[] | null;
    /** 8 个子节点 [---, +--, -+-, ++-, --+, +-+, -++, +++]，未分裂时为 null */
    children: OctreeNode<T>[] | null;
}

/**
 * 创建一个八叉树。
 *
 * @param minX 根包围盒 x 下界
 * @param minY 根包围盒 y 下界
 * @param minZ 根包围盒 z 下界
 * @param maxX 根包围盒 x 上界
 * @param maxY 根包围盒 y 上界
 * @param maxZ 根包围盒 z 上界
 * @param maxItems 每个叶子节点的最大容量，超过则分裂（默认 8）
 */
export function createOctree<T = unknown>(
    minX: number, minY: number, minZ: number,
    maxX: number, maxY: number, maxZ: number,
    maxItems: number = DEFAULT_MAX_ITEMS,
): Octree<T> {
    const root: OctreeNode<T> = {
        minX, minY, minZ, maxX, maxY, maxZ,
        depth: 0,
        items: [],
        children: null,
    };
    let totalSize = 0;

    function contains(node: OctreeNode<T>, x: number, y: number, z: number): boolean {
        return (
            x >= node.minX && x <= node.maxX
            && y >= node.minY && y <= node.maxY
            && z >= node.minZ && z <= node.maxZ
        );
    }

    function overlaps(
        node: OctreeNode<T>,
        aMinX: number, aMinY: number, aMinZ: number,
        aMaxX: number, aMaxY: number, aMaxZ: number,
    ): boolean {
        return !(
            aMaxX < node.minX || aMinX > node.maxX
            || aMaxY < node.minY || aMinY > node.maxY
            || aMaxZ < node.minZ || aMinZ > node.maxZ
        );
    }

    function subdivide(node: OctreeNode<T>): void {
        const mx = (node.minX + node.maxX) * 0.5;
        const my = (node.minY + node.maxY) * 0.5;
        const mz = (node.minZ + node.maxZ) * 0.5;
        const d = node.depth + 1;
        node.children = [
            // 8 个子节点，按 (x: -/+, y: -/+, z: -/+) 的组合
            { minX: node.minX, minY: node.minY, minZ: node.minZ, maxX: mx, maxY: my, maxZ: mz, depth: d, items: [], children: null },
            { minX: mx, minY: node.minY, minZ: node.minZ, maxX: node.maxX, maxY: my, maxZ: mz, depth: d, items: [], children: null },
            { minX: node.minX, minY: my, minZ: node.minZ, maxX: mx, maxY: node.maxY, maxZ: mz, depth: d, items: [], children: null },
            { minX: mx, minY: my, minZ: node.minZ, maxX: node.maxX, maxY: node.maxY, maxZ: mz, depth: d, items: [], children: null },
            { minX: node.minX, minY: node.minY, minZ: mz, maxX: mx, maxY: my, maxZ: node.maxZ, depth: d, items: [], children: null },
            { minX: mx, minY: node.minY, minZ: mz, maxX: node.maxX, maxY: my, maxZ: node.maxZ, depth: d, items: [], children: null },
            { minX: node.minX, minY: my, minZ: mz, maxX: mx, maxY: node.maxY, maxZ: node.maxZ, depth: d, items: [], children: null },
            { minX: mx, minY: my, minZ: mz, maxX: node.maxX, maxY: node.maxY, maxZ: node.maxZ, depth: d, items: [], children: null },
        ];
        // 把原叶子的项分发到子节点
        const oldItems = node.items!;
        node.items = null;
        for (let i = 0; i < oldItems.length; i++) {
            const it = oldItems[i];
            insertInto(pickChild(node, it.x, it.y, it.z), it);
        }
    }

    function pickChild(node: OctreeNode<T>, x: number, y: number, z: number): OctreeNode<T> {
        const mx = (node.minX + node.maxX) * 0.5;
        const my = (node.minY + node.maxY) * 0.5;
        const mz = (node.minZ + node.maxZ) * 0.5;
        const ix = x >= mx ? 1 : 0;
        const iy = y >= my ? 1 : 0;
        const iz = z >= mz ? 1 : 0;
        return node.children![iz * 4 + iy * 2 + ix];
    }

    function insertInto(node: OctreeNode<T>, item: OctreeItem<T>): void {
        if (node.children !== null) {
            insertInto(pickChild(node, item.x, item.y, item.z), item);
            return;
        }
        node.items!.push(item);
        if (node.items!.length > maxItems && node.depth < MAX_DEPTH) {
            subdivide(node);
        }
    }

    function searchNode(
        node: OctreeNode<T>,
        minX: number, minY: number, minZ: number,
        maxX: number, maxY: number, maxZ: number,
        out: OctreeItem<T>[],
    ): void {
        if (!overlaps(node, minX, minY, minZ, maxX, maxY, maxZ)) return;
        if (node.children !== null) {
            for (let i = 0; i < 8; i++) {
                searchNode(node.children[i], minX, minY, minZ, maxX, maxY, maxZ, out);
            }
            return;
        }
        const items = node.items!;
        for (let i = 0; i < items.length; i++) {
            const it = items[i];
            if (
                it.x >= minX && it.x <= maxX
                && it.y >= minY && it.y <= maxY
                && it.z >= minZ && it.z <= maxZ
            ) {
                out.push(it);
            }
        }
    }

    function removeFromNode(
        node: OctreeNode<T>,
        x: number, y: number, z: number, data: T,
    ): boolean {
        if (!contains(node, x, y, z)) return false;
        if (node.children !== null) {
            return removeFromNode(pickChild(node, x, y, z), x, y, z, data);
        }
        const items = node.items!;
        for (let i = 0; i < items.length; i++) {
            const it = items[i];
            if (it.x === x && it.y === y && it.z === z && it.data === data) {
                items.splice(i, 1);
                return true;
            }
        }
        return false;
    }

    function eachNode(node: OctreeNode<T>, fn: (item: OctreeItem<T>) => void): void {
        if (node.children !== null) {
            for (let i = 0; i < 8; i++) eachNode(node.children[i], fn);
            return;
        }
        const items = node.items!;
        for (let i = 0; i < items.length; i++) fn(items[i]);
    }

    return {
        insert(x, y, z, data) {
            if (!contains(root, x, y, z)) return;
            insertInto(root, { x, y, z, data });
            totalSize++;
        },
        search(minX, minY, minZ, maxX, maxY, maxZ) {
            const out: OctreeItem<T>[] = [];
            searchNode(root, minX, minY, minZ, maxX, maxY, maxZ, out);
            return out;
        },
        searchRadius(cx, cy, cz, radius) {
            // 先做 AABB 剪枝，再精确球体过滤
            const box: OctreeItem<T>[] = [];
            searchNode(root, cx - radius, cy - radius, cz - radius, cx + radius, cy + radius, cz + radius, box);
            const r2 = radius * radius;
            const out: OctreeItem<T>[] = [];
            for (let i = 0; i < box.length; i++) {
                const it = box[i];
                const dx = it.x - cx, dy = it.y - cy, dz = it.z - cz;
                if (dx * dx + dy * dy + dz * dz <= r2) out.push(it);
            }
            return out;
        },
        remove(x, y, z, data) {
            const ok = removeFromNode(root, x, y, z, data);
            if (ok) totalSize--;
            return ok;
        },
        clear() {
            root.items = [];
            root.children = null;
            totalSize = 0;
        },
        size() {
            return totalSize;
        },
        each(fn) {
            eachNode(root, fn);
        },
    };
}
