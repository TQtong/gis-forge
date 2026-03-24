// ============================================================
// infra/id.ts — ID 生成器（自研实现）
// 提供三种 ID 生成策略：
// 1. uniqueId —— 带前缀的单调递增 ID（确定性，可预测）
// 2. sequentialId —— 简单递增整数
// 3. nanoid —— URL 安全的随机 ID（不可预测，适合公共标识）
// 零外部依赖。
// ============================================================

// ======================== 内部状态 ========================

/**
 * uniqueId 的全局计数器。
 * 使用闭包保持状态，每次调用递增。
 * 从 1 开始（0 在某些上下文中被视为 falsy）。
 */
let uniqueCounter = 0;

/**
 * sequentialId 的全局计数器。
 * 与 uniqueCounter 独立，避免不同 ID 空间互相干扰。
 */
let sequentialCounter = 0;

// ======================== 常量 ========================

/**
 * nanoid 使用的 URL 安全字符集（64 个字符）。
 * 包含 A-Z、a-z、0-9、下划线和连字符。
 * 顺序经过重排以减少视觉混淆（如 0/O、1/l/I）——
 * 但为了与标准 nanoid 兼容，这里保持标准排列。
 */
const URL_SAFE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';

/** nanoid 默认长度（21 个字符，~126 位熵，与 UUID v4 的 122 位相当） */
const DEFAULT_NANOID_SIZE = 21;

// ======================== 公共 API ========================

/**
 * 生成带前缀的单调递增唯一 ID。
 * 格式为 `{prefix}_{counter}`，其中 counter 从 1 开始全局递增。
 * 同一运行时内保证唯一性，但跨进程/Worker 不保证。
 *
 * 用途：引擎内部对象标识（图层、数据源、渲染通道等），
 * 需要确定性和可预测性的场景。
 *
 * @param prefix - ID 前缀（默认 'id'），建议使用对象类型名如 'layer'、'source'
 * @returns 格式为 `prefix_N` 的字符串
 *
 * @example
 * uniqueId('layer');  // → "layer_1"
 * uniqueId('layer');  // → "layer_2"
 * uniqueId('source'); // → "source_3"（计数器全局共享）
 */
export function uniqueId(prefix: string = 'id'): string {
    // 递增计数器
    uniqueCounter++;

    // 拼接前缀和计数器
    return prefix + '_' + uniqueCounter;
}

/**
 * 生成简单的递增整数 ID。
 * 每次调用返回上一次返回值 + 1，从 1 开始。
 * 与 uniqueId 使用独立的计数器。
 *
 * 用途：需要数字 ID 的场景（如 Feature ID、GPU picking 编码）。
 *
 * @returns 递增整数（1, 2, 3, ...）
 *
 * @example
 * sequentialId(); // → 1
 * sequentialId(); // → 2
 * sequentialId(); // → 3
 */
export function sequentialId(): number {
    sequentialCounter++;
    return sequentialCounter;
}

/**
 * 生成 URL 安全的随机 ID（自研 nanoid 实现）。
 * 使用 `crypto.getRandomValues()` 生成密码学安全的随机字节，
 * 然后映射到 64 字符的 URL 安全字母表。
 *
 * 碰撞概率：
 * - 21 字符（默认）：~126 位熵，需要生成 ~10^18 个 ID 才有 1% 碰撞概率
 * - 10 字符：~60 位熵，~10^9 个 ID 有 1% 碰撞概率
 *
 * 如果 `crypto.getRandomValues` 不可用（如非安全上下文），
 * 回退到 Math.random（安全性降低但功能不受影响）。
 *
 * @param size - ID 长度（默认 21）。越长碰撞概率越低，但占用更多空间。
 * @returns URL 安全的随机字符串
 *
 * @example
 * nanoid();   // → "V1StGXR8_Z5jdHi6B-myT"（21 字符）
 * nanoid(10); // → "IRFa-VaY2b"（10 字符）
 */
export function nanoid(size: number = DEFAULT_NANOID_SIZE): string {
    // 确保 size 为有效正整数
    if (size <= 0 || !Number.isFinite(size)) {
        size = DEFAULT_NANOID_SIZE;
    }
    size = Math.floor(size);

    // 分配随机字节缓冲区
    const bytes = new Uint8Array(size);

    // 尝试使用密码学安全的随机数生成器
    if (typeof globalThis !== 'undefined' && globalThis.crypto && typeof globalThis.crypto.getRandomValues === 'function') {
        globalThis.crypto.getRandomValues(bytes);
    } else {
        // 回退到 Math.random（非密码学安全，但功能可用）
        for (let i = 0; i < size; i++) {
            bytes[i] = (Math.random() * 256) | 0;
        }
    }

    // 将随机字节映射到字母表
    let id = '';
    for (let i = 0; i < size; i++) {
        // 使用位掩码 0x3F (63) 将字节映射到 0-63 范围
        // 64 字符字母表正好是 2^6，所以每个字节低 6 位映射一个字符
        id += URL_SAFE_ALPHABET[bytes[i] & 0x3F];
    }

    return id;
}
