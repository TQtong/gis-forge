// ============================================================
// packages/gpu/src/l2/uniform-layout.ts — Uniform 缓冲布局计算
// 供 ShaderAssembler.buildUniformLayout / generateUniformWGSL 使用。
// 零 npm 依赖；ShaderModuleDefinition 自 shader-types 以 import type 引用，避免与 shader-assembler 环依赖。
// ============================================================

import type { ShaderModuleDefinition } from './shader-types.ts';

/**
 * WGSL uniform 标量/向量/矩阵字段类型（与 WGSL 对齐规则一致）。
 */
export type UniformFieldType =
  | 'f32'
  | 'i32'
  | 'u32'
  | 'vec2f'
  | 'vec2i'
  | 'vec2u'
  | 'vec3f'
  | 'vec3i'
  | 'vec3u'
  | 'vec4f'
  | 'vec4i'
  | 'vec4u'
  | 'mat3x3f'
  | 'mat4x4f';

/**
 * 单个 uniform 字段描述（CPU 布局与 WGSL struct 成员一一对应）。
 */
export interface UniformField {
  /** 字段名（WGSL struct 成员名，须为合法标识符） */
  readonly name: string;
  /** WGSL 类型 */
  readonly type: UniformFieldType;
}

/**
 * 已计算的字节布局与 WGSL 片段，供 BindGroup / CPU 写入共用。
 */
export interface ComputedUniformLayout {
  /** 有序字段列表（与 struct 声明顺序一致） */
  readonly fields: readonly UniformField[];
  /** 字段名 → 字节偏移（自 buffer 起点） */
  readonly offsets: ReadonlyMap<string, number>;
  /** 含尾部 padding 的总字节数（满足 struct 对齐） */
  readonly totalSize: number;
  /** 生成的 WGSL struct 源码（不含 group/binding） */
  readonly wgslStructCode: string;
  /** 生成的 `@group` / `@binding` / `var<uniform>` 声明 */
  readonly wgslBindingCode: string;
}

/**
 * Mat4 列主序 16 元数组（与 L0 `Mat4f` 兼容，避免 gpu 包依赖 core 路径）。
 */
export type Mat4f = Float32Array;

/**
 * CPU 侧按字段名写入 `ArrayBuffer`，与 `ComputedUniformLayout.offsets` 对齐。
 */
export interface UniformWriter {
  /** 底层字节缓冲 */
  readonly buffer: ArrayBuffer;
  /** 按字段偏移写入的 `DataView` */
  readonly view: DataView;
  /** 写入 32 位浮点标量 */
  setFloat(name: string, value: number): this;
  /** 写入 32 位有符号整型 */
  setInt(name: string, value: number): this;
  /** 写入 32 位无符号整型 */
  setUint(name: string, value: number): this;
  /** 写入二维浮点向量 */
  setVec2(name: string, x: number, y: number): this;
  /** 写入三维浮点向量 */
  setVec3(name: string, x: number, y: number, z: number): this;
  /** 写入四维浮点向量 */
  setVec4(name: string, x: number, y: number, z: number, w: number): this;
  /** 写入 4×4 矩阵（列主序 16 元） */
  setMat4(name: string, m: Mat4f): this;
  /** 返回可上传 GPU 的缓冲副本 */
  getData(): ArrayBuffer;
}

/**
 * 无状态可复用的 Uniform 布局构建器（先 `addField` 再 `build`）。
 */
export interface UniformLayoutBuilder {
  /** 追加单个字段（重复名称由实现拒绝） */
  addField(name: string, type: UniformFieldType): this;
  /** 自 `ShaderModuleDefinition.uniformDeclarations` 批量追加 */
  addFromModule(module: ShaderModuleDefinition): this;
  /** 根据当前字段生成布局与 WGSL 片段 */
  build(group: number, binding: number): ComputedUniformLayout;
  /** 基于布局创建写入器 */
  createWriter(layout: ComputedUniformLayout): UniformWriter;
  /** 清空已登记字段，便于下一缓冲 */
  reset(): this;
}

/** WGSL struct 成员对齐：向上取整到 alignment */
function alignUp(offset: number, alignment: number): number {
  if (alignment <= 0 || !Number.isFinite(alignment)) {
    throw new Error('UniformLayoutBuilder: alignment must be a finite positive number.');
  }
  const a = Math.floor(alignment);
  const o = Math.floor(offset);
  return ((o + a - 1) / a | 0) * a;
}

