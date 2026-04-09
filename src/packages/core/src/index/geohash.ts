// ============================================================
// index/geohash.ts — Geohash 编解码（自研实现）
// 经纬度 ↔ Base32 字符串的可层次空间索引键。
// 用途：空间哈希索引键、proximity 查询、瓦片邻接、键值数据库的二级索引。
// ============================================================

// Geohash Base32 字母表（去掉 a/i/l/o，避免视觉混淆）
const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

// Base32 字符 → 5-bit 数值的反查表（一次构建，常驻）
const BASE32_INDEX: Int8Array = (() => {
    const arr = new Int8Array(128).fill(-1);
    for (let i = 0; i < BASE32.length; i++) {
        arr[BASE32.charCodeAt(i)] = i;
    }
    return arr;
})();

/**
 * 把经纬度编码为 Geohash 字符串。
 *
 * Geohash 通过"二分经纬度区间 + 经纬交错位 + 5-bit Base32"的方式
 * 把 2D 坐标映射为 1D 字符串，前缀越长精度越高，
 * 共享前缀的两个字符串在空间上接近（但反之不一定，存在边界跳跃）。
 *
 * 精度参考（precision = 字符长度）：
 *   1 → ~5000 km
 *   3 → ~156 km
 *   5 → ~4.9 km
 *   7 → ~153 m
 *   9 → ~4.8 m
 *   12 → ~3.7 cm
 *
 * @param lng 经度（度），范围 [-180, 180]
 * @param lat 纬度（度），范围 [-90, 90]
 * @param precision 字符长度，范围 [1, 12]，默认 9
 * @returns Geohash 字符串
 *
 * @example
 * geohashEncode(-0.1257, 51.5085, 7); // → "gcpvj0e"（伦敦）
 */
export function geohashEncode(lng: number, lat: number, precision: number = 9): string {
    if (lng !== lng || lat !== lat) {
        return '';
    }
    if (precision < 1) precision = 1;
    if (precision > 12) precision = 12;

    // 钳位到合法范围
    if (lng < -180) lng = -180;
    else if (lng > 180) lng = 180;
    if (lat < -90) lat = -90;
    else if (lat > 90) lat = 90;

    let lonMin = -180;
    let lonMax = 180;
    let latMin = -90;
    let latMax = 90;

    let chars = '';
    let bit = 0;
    let ch = 0;
    // even=true 时下一位编码经度，否则编码纬度（经纬交错）
    let even = true;

    while (chars.length < precision) {
        if (even) {
            const mid = (lonMin + lonMax) * 0.5;
            if (lng >= mid) {
                ch = (ch << 1) | 1;
                lonMin = mid;
            } else {
                ch = ch << 1;
                lonMax = mid;
            }
        } else {
            const mid = (latMin + latMax) * 0.5;
            if (lat >= mid) {
                ch = (ch << 1) | 1;
                latMin = mid;
            } else {
                ch = ch << 1;
                latMax = mid;
            }
        }
        even = !even;
        bit++;
        if (bit === 5) {
            chars += BASE32[ch];
            bit = 0;
            ch = 0;
        }
    }

    return chars;
}

/**
 * Geohash 解码结果：包含中心点和定位单元的边界。
 */
export interface GeohashBounds {
    /** 单元格中心经度（度） */
    readonly lng: number;
    /** 单元格中心纬度（度） */
    readonly lat: number;
    /** 单元格经度跨度的一半（误差上界） */
    readonly lngError: number;
    /** 单元格纬度跨度的一半（误差上界） */
    readonly latError: number;
    /** 单元格 [west, south, east, north] */
    readonly bounds: [number, number, number, number];
}

/**
 * 解码 Geohash 字符串为定位单元格。
 *
 * @param hash Geohash 字符串（大小写不敏感，但必须是合法 Base32 字符）
 * @returns 单元格中心 + 误差范围 + 包围盒，若包含非法字符返回 null
 *
 * @example
 * geohashDecode("gcpvj0e");
 * // → { lng: -0.1257..., lat: 51.5085..., bounds: [...], ... }
 */
export function geohashDecode(hash: string): GeohashBounds | null {
    if (hash.length === 0) {
        return null;
    }

    let lonMin = -180;
    let lonMax = 180;
    let latMin = -90;
    let latMax = 90;

    let even = true;

    for (let i = 0; i < hash.length; i++) {
        const code = hash.charCodeAt(i);
        const idx = code < 128 ? BASE32_INDEX[code] : -1;
        if (idx < 0) {
            // 大小写不敏感：尝试小写
            const lower = (code >= 65 && code <= 90) ? BASE32_INDEX[code + 32] : -1;
            if (lower < 0) {
                return null;
            }
            // eslint-disable-next-line no-param-reassign
            hash = hash.slice(0, i) + String.fromCharCode(code + 32) + hash.slice(i + 1);
            i--;
            continue;
        }

        // 解 5 位
        for (let mask = 16; mask > 0; mask >>= 1) {
            const bit = (idx & mask) !== 0;
            if (even) {
                const mid = (lonMin + lonMax) * 0.5;
                if (bit) lonMin = mid;
                else lonMax = mid;
            } else {
                const mid = (latMin + latMax) * 0.5;
                if (bit) latMin = mid;
                else latMax = mid;
            }
            even = !even;
        }
    }

    const lng = (lonMin + lonMax) * 0.5;
    const lat = (latMin + latMax) * 0.5;
    const lngError = (lonMax - lonMin) * 0.5;
    const latError = (latMax - latMin) * 0.5;

    return {
        lng,
        lat,
        lngError,
        latError,
        bounds: [lonMin, latMin, lonMax, latMax],
    };
}

/**
 * 计算 Geohash 的 8 个邻居（N, NE, E, SE, S, SW, W, NW）。
 *
 * 用途：邻接查询、proximity 搜索时扩展候选格子。
 *
 * @param hash Geohash 字符串
 * @returns 8 个邻居的 hash 数组，顺序 [N, NE, E, SE, S, SW, W, NW]；越界时为空字符串
 */
export function geohashNeighbors(hash: string): string[] {
    const decoded = geohashDecode(hash);
    if (decoded === null) {
        return [];
    }
    const { lng, lat, lngError, latError } = decoded;
    const dx = lngError * 2;
    const dy = latError * 2;
    const len = hash.length;

    const make = (lo: number, la: number): string => {
        if (la > 90 || la < -90) return '';
        // 经度环绕
        let l = lo;
        if (l > 180) l -= 360;
        else if (l < -180) l += 360;
        return geohashEncode(l, la, len);
    };

    return [
        make(lng, lat + dy),       // N
        make(lng + dx, lat + dy),  // NE
        make(lng + dx, lat),       // E
        make(lng + dx, lat - dy),  // SE
        make(lng, lat - dy),       // S
        make(lng - dx, lat - dy),  // SW
        make(lng - dx, lat),       // W
        make(lng - dx, lat + dy),  // NW
    ];
}
