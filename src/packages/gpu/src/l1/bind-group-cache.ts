// ============================================================
// l1/bind-group-cache.ts — BindGroup 与 Sampler 缓存
// 层级：L1（GPU 层）
// 职责：缓存 GPUBindGroup 和 GPUSampler 实例，避免每帧重复创建。
//       BindGroup 按 layout + entries 组合做 key 缓存；
//       Sampler 按 descriptor 属性组合做 key 缓存。
//
// 被引用于：L2/ShaderAssembler, L2/PipelineCache, L2/RenderGraph,
//           L2/ComputePassManager, L4/StyleEngine
//
// 设计要点：
// - BindGroup key = layout label + entries 的 resource ID 拼接
// - 支持 invalidateByResource——当某个 Buffer/Texture 被销毁时，
//   移除所有引用该资源的 BindGroup
// - 统计 hits/misses 用于性能分析
// - Sampler key = filter/address mode 等属性拼接
// ============================================================

// ===================== BindGroupEntry 描述 =====================

/**
 * BindGroup 中单个 binding 的资源描述。
 * 用于构造缓存 key——通过 resourceId 标识资源。
 * 不直接持有 GPU 资源引用——那些在 rawEntries 中传递。
 */
export interface BindGroupEntryDescriptor {
  /** binding 索引，对应 WGSL 中的 @binding(N)。范围 [0, 15]。 */
  readonly binding: number;

  /**
   * 资源唯一标识符。
   * 用于缓存 key 计算和 invalidateByResource 查找。
   * 格式约定：'buffer-<id>' / 'texture-<id>' / 'sampler-<id>'。
   */
  readonly resourceId: string;
}

// ===================== BindGroupCacheStats =====================

/**
 * BindGroup 缓存统计信息。
 * 用于性能监控面板（RenderStats）显示。
 */
export interface BindGroupCacheStats {
  /** 缓存命中次数（getOrCreate 时找到已有 BindGroup） */
  readonly hits: number;

  /** 缓存未命中次数（getOrCreate 时需要新建 BindGroup） */
  readonly misses: number;

  /** 当前缓存中的 BindGroup 数量 */
  readonly size: number;

  /**
   * 命中率 = hits / (hits + misses)。
   * 范围 [0, 1]。当 hits + misses === 0 时返回 0。
   */
  readonly hitRate: number;

  /** 通过 invalidateByResource 移除的 BindGroup 累计数量 */
  readonly invalidations: number;
}

// ===================== SamplerCacheStats =====================

/**
 * Sampler 缓存统计信息。
 */
export interface SamplerCacheStats {
  /** 缓存命中次数 */
  readonly hits: number;

  /** 缓存未命中次数 */
  readonly misses: number;

  /** 当前缓存中的 Sampler 数量 */
  readonly size: number;
}

// ===================== BindGroupCache 接口 =====================

/**
 * GPUBindGroup 缓存。
 * 避免每帧为相同的 layout + entries 组合重复创建 BindGroup。
 *
 * @example
 * const cache = createBindGroupCache(device);
 *
 * const bg = cache.getOrCreate(
 *   layout,
 *   'my-pipeline-layout',
 *   [
 *     { binding: 0, resourceId: 'buffer-uniform-camera' },
 *     { binding: 1, resourceId: 'texture-terrain-0' },
 *   ],
 *   [
 *     { binding: 0, resource: { buffer: uniformBuffer } },
 *     { binding: 1, resource: textureView },
 *   ],
 * );
 */
export interface BindGroupCache {
  /**
   * 获取或创建 BindGroup。
   * 如果缓存中已有匹配的 BindGroup 则直接返回（cache hit）。
   * 否则创建新的 BindGroup 并存入缓存（cache miss）。
   *
   * @param layout - GPUBindGroupLayout
   * @param layoutLabel - layout 的标签，用于缓存 key 的前缀
   * @param descriptors - binding 描述符列表，用于缓存 key 计算
   * @param rawEntries - 实际的 GPUBindGroupEntry 数组，传给 device.createBindGroup
   * @param label - 可选的 BindGroup 调试标签
   * @returns 缓存的或新创建的 GPUBindGroup
   */
  getOrCreate(
    layout: GPUBindGroupLayout,
    layoutLabel: string,
    descriptors: readonly BindGroupEntryDescriptor[],
    rawEntries: readonly GPUBindGroupEntry[],
    label?: string
  ): GPUBindGroup;