/** 查询类型的 WGSL 对齐要求（与 WGSL 规范一致） */
function alignOfType(t: UniformFieldType): number {
  switch (t) {
    case 'f32':
    case 'i32':
    case 'u32':
      return 4;
    case 'vec2f':
    case 'vec2i':
    case 'vec2u':
      return 8;
    case 'vec3f':
    case 'vec3i':
    case 'vec3u':
      return 16;
    case 'vec4f':
    case 'vec4i':
    case 'vec4u':
      return 16;
    case 'mat3x3f':
    case 'mat4x4f':
      return 16;
    default:
      return 4;
  }
}

/** 查询类型的字节大小（含 vec3 的 12 字节存储） */
function sizeOfType(t: UniformFieldType): number {
  switch (t) {
    case 'f32':
    case 'i32':
    case 'u32':
      return 4;
    case 'vec2f':
    case 'vec2i':
    case 'vec2u':
      return 8;
    case 'vec3f':
    case 'vec3i':
    case 'vec3u':
      return 12;
    case 'vec4f':
    case 'vec4i':
    case 'vec4u':
      return 16;
    case 'mat3x3f':
      return 48;
    case 'mat4x4f':
      return 64;
    default:
      return 4;
  }
}

/** 将内部类型枚举转为 WGSL 类型字符串 */
function toWGSLType(t: UniformFieldType): string {
  switch (t) {
    case 'f32':
      return 'f32';
    case 'i32':
      return 'i32';
    case 'u32':
      return 'u32';
    case 'vec2f':
      return 'vec2<f32>';
    case 'vec2i':
      return 'vec2<i32>';
    case 'vec2u':
      return 'vec2<u32>';
    case 'vec3f':
      return 'vec3<f32>';
    case 'vec3i':
      return 'vec3<i32>';
    case 'vec3u':
      return 'vec3<u32>';
    case 'vec4f':
      return 'vec4<f32>';
    case 'vec4i':
      return 'vec4<i32>';
    case 'vec4u':
      return 'vec4<u32>';
    case 'mat3x3f':
      return 'mat3x3<f32>';
    case 'mat4x4f':
      return 'mat4x4<f32>';
    default:
      return 'f32';
  }
}

/**
 * 校验字段名为合法 WGSL 标识符（保守子集：字母/数字/下划线，不以数字开头）。
 *
 * @param name - 待校验名称
 * @returns 无返回值
 * @throws Error 当名称非法时抛出
 *
 * @example
 * validateFieldName('uMyUniform');
 */
function validateFieldName(name: string): void {
  if (name.length === 0) {
    throw new Error('UniformLayoutBuilder: field name must be non-empty.');
  }
  const ok = /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
  if (!ok) {
    throw new Error(`UniformLayoutBuilder: invalid WGSL field name "${name}".`);
  }
}

/**
 * 由字段列表计算偏移、总大小与 WGSL struct 片段。
 *
 * @param fields - 有序字段
 * @param group - WebGPU bind group 索引
 * @param binding - binding 槽位
 * @returns 计算后的布局对象
 * @throws Error 当字段重名或集合为空时抛出
 *
 * @example
 * const layout = computeLayout([{ name: 'opacity', type: 'f32' }], 1, 1);
 */
function computeLayout(fields: readonly UniformField[], group: number, binding: number): ComputedUniformLayout {
  if (fields.length === 0) {
    throw new Error('UniformLayoutBuilder.build: at least one field is required.');
  }
  const seen = new Set<string>();
  const offsets = new Map<string, number>();
  let offset = 0;
  let maxMemberAlign = 1;
  for (const f of fields) {
    if (seen.has(f.name)) {
      throw new Error(`UniformLayoutBuilder: duplicate field name "${f.name}".`);
    }
    seen.add(f.name);
    const al = alignOfType(f.type);
    maxMemberAlign = Math.max(maxMemberAlign, al);
    offset = alignUp(offset, al);
    offsets.set(f.name, offset);
    offset += sizeOfType(f.type);
  }
  const structAlign = maxMemberAlign;
  const totalSize = alignUp(offset, structAlign);

  const structName = `GeoForgeUniforms_g${group}_b${binding}`;
  const varName = `uGeoForgeUniforms_${group}_${binding}`;
  const lines: string[] = [];
  lines.push(`struct ${structName} {`);
  for (const f of fields) {
    lines.push(`  ${f.name}: ${toWGSLType(f.type)},`);
  }
  lines.push(`}`);
  const wgslStructCode = lines.join('\n');
  const wgslBindingCode = `@group(${group}) @binding(${binding}) var<uniform> ${varName}: ${structName};`;

  return {
    fields,
    offsets,
    totalSize,
    wgslStructCode,
    wgslBindingCode,
  };
}

