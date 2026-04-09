# GeoForge 第三方依赖清单

> 记录项目所有 npm 依赖的**作用、用途、来源、许可证、精度级别**。
> 用于架构审计、供应链安全检查、许可证合规审查。
>
> 更新时间：2026-04-09
> 对应 `package.json` 版本：0.0.0

---

## 设计原则

GeoForge 的整体路线是 **"核心算法自研 Float64，成熟领域接事实标准库"**。
对于下列三类场景，选择引入第三方依赖而非自研：

1. **算法复杂到自研会引入大量 bug**（如测地线 Karney 正反算、多边形布尔运算的 Martinez 扫描线）
2. **行业已有事实标准，互操作性重要**（如 H3 六边形索引，必须与 h3-py / h3-java 二进制兼容）
3. **纯 UI 组件**（React 生态的拖拽 / 虚拟滚动 / 图表）

其余 127 条 GIS 算法清单均为自研 Float64 实现（见 `GeoForge_GIS_Algorithm_Audit.md`）。

---

## 一、GIS 算法底层（3 个）

这是项目的**技术核心依赖**，直接参与地理计算。

### 1. `geographiclib-geodesic` — 测地线计算

| 项 | 值 |
|---|---|
| 版本 | `^2.2.0` |
| 许可证 | **MIT** |
| 作者 | Charles F. F. Karney（原 SRI International） |
| 仓库 | https://github.com/geographiclib/geographiclib-js |
| 主页 | https://geographiclib.sourceforge.io |
| 论文 | Karney, C.F.F. (2013). "Algorithms for geodesics", *J. Geodesy* 87(1):43-55. DOI [10.1007/s00190-012-0578-z](https://doi.org/10.1007/s00190-012-0578-z) |
| 压缩大小 | ~40 KB |
| 作用 | WGS84 椭球面任意两点的正反算、距离、方位角、对跖点稳定求解 |

**项目用途**：
- 驱动 `core/geo/karney.ts` 的 `karneyInverse / karneyDirect`
- 间接驱动 `core/geo/geodesic.ts` 的 `karneyDistance / karneyInitialBearing` 包装
- 是 `analysis/buffer` 底层 `vincentyDirect` 的**精度参照**（buffer 自己仍用 core 的 Vincenty，因为精度差异可接受）

**替代了的自研算法**：
- ~~自研 Karney 级数展开 (order-6 A1/C1/C1p/A2/C2/A3/C3 系数 + Newton α₁ 迭代)~~ 删除，约 600 行

**精度**：
- 距离误差 ≤ 15 nm（纳米），~ 10⁻¹⁰ 相对
- 方位角误差 ≤ 1 µas ≈ 5×10⁻¹² 弧度
- **对跖点无条件收敛**（Vincenty 失败的场景它照常工作）

**引入位置**：`core/geo/karney.ts:19`（`import { Geodesic } from 'geographiclib-geodesic'`）

---

### 2. `polygon-clipping` — 多边形布尔运算

| 项 | 值 |
|---|---|
| 版本 | `^0.15.7` |
| 许可证 | **MIT** |
| 作者 | Mike Fogel (mfogel) |
| 仓库 | https://github.com/mfogel/polygon-clipping |
| 论文基础 | Martinez, F., Ooms, K., Rueda, A.J., Feito, F. (2009). "A new algorithm for computing Boolean operations on polygons", *Computers & Geosciences* 35(6):1177-1185 |
| 压缩大小 | ~30 KB |
| 作用 | 任意简单/凹/多孔多边形的 intersection / union / difference / xor，GeoJSON 风格 MultiPolygon 输出 |

**项目用途**：
- 驱动 `analysis/boolean/martinez.ts` 的 `martinez(subject, clipping, op)` 公共 API
- 通过 `BooleanOps.martinezBoolean` 暴露给 Feature 工作流

**替代了的自研算法**：
- ~~自研 Martinez 扫描线（事件队列 + 状态 T + 边分裂 + connectEdges 环追踪）~~ 删除，约 550 行
- 自研版在 `connectEdges` 阶段有结构性 bug，重叠正方形交集返回 0 环

**正确性**：
- 通过 `polygon-clipping` 上游 100+ 测试，包含 Martinez 论文所有退化情况
- 正确处理共线边、共享顶点、T 形交、内嵌孔洞
- 数值容差稳健（作者针对浮点误差做了专门补强）

**引入位置**：`analysis/src/boolean/martinez.ts:22`（`import polygonClipping from 'polygon-clipping'`）

---

### 3. `h3-js` — Uber H3 六边形层次空间索引

| 项 | 值 |
|---|---|
| 版本 | `^4.4.0` |
| 许可证 | **Apache-2.0** |
| 维护 | Uber Technologies |
| 仓库 | https://github.com/uber/h3-js |
| 上游 C 库 | https://github.com/uber/h3 |
| 压缩大小 | ~200 KB（含 wasm/asm.js 核心）|
| 作用 | 全球 122 个基础单元 + aperture-7 细化的六边形层次索引，分辨率 0-15 |

**项目用途**：
- 驱动 `core/index/h3.ts` 全部 API（`latLngToH3 / h3ToLatLng / h3Parent / h3Children / h3Disk / h3Ring / h3Distance / polygonToH3` 等 14 个函数）
- **核心动机**：必须与 h3-py / h3-java / PostGIS-H3 **二进制兼容**（同一经纬度 + 分辨率在跨语言生态中产生相同的 15-字符 hex ID），才能与现有数据互换

**不自研的原因**：
- 完整 H3 需要 122 项基础单元查表（home face / IJK / isPentagon / cwOffsetFaces）+ 20 面二十面体 + gnomonic 投影 + aperture-7 数字逻辑
- 自研会破坏二进制兼容性，失去与生态互操作的价值
- Uber 官方 JS 移植的 wasm 核心质量 > 自研 TypeScript

**引入位置**：`core/index/h3.ts:19`（`import { latLngToCell as _latLngToCell, ... } from 'h3-js'`）

---

## 二、UI 组件（7 个）

这些依赖**不参与 GIS 算法**，仅用于 `src/App.tsx` / `src/components/` 的 DevPlayground 示例应用。

### 4. `react` / `react-dom`

| 项 | 值 |
|---|---|
| 版本 | `^19.1.0` |
| 许可证 | MIT |
| 作者 | Meta (Facebook) |
| 仓库 | https://github.com/facebook/react |
| 作用 | 示例应用 UI 框架 |

**项目用途**：`src/App.tsx` + 所有 `.tsx` 组件。核心 GIS 库本身（`src/packages/*`）**不依赖 React**，可在任何 JS 环境使用。

---

### 5. `@dnd-kit/core` + `@dnd-kit/sortable` + `@dnd-kit/utilities`

| 项 | 值 |
|---|---|
| 版本 | `^6.3.1 / ^10.0.0 / ^3.2.2` |
| 许可证 | MIT |
| 作者 | Claudéric Demers |
| 仓库 | https://github.com/clauderic/dnd-kit |
| 作用 | 无障碍拖拽工具包，支持键盘 / 触屏 / 屏幕阅读器 |

**项目用途**：DevPlayground 的图层列表拖拽排序

---

### 6. `@tanstack/react-virtual`

| 项 | 值 |
|---|---|
| 版本 | `^3.13.6` |
| 许可证 | MIT |
| 作者 | Tanner Linsley |
| 仓库 | https://github.com/TanStack/virtual |
| 作用 | 虚拟滚动列表（只渲染可视区域内的 DOM 节点）|

**项目用途**：DevPlayground 的大数据列表（如瓦片调试面板）

---

### 7. `lucide-react`

| 项 | 值 |
|---|---|
| 版本 | `^0.487.0` |
| 许可证 | ISC |
| 作者 | Lucide Contributors（原 feather-icons fork） |
| 仓库 | https://github.com/lucide-icons/lucide |
| 作用 | 图标组件库（SVG，按需导入，tree-shake 友好） |

**项目用途**：DevPlayground 工具栏图标（`src/components/toolbar/`）

---

### 8. `react-colorful`

| 项 | 值 |
|---|---|
| 版本 | `^5.6.1` |
| 许可证 | MIT |
| 作者 | Vlad Shilov |
| 仓库 | https://github.com/omgovich/react-colorful |
| 作用 | 轻量级颜色选择器组件 |

**项目用途**：DevPlayground 样式编辑面板

---

### 9. `react-resizable-panels`

| 项 | 值 |
|---|---|
| 版本 | `^2.1.7` |
| 许可证 | MIT |
| 作者 | Brian Vaughn（原 React core team） |
| 仓库 | https://github.com/bvaughn/react-resizable-panels |
| 作用 | 可拖拽分割的面板布局 |

**项目用途**：DevPlayground 主布局（地图 ⟷ 侧栏分隔条）

**引入位置**：`src/components/layout/*`

---

### 10. `recharts`

| 项 | 值 |
|---|---|
| 版本 | `^2.15.3` |
| 许可证 | MIT |
| 作者 | Recharts Group |
| 仓库 | https://github.com/recharts/recharts |
| 作用 | 基于 D3 + React 的声明式图表库 |

**项目用途**：DevPlayground 的渲染统计图表（FPS、drawcall、帧时间）

---

### 11. `sonner`

| 项 | 值 |
|---|---|
| 版本 | `^2.0.3` |
| 许可证 | MIT |
| 作者 | Emil Kowalski |
| 仓库 | https://github.com/emilkowalski/sonner |
| 作用 | 无障碍 toast 通知组件 |

**项目用途**：DevPlayground 的错误 / 成功提示

---

### 12. `zustand`

| 项 | 值 |
|---|---|
| 版本 | `^5.0.5` |
| 许可证 | MIT |
| 作者 | Poimandres (pmndrs) |
| 仓库 | https://github.com/pmndrs/zustand |
| 作用 | 极简 React 状态管理（基于 hooks，无 boilerplate） |

**项目用途**：DevPlayground 的全局 UI 状态（当前图层选择、面板开关等）

---

## 三、开发依赖（devDependencies，11 个）

### 13. `vite` + `@vitejs/plugin-react`

| 项 | 值 |
|---|---|
| 版本 | `^8.0.1 / ^4.5.2` |
| 许可证 | MIT |
| 作者 | Evan You（Vue 作者） + Vite Team |
| 仓库 | https://github.com/vitejs/vite |
| 作用 | 开发服务器 + 构建工具（基于 Rollup + esbuild） |

**项目用途**：`npm run dev / build / preview`；WGSL `?raw` 导入（`gpu/src/wgsl/**/*.wgsl`）

---

### 14. `vitest` + `@vitest/coverage-v8`

| 项 | 值 |
|---|---|
| 版本 | `^4.1.3` |
| 许可证 | MIT |
| 作者 | Anthony Fu + Vitest Team |
| 仓库 | https://github.com/vitest-dev/vitest |
| 作用 | 单元测试框架（Vite 原生集成，Jest API 兼容） |

**项目用途**：`npm test` 运行 `tests/**/*.test.ts`（当前 204 个测试）。配置见 `vitest.config.ts`

---

### 15. `typescript`

| 项 | 值 |
|---|---|
| 版本 | `~5.9.3` |
| 许可证 | Apache-2.0 |
| 作者 | Microsoft |
| 仓库 | https://github.com/microsoft/TypeScript |
| 作用 | 类型检查 + 编译 |

**项目用途**：全项目类型系统。`tsconfig.json` 启用 `erasableSyntaxOnly`（禁用 `const enum` 等编译时语法）

---

### 16. `tsx`

| 项 | 值 |
|---|---|
| 版本 | `^4.21.0` |
| 许可证 | MIT |
| 作者 | Hiroki Osame (privatenumber) |
| 仓库 | https://github.com/privatenumber/tsx |
| 作用 | Node.js 原生运行 TypeScript 的 CLI 工具 |

**项目用途**：`npm run check:bundle / check:deps` 脚本运行（`scripts/*.ts`）

---

### 17. `tailwindcss` + `@tailwindcss/vite`

| 项 | 值 |
|---|---|
| 版本 | `^4.1.4` |
| 许可证 | MIT |
| 作者 | Adam Wathan + Tailwind Labs |
| 仓库 | https://github.com/tailwindlabs/tailwindcss |
| 作用 | 原子化 CSS 框架 |

**项目用途**：DevPlayground 样式系统（`src/index.css` + `className=` 到处散布）

---

### 18. `@types/react` + `@types/react-dom`

| 项 | 值 |
|---|---|
| 版本 | `^19.1.2` |
| 许可证 | MIT |
| 作者 | DefinitelyTyped Community |
| 作用 | React 的 TypeScript 类型声明 |

---

### 19. `@webgpu/types`

| 项 | 值 |
|---|---|
| 版本 | `^0.1.69` |
| 许可证 | BSD-3-Clause |
| 作者 | W3C WebGPU Working Group |
| 仓库 | https://github.com/gpuweb/types |
| 作用 | WebGPU 的 TypeScript 类型声明（`GPUDevice / GPUBuffer / GPURenderPipeline` 等）|

**项目用途**：`src/packages/gpu/**` 的类型支持。运行时 API 由浏览器提供，本包只负责编译时类型

---

## 四、许可证汇总

| 许可证 | 包数 | 包 |
|---|---|---|
| MIT | 15 | geographiclib-geodesic, polygon-clipping, react, react-dom, @dnd-kit/*, @tanstack/react-virtual, react-colorful, react-resizable-panels, recharts, sonner, zustand, vite, @vitejs/plugin-react, vitest, tsx, tailwindcss, @tailwindcss/vite, @types/* |
| Apache-2.0 | 2 | h3-js, typescript |
| ISC | 1 | lucide-react |
| BSD-3-Clause | 1 | @webgpu/types |

**全部为宽松许可证，无 GPL/AGPL 强传染**。可以商用闭源发布。

---

## 五、三条关键算法依赖对比（自研 vs 切换前/后）

| 算法 | 原自研实现 | 切换后 | 改动 |
|---|---|---|---|
| **Karney 测地线** (#44) | ~600 行 order-6 级数 + Newton 迭代（有 bug） | `geographiclib-geodesic` ~120 行包装 | 精度从 ~米级 → 15 nm；对跖点从 NaN → 正确值 |
| **Martinez 布尔运算** (#10) | ~550 行扫描线（connectEdges 有 bug，空结果） | `polygon-clipping` ~100 行包装 | 正确处理凹多边形/孔洞/共线边；13 个严格测试全绿 |
| **H3 六边形索引** (#34) | 从未尝试自研（表太大） | `h3-js` ~150 行包装 | 与 Uber H3 生态二进制兼容 |

**总削减自研代码**：~1150 行
**引入第三方代码**：~270 KB 压缩后（含 h3-js WASM）
**权衡收益**：算法正确性、精度、生态互操作性

---

## 六、后续可能引入的依赖（候选）

如果项目后续需要，以下候选已在团队认可范围内（不会触发"必须自研"原则）：

| 候选 | 用途 | 替代的自研算法 |
|---|---|---|
| `proj4` / `proj4js` | 通用坐标投影（任意 EPSG 代码） | `projection-math.ts` 的 UTM / Lambert / Helmert |
| `rbush` | 高性能 R-Tree | `core/index/rtree.ts`（自研已通过测试） |
| `earcut` | 多边形三角剖分 | `core/algorithm/earcut.ts`（自研已通过测试，也是 earcut 移植） |
| `supercluster` | 高性能点聚类 | `core/algorithm/cluster.ts` supercluster 部分 |

目前**暂不引入**这些依赖；除非出现具体的正确性或性能问题。

---

## 七、依赖升级策略

- **锁版本策略**：`package.json` 使用 `^` 前缀允许 patch/minor 自动升级。`package-lock.json` 锁定精确版本以保证可重现构建
- **高风险依赖审查**：`geographiclib-geodesic / polygon-clipping / h3-js` 三个核心算法依赖**不允许盲升 major 版本**——major 升级必须先在分支跑完所有 204 个测试
- **security advisories**：`npm audit` 定期扫描；当前已知 3 项 high 严重度漏洞来自 h3-js 的传递依赖（非运行时路径），后续可用 `npm audit fix` 或手动 override 处理

---

## 八、如何查阅依赖来源

每个依赖在源码中都有明确引入位置（`import` 语句所在文件和行号）。搜索命令：

```bash
grep -rn "from 'h3-js'" src/                      # h3-js
grep -rn "from 'geographiclib-geodesic'" src/     # Karney
grep -rn "from 'polygon-clipping'" src/           # Martinez
grep -rn "from '@dnd-kit'" src/                   # dnd-kit
```

---

**文档维护**：每次引入 / 删除 npm 依赖时同步更新此文件，保证与 `package.json` 一致。