  /**
   * 移除所有引用指定资源 ID 的 BindGroup。
   * 当 Buffer/Texture 被销毁或重建时调用，防止引用已销毁的 GPU 资源。
   *
   * @param resourceId - 被销毁/重建的资源 ID
   * @returns 被移除的 BindGroup 数量
   */
  invalidateByResource(resourceId: string): number;

  /**
   * 根据完整 key 移除指定的 BindGroup。
   * @param key - 缓存 key
   * @returns 是否成功移除
   */
  invalidateByKey(key: string): boolean;

  /**
   * 清空所有缓存的 BindGroup。
   * 在设备重建后调用——旧 BindGroup 已失效。
   */
  clear(): void;

  /** 获取当前缓存统计信息。 */
  readonly stats: BindGroupCacheStats;

  /** 当前缓存中的 BindGroup 数量。 */
  readonly size: number;
}

// ===================== SamplerCache 接口 =====================

/**
 * GPUSampler 缓存。
 * WebGPU 允许的 Sampler 组合有限，缓存所有已创建的组合避免重复。
 *
 * @example
 * const { sampler: samplerCache } = createBindGroupCache(device);
 *
 * const linearSampler = samplerCache.getOrCreate({
 *   magFilter: 'linear',
 *   minFilter: 'linear',
 *   mipmapFilter: 'linear',
 * });
 */
export interface SamplerCache {
  /**
   * 获取或创建 Sampler。
   * 按 descriptor 属性拼接成 key 做缓存查找。
   *
   * @param descriptor - Sampler 描述符（GPUSamplerDescriptor 的部分字段）
   * @returns 缓存的或新创建的 GPUSampler
   */
  getOrCreate(descriptor: GPUSamplerDescriptor): GPUSampler;

  /**
   * 清空所有缓存的 Sampler。
   */
  clear(): void;

  /** 获取当前缓存统计信息。 */
  readonly stats: SamplerCacheStats;

  /** 当前缓存中的 Sampler 数量。 */
  readonly size: number;
}

// ===================== 辅助函数 =====================

/**
 * 根据 layout label 和 entry descriptors 计算缓存 key。
 * key 格式: "<layoutLabel>|<binding0>:<resourceId0>,<binding1>:<resourceId1>,..."
 * entries 按 binding 升序排列保证相同组合产生相同 key。
 *
 * @param layoutLabel - BindGroupLayout 的标签
 * @param descriptors - binding 描述符数组
 * @returns 缓存 key 字符串
 *
 * @example
 * computeBindGroupKey('camera-layout', [
 *   { binding: 0, resourceId: 'buf-camera' },
 *   { binding: 1, resourceId: 'tex-atlas' },
 * ]);
 * // → "camera-layout|0:buf-camera,1:tex-atlas"
 */
function computeBindGroupKey(
  layoutLabel: string,
  descriptors: readonly BindGroupEntryDescriptor[]
): string {
  // 按 binding 升序排列——保证不同顺序的相同组合产生相同 key
  const sorted = [...descriptors].sort((a, b) => a.binding - b.binding);

  // 拼接格式：binding:resourceId
  const entriesKey = sorted.map((d) => `${d.binding}:${d.resourceId}`).join(',');

  // 用管道符分隔 layout 和 entries 部分
  return `${layoutLabel}|${entriesKey}`;
}

/**
 * 根据 GPUSamplerDescriptor 计算缓存 key。
 * 将所有相关属性拼接为字符串。使用默认值填充未指定的字段，
 * 保证省略字段和显式指定默认值产生相同 key。
 *
 * @param desc - Sampler 描述符
 * @returns 缓存 key 字符串
 *
 * @example
 * computeSamplerKey({ magFilter: 'linear', minFilter: 'linear' });
 * // → "mag:linear|min:linear|mip:nearest|u:clamp-to-edge|v:clamp-to-edge|w:clamp-to-edge|lod:0-32|compare:none|maxAniso:1"
 */