/**
 * 创建 `UniformWriter` 实例，写入路径与 `ComputedUniformLayout` 一致。
 *
 * @param layout - 已计算布局
 * @returns 可写对象
 *
 * @example
 * const w = createUniformWriter(layout);
 * w.setFloat('opacity', 0.5);
 */
function createUniformWriter(layout: ComputedUniformLayout): UniformWriter {
  const buffer = new ArrayBuffer(layout.totalSize);
  const view = new DataView(buffer);

  const setFloat = (name: string, value: number): UniformWriter => {
    const off = layout.offsets.get(name);
    if (off === undefined) {
      throw new Error(`UniformWriter.setFloat: unknown field "${name}".`);
    }
    const f = layout.fields.find((x) => x.name === name);
    if (!f || (f.type !== 'f32' && f.type !== 'i32' && f.type !== 'u32')) {
      throw new Error(`UniformWriter.setFloat: field "${name}" is not a scalar numeric type.`);
    }
    if (!Number.isFinite(value)) {
      throw new Error(`UniformWriter.setFloat: value for "${name}" must be finite.`);
    }
    if (f.type === 'f32') {
      view.setFloat32(off, value, true);
    } else if (f.type === 'i32') {
      view.setInt32(off, Math.trunc(value), true);
    } else {
      view.setUint32(off, Math.max(0, Math.trunc(value)) >>> 0, true);
    }
    return writer;
  };

  const setInt = (name: string, value: number): UniformWriter => {
    const off = layout.offsets.get(name);
    if (off === undefined) {
      throw new Error(`UniformWriter.setInt: unknown field "${name}".`);
    }
    const f = layout.fields.find((x) => x.name === name);
    if (!f || f.type !== 'i32') {
      throw new Error(`UniformWriter.setInt: field "${name}" is not i32.`);
    }
    view.setInt32(off, Math.trunc(value), true);
    return writer;
  };

  const setUint = (name: string, value: number): UniformWriter => {
    const off = layout.offsets.get(name);
    if (off === undefined) {
      throw new Error(`UniformWriter.setUint: unknown field "${name}".`);
    }
    const f = layout.fields.find((x) => x.name === name);
    if (!f || f.type !== 'u32') {
      throw new Error(`UniformWriter.setUint: field "${name}" is not u32.`);
    }
    view.setUint32(off, Math.max(0, Math.trunc(value)) >>> 0, true);
    return writer;
  };

  const setVec2 = (name: string, x: number, y: number): UniformWriter => {
    const off = layout.offsets.get(name);
    if (off === undefined) {
      throw new Error(`UniformWriter.setVec2: unknown field "${name}".`);
    }
    const f = layout.fields.find((e) => e.name === name);
    if (!f || f.type !== 'vec2f') {
      throw new Error(`UniformWriter.setVec2: field "${name}" is not vec2f.`);
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error(`UniformWriter.setVec2: components must be finite.`);
    }
    view.setFloat32(off, x, true);
    view.setFloat32(off + 4, y, true);
    return writer;
  };

  const setVec3 = (name: string, x: number, y: number, z: number): UniformWriter => {
    const off = layout.offsets.get(name);
    if (off === undefined) {
      throw new Error(`UniformWriter.setVec3: unknown field "${name}".`);
    }
    const f = layout.fields.find((e) => e.name === name);
    if (!f || f.type !== 'vec3f') {
      throw new Error(`UniformWriter.setVec3: field "${name}" is not vec3f.`);
    }
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      throw new Error(`UniformWriter.setVec3: components must be finite.`);
    }
    view.setFloat32(off, x, true);
    view.setFloat32(off + 4, y, true);
    view.setFloat32(off + 8, z, true);
    return writer;
  };

  const setVec4 = (name: string, x: number, y: number, z: number, w: number): UniformWriter => {
    const off = layout.offsets.get(name);
    if (off === undefined) {
      throw new Error(`UniformWriter.setVec4: unknown field "${name}".`);
    }
    const f = layout.fields.find((e) => e.name === name);
    if (!f || f.type !== 'vec4f') {
      throw new Error(`UniformWriter.setVec4: field "${name}" is not vec4f.`);
    }
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z) || !Number.isFinite(w)) {
      throw new Error(`UniformWriter.setVec4: components must be finite.`);
    }
    view.setFloat32(off, x, true);
    view.setFloat32(off + 4, y, true);
    view.setFloat32(off + 8, z, true);
    view.setFloat32(off + 12, w, true);
    return writer;
  };

  const setMat4 = (name: string, m: Mat4f): UniformWriter => {
    const off = layout.offsets.get(name);
    if (off === undefined) {
      throw new Error(`UniformWriter.setMat4: unknown field "${name}".`);
    }
    const f = layout.fields.find((e) => e.name === name);
    if (!f || f.type !== 'mat4x4f') {
      throw new Error(`UniformWriter.setMat4: field "${name}" is not mat4x4f.`);
    }
    if (m.length !== 16) {
      throw new Error('UniformWriter.setMat4: Mat4f must have 16 elements.');
    }
    for (let i = 0; i < 16; i++) {
      const v = m[i];
      if (!Number.isFinite(v)) {
        throw new Error(`UniformWriter.setMat4: element ${i} is not finite.`);
      }
      view.setFloat32(off + i * 4, v, true);
    }
    return writer;
  };

  const getData = (): ArrayBuffer => buffer.slice(0);

  const writer: UniformWriter = {
    buffer,
    view,
    setFloat,
    setInt,
    setUint,
    setVec2,
    setVec3,
    setVec4,
    setMat4,
    getData,
  };
  return writer;
}