function computeSamplerKey(desc: GPUSamplerDescriptor): string {
  // 使用 WebGPU 规范默认值填充——确保显式传 'nearest' 和省略都产生 'nearest'
  const magFilter = desc.magFilter ?? 'nearest';
  const minFilter = desc.minFilter ?? 'nearest';
  const mipmapFilter = desc.mipmapFilter ?? 'nearest';

  // 地址模式默认为 'clamp-to-edge'
  const addressModeU = desc.addressModeU ?? 'clamp-to-edge';
  const addressModeV = desc.addressModeV ?? 'clamp-to-edge';
  const addressModeW = desc.addressModeW ?? 'clamp-to-edge';

  // LOD 范围
  const lodMinClamp = desc.lodMinClamp ?? 0;
  const lodMaxClamp = desc.lodMaxClamp ?? 32;

  // 比较函数（depth sampler 用）
  const compare = desc.compare ?? 'none';

  // 各向异性过滤
  const maxAnisotropy = desc.maxAnisotropy ?? 1;

  // 拼接所有字段为一个唯一 key
  return `mag:${magFilter}|min:${minFilter}|mip:${mipmapFilter}|u:${addressModeU}|v:${addressModeV}|w:${addressModeW}|lod:${lodMinClamp}-${lodMaxClamp}|compare:${compare}|maxAniso:${maxAnisotropy}`;
}

// ===================== 工厂函数 =====================

/**
 * 创建 BindGroup 缓存和 Sampler 缓存。
 * 返回一个组合对象，包含 BindGroupCache 和 SamplerCache。
 *
 * @param gpuDevice - 已初始化的 GPUDevice
 * @returns BindGroupCache & { sampler: SamplerCache } 组合对象
 *
 * @example
 * const dm = createDeviceManager();
 * await dm.initialize();
 * const cache = createBindGroupCache(dm.device);
 *
 * // BindGroup 缓存
 * const bg = cache.getOrCreate(layout, 'my-layout', descriptors, rawEntries);
 *
 * // Sampler 缓存
 * const sampler = cache.sampler.getOrCreate({ magFilter: 'linear', minFilter: 'linear' });
 *
 * // 资源销毁时失效
 * cache.invalidateByResource('texture-terrain-0');
 *
 * // 查看统计
 * console.log(cache.stats); // { hits: 42, misses: 3, size: 3, hitRate: 0.933, invalidations: 0 }
 */
export function createBindGroupCache(
  gpuDevice: GPUDevice
): BindGroupCache & { sampler: SamplerCache } {
  // 参数校验
  if (!gpuDevice) {
    throw new Error('[BindGroupCache] createBindGroupCache: device must be a valid GPUDevice');
  }

  // ==================== BindGroup 缓存内部状态 ====================

  /** key → GPUBindGroup 映射 */
  const bindGroupMap = new Map<string, GPUBindGroup>();

  /**
   * resourceId → Set<key> 映射。
   * 用于 invalidateByResource 时快速查找引用该资源的所有 key。
   * 每次 getOrCreate 时维护此反向索引。
   */
  const resourceToKeysMap = new Map<string, Set<string>>();

  /** 缓存命中计数 */
  let bgHits = 0;

  /** 缓存未命中计数 */
  let bgMisses = 0;

  /** 累计失效移除数量 */
  let bgInvalidations = 0;

  // ==================== Sampler 缓存内部状态 ====================

  /** key → GPUSampler 映射 */
  const samplerMap = new Map<string, GPUSampler>();

  /** Sampler 缓存命中计数 */
  let samplerHits = 0;

  /** Sampler 缓存未命中计数 */
  let samplerMisses = 0;

  // ==================== BindGroup 方法 ====================

  /**
   * 获取或创建 BindGroup。
   *
   * @param layout - GPUBindGroupLayout
   * @param layoutLabel - layout 的标签
   * @param descriptors - binding 描述符
   * @param rawEntries - 实际的 GPUBindGroupEntry 数组
   * @param label - 可选调试标签
   * @returns GPUBindGroup
   *
   * @example
   * const bg = cache.getOrCreate(
   *   layout, 'material',
   *   [{ binding: 0, resourceId: 'buf-uniform' }],
   *   [{ binding: 0, resource: { buffer: uniformBuf } }],
   *   'material-bind-group'
   * );
   */
  function getOrCreate(
    layout: GPUBindGroupLayout,
    layoutLabel: string,
    descriptors: readonly BindGroupEntryDescriptor[],
    rawEntries: readonly GPUBindGroupEntry[],
    label?: string
  ): GPUBindGroup {
    // 参数校验——layout 必须有效
    if (!layout) {
      throw new Error('[BindGroupCache] getOrCreate: layout must be a valid GPUBindGroupLayout');
    }

    // 参数校验——descriptors 不能为空
    if (!descriptors || descriptors.length === 0) {
      throw new Error('[BindGroupCache] getOrCreate: descriptors must be a non-empty array');
    }

    // 参数校验——rawEntries 数量必须与 descriptors 匹配
    if (!rawEntries || rawEntries.length !== descriptors.length) {
      throw new Error(
        `[BindGroupCache] getOrCreate: rawEntries.length (${rawEntries?.length ?? 0}) ` +
        `must match descriptors.length (${descriptors.length})`
      );
    }

    // 计算缓存 key
    const key = computeBindGroupKey(layoutLabel, descriptors);

    // 尝试缓存命中
    const existing = bindGroupMap.get(key);
    if (existing) {
      bgHits += 1;
      return existing;
    }

    // 缓存未命中——创建新的 BindGroup
    bgMisses += 1;

    const bindGroup = gpuDevice.createBindGroup({
      label: label ?? `gis-forge-bg-${layoutLabel}`,
      layout,
      entries: rawEntries as GPUBindGroupEntry[],
    });

    // 存入缓存
    bindGroupMap.set(key, bindGroup);

    // 维护反向索引——每个 resourceId 记录它参与的 key
    for (const desc of descriptors) {
      let keySet = resourceToKeysMap.get(desc.resourceId);
      if (!keySet) {
        keySet = new Set<string>();
        resourceToKeysMap.set(desc.resourceId, keySet);
      }
      keySet.add(key);
    }

    return bindGroup;
  }

  /**
   * 移除所有引用指定 resourceId 的 BindGroup。
   *
   * @param resourceId - 被销毁的资源 ID
   * @returns 被移除的 BindGroup 数量
   *
   * @example
   * // 纹理被重建时，移除引用旧纹理的 BindGroup
   * const removed = cache.invalidateByResource('texture-terrain-0');
   * console.log(`Removed ${removed} stale BindGroups`);
   */
  function invalidateByResource(resourceId: string): number {
    // 从反向索引查找所有引用该资源的 key
    const keySet = resourceToKeysMap.get(resourceId);

    // 如果没有任何 BindGroup 引用该资源，直接返回 0
    if (!keySet || keySet.size === 0) {
      return 0;
    }

    let removedCount = 0;

    // 遍历所有引用该资源的 key
    for (const key of keySet) {
      // 从主缓存中移除
      if (bindGroupMap.delete(key)) {
        removedCount += 1;
      }

      // 清理其他资源的反向索引中对该 key 的引用
      // 需要遍历该 key 关联的所有 resourceId
      for (const [otherResId, otherKeySet] of resourceToKeysMap) {
        // 跳过当前正在处理的 resourceId
        if (otherResId === resourceId) continue;
        otherKeySet.delete(key);

        // 如果某个资源的反向索引为空，清理掉
        if (otherKeySet.size === 0) {
          resourceToKeysMap.delete(otherResId);
        }
      }
    }

    // 清理当前资源的反向索引
    resourceToKeysMap.delete(resourceId);

    // 更新失效计数
    bgInvalidations += removedCount;

    return removedCount;
  }

  /**
   * 根据完整 key 移除 BindGroup。
   *
   * @param key - 缓存 key
   * @returns 是否成功移除
   *
   * @example
   * cache.invalidateByKey('my-layout|0:buf-a,1:tex-b');
   */
  function invalidateByKey(key: string): boolean {
    const removed = bindGroupMap.delete(key);

    if (removed) {
      // 清理该 key 在所有反向索引中的引用
      for (const [resId, keySet] of resourceToKeysMap) {
        keySet.delete(key);
        if (keySet.size === 0) {
          resourceToKeysMap.delete(resId);
        }
      }
      bgInvalidations += 1;
    }

    return removed;
  }

  /**
   * 清空所有缓存的 BindGroup。
   *
   * @example
   * // 设备重建后清空
   * cache.clear();
   */
  function clearBindGroups(): void {
    bindGroupMap.clear();
    resourceToKeysMap.clear();
    // 不重置统计计数——保留历史数据用于分析
  }

  // ==================== Sampler 方法 ====================

  /**
   * 获取或创建 Sampler。
   *
   * @param descriptor - Sampler 描述符
   * @returns GPUSampler
   *
   * @example
   * const sampler = cache.sampler.getOrCreate({
   *   magFilter: 'linear',
   *   minFilter: 'linear',
   *   mipmapFilter: 'linear',
   *   addressModeU: 'repeat',
   *   addressModeV: 'repeat',
   * });
   */
  function samplerGetOrCreate(descriptor: GPUSamplerDescriptor): GPUSampler {
    // 计算缓存 key——按属性拼接
    const key = computeSamplerKey(descriptor);

    // 尝试缓存命中
    const existing = samplerMap.get(key);
    if (existing) {
      samplerHits += 1;
      return existing;
    }

    // 缓存未命中——创建新 Sampler
    samplerMisses += 1;

    const sampler = gpuDevice.createSampler({
      label: descriptor.label ?? `gis-forge-sampler-${key.substring(0, 50)}`,
      magFilter: descriptor.magFilter,
      minFilter: descriptor.minFilter,
      mipmapFilter: descriptor.mipmapFilter,
      addressModeU: descriptor.addressModeU,
      addressModeV: descriptor.addressModeV,
      addressModeW: descriptor.addressModeW,
      lodMinClamp: descriptor.lodMinClamp,
      lodMaxClamp: descriptor.lodMaxClamp,
      compare: descriptor.compare,
      maxAnisotropy: descriptor.maxAnisotropy,
    });

    // 存入缓存
    samplerMap.set(key, sampler);

    return sampler;
  }

  /**
   * 清空所有缓存的 Sampler。
   *
   * @example
   * cache.sampler.clear();
   */
  function clearSamplers(): void {
    samplerMap.clear();
  }

  // ==================== 组合 Sampler 缓存对象 ====================

  const samplerCacheObj: SamplerCache = {
    getOrCreate: samplerGetOrCreate,
    clear: clearSamplers,

    /** Sampler 缓存统计信息。 */
    get stats(): SamplerCacheStats {
      return {
        hits: samplerHits,
        misses: samplerMisses,
        size: samplerMap.size,
      };
    },

    /** Sampler 缓存大小。 */
    get size(): number {
      return samplerMap.size;
    },
  };

  // ==================== 返回组合对象 ====================

  return {
    getOrCreate,
    invalidateByResource,
    invalidateByKey,
    clear: clearBindGroups,

    /** BindGroup 缓存统计信息。 */
    get stats(): BindGroupCacheStats {
      const totalRequests = bgHits + bgMisses;
      return {
        hits: bgHits,
        misses: bgMisses,
        size: bindGroupMap.size,
        // 除零保护——无请求时命中率为 0
        hitRate: totalRequests > 0 ? bgHits / totalRequests : 0,
        invalidations: bgInvalidations,
      };
    },

    /** BindGroup 缓存大小。 */
    get size(): number {
      return bindGroupMap.size;
    },

    /** 关联的 Sampler 缓存。 */
    sampler: samplerCacheObj,
  };
}