/**
 * 将 `ShaderUniformDeclaration.type` 映射为 `UniformFieldType`（二者可表示集合须兼容）。
 *
 * @param t - 着色器声明类型
 * @returns 布局器使用的类型枚举
 * @throws Error 当遇到未知类型时抛出
 *
 * @example
 * const u = mapShaderUniformType('vec3f');
 */
export function mapShaderUniformType(
  t: 'f32' | 'vec2f' | 'vec3f' | 'vec4f' | 'mat3x3f' | 'mat4x4f' | 'u32' | 'i32',
): UniformFieldType {
  return t;
}

/**
 * 创建新的 `UniformLayoutBuilder` 实例。
 *
 * @returns 可链式调用的构建器
 *
 * @example
 * const b = createUniformLayoutBuilder();
 * b.addField('x', 'f32').build(0, 1);
 */
export function createUniformLayoutBuilder(): UniformLayoutBuilder {
  const fields: UniformField[] = [];

  const self: UniformLayoutBuilder = {
    addField(name: string, type: UniformFieldType): UniformLayoutBuilder {
      validateFieldName(name);
      for (const f of fields) {
        if (f.name === name) {
          throw new Error(`UniformLayoutBuilder.addField: duplicate field "${name}".`);
        }
      }
      fields.push({ name, type });
      return self;
    },

    addFromModule(module: ShaderModuleDefinition): UniformLayoutBuilder {
      const decls = module.uniformDeclarations;
      if (!decls || decls.length === 0) {
        return self;
      }
      for (const d of decls) {
        self.addField(d.name, mapShaderUniformType(d.type));
      }
      return self;
    },

    build(group: number, binding: number): ComputedUniformLayout {
      if (!Number.isInteger(group) || group < 0) {
        throw new Error('UniformLayoutBuilder.build: group must be a non-negative integer.');
      }
      if (!Number.isInteger(binding) || binding < 0) {
        throw new Error('UniformLayoutBuilder.build: binding must be a non-negative integer.');
      }
      const snapshot = fields.slice() as UniformField[];
      return computeLayout(snapshot, group, binding);
    },

    createWriter(layout: ComputedUniformLayout): UniformWriter {
      return createUniformWriter(layout);
    },

    reset(): UniformLayoutBuilder {
      fields.length = 0;
      return self;
    },
  };

  return self;
}
