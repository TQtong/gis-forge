# GIS-Forge 当前进度审计与 3D / 2.5D 实施路线图

> 2026-07-23 实施更新：本节优先级高于下文 2026-07-16 的原始审计快照；原始内容保留用于追踪问题来源。

## 0. 2026-07-23 实施状态

| 范围 | 当前状态 | 已落地结果 |
|---|---|---|
| 工程门禁 | 已恢复 | TypeScript、26 个测试文件 / 238 项测试、生产构建、依赖边界、bundle 预算全部通过；JS gzip 156.1 KiB；分层违规由 18 项降为 0 |
| 生命周期 | 已修复 | React StrictMode 下的 ready/teardown 竞态、主动 device destroy 误报、Globe bootstrap 失败不再伪装 ready |
| Camera25D | 已修复核心语义 | 统一 camera-relative VP；修复左右手性、project/unproject 与高 pitch 覆盖；增加极端姿态回归 |
| 2.5D raster | 已修复核心链路 | 高 pitch 不再退化为单中心瓦片；请求去重、取消计数与队列所有权修复；生成完整 mipmap 并纳入显存预算 |
| quantized-mesh terrain | 已修复核心链路 | TMS/XYZ、无 available 元数据、请求合并、中止、法线、高程三角插值、reversed-Z、透明占位与纹理生命周期均已修复；Geographic 地形改用多 OSM 瓦片 GPU 图集，裙边按局部高差自适应 |
| Camera3D | 已修复核心语义 | nadir/pitch/bearing、姿态更新不移动 ECEF position、公开 getter 与输入一致；重复 runtime Camera3D 不再从公共入口导出 |
| Globe 影像与 LOD | 已修复核心链路 | 屏幕中心拾取、外向三角形、高 zoom 安全键、椭球隔离缓存、scheme/max-level、离线 Natural Earth 演示、每网格独立 UV uniform；修复 opacity 片元访问与 bind-group 可见性不匹配导致的黑屏 |
| WebGPU 浏览器验收 | 已完成手工基线 | 在真实 WebGPU 浏览器固定视口验证 2D、北京 2.5D zoom 10 / pitch 45°、Globe；无应用 console error/warn，拉伸标签、条码状裙边与 Globe 黑屏均已消失；2D/Globe 增加 uncaptured WebGPU error 上报 |
| Globe facade 能力契约 | 已收敛 | 3D Tiles、Globe GeoJSON/entity、3D terrain、阴影、雾、MSAA、帧率限制、未接入的影像协议选项及 2D/2.5D morph 不再静默存状态或返回空结果；显式请求统一抛出结构化 `FEATURE_NOT_IMPLEMENTED`，并有构造选项契约测试 |
| 架构收敛 | 进行中 | 旧 `GlobeRenderer` stub 已退出公共入口；preset 仍持有 GPU 实现，尚未完全下沉到 globe/runtime |

### 本轮仍未伪装为“已完成”的边界

- 3D Tiles、GeoJSON/entity 渲染、3D terrain、阴影、雾与 feature picking 尚未实现；稳定 facade 已改为 fail-fast，不能作为生产能力验收，也不会再伪装调用成功。
- 2.5D Geographic terrain scheduler 仍是经验型覆盖 + SSE，不是真正的 frustum quadtree；需要独立性能与视觉回归。
- 已完成真实 WebGPU 手工截图验收，但截图尚未固化为 CI 可重复的像素差异门禁。
- `npm audit --omit=dev` 为 0；完整审计剩余 1 个上游 esbuild 低危公告（在 audit JSON 中沿 Vite/Vitest/tsx 传播为 8 个低危节点）。当前 Vite 8.1.5 / esbuild 0.27.4 依赖范围内无兼容修复，`npm audit fix` 已无法继续升级。

### 下一实现批次（按阻断级排序）

1. 将本轮真实 WebGPU 手工基线固化为固定视口截图回归，覆盖加载中祖先纹理、完成态、pitch 80°、日期变更线和极区。
2. 将 Geographic terrain 调度替换为真实 frustum/SSE 四叉树，并增加相邻 LOD 接缝与预算上限测试。
3. 将 `preset-3d/globe-gpu|render|tiles` 下沉为唯一 Globe renderer；删除旧非公开 stub 与重复 terrain 原型。
4. 按产品优先级逐项实现当前明确标记为 `FEATURE_NOT_IMPLEMENTED` 的 3D Tiles、GeoJSON/entity、3D terrain、阴影、雾与 picking；每项必须先形成独立渲染与测试闭环再重新开放。


> 审计日期：2026-07-16  
> 审计基线：master / 4a4597b  
> 审计范围：仓库结构、Git 历史、构建与测试、依赖边界、2D / 2.5D / 3D 运行时画面、相机与地形渲染链路
>
> 审计后即时修复：ENV-01、LIFE-01、CAM3-01、CAM3-02、CAM3-03 已在当前工作树落地并完成回归；其余路线不变。

## 1. 结论摘要

GIS-Forge 已经不是空壳：L0 数学与 GIS 算法、WebGPU 基础设施、2D 栅格地图、2.5D 相机、3D Globe、地形解码和大量扩展包都有实际代码。最新六个 PR 又加入了 Cesium quantized-mesh、terrain drape 与 2D/2.5D preset 接线。

但当前项目的主要矛盾已经从“缺少功能”变为“同一能力存在多套实现，跨模块坐标和生命周期契约没有被测试锁定”。因此：

- 2D 已达到可演示、可继续迭代的状态。
- 2.5D 能运行，但默认演示存在严重瓦片拉伸、地形幕墙/接缝、远景模糊和生命周期错误，暂不适合继续叠加功能。
- 3D Globe 能显示地球、大气和基础交互，但相机公开状态与实际姿态不一致，影像、地形、拾取和图层 API 仍有明显占位或未闭环部分。
- 目前不建议重写整个项目；应先建立坐标、相机、深度和资源生命周期四个契约，再把重复实现收敛到单一主路径。

## 2. 当前工程基线

| 项目 | 当前结果 | 说明 |
|---|---:|---|
| packages 数量 | 49 | 包数量多，职责重叠开始明显 |
| TypeScript / TSX 文件 | 314 | 不含生成物 |
| TypeScript / TSX 行数 | 约 129,386 | 代码量不能等同于完成度 |
| 架构文档 | 51 篇 | 设计充分，但部分“已完成”结论早于当前实现 |
| 单测 | 18 个文件 / 207 项 | 全部通过，新增 Camera3D 姿态契约测试 |
| 生产构建 | 通过 | Vite 8 构建成功 |
| 完整 JS gzip | 143.5 KiB | 低于当前 350 KiB 预算 |
| 依赖边界检查 | 失败 | 18 个跨层违规，主要集中于 preset-2d / 25d / 3d |
| 标准 npm ci | 已修复并通过 | @vitejs/plugin-react 已升级到兼容 Vite 8 的 6.0.3 |
| npm audit | 4 个开发依赖漏洞 | 1 low / 1 moderate / 2 high；生产依赖 audit 为 0 |

### 2.1 测试覆盖的真实边界

现有 204 项测试主要覆盖：

- core/algorithm
- core/geo
- core/index
- analysis
- 少量 globe LOD 纯数学

当前没有看到以下关键回归测试：

- Camera25D 的矩阵黄金值、project/unproject 往返和极端 pitch
- Camera3D 的 heading/pitch/roll 语义、nadir 退化和 ECEF 姿态
- 2.5D 栅格瓦片覆盖、父瓦片替代、接缝与深度组合
- quantized-mesh 解码后的空间范围、索引合法性和相邻瓦片连续性
- Globe 的 horizon/frustum、日期变更线、极区和影像 UV
- React StrictMode 下引擎创建/销毁/异步 ready 的竞态
- WebGPU 截图或像素级视觉回归

所以“测试全绿”只能证明基础数学模块稳定，不能证明 2.5D/3D 可用。

## 3. 功能成熟度

| 子系统 | 当前成熟度 | 已有能力 | 主要缺口 |
|---|---|---|---|
| L0 Core / Analysis | 较高 | 数学、椭球、投影、算法、空间索引 | API 一致性与性能基准仍需补充 |
| GPU / Runtime | 中等 | 资源、render graph、pipeline、调度骨架 | 与实际 preset 主路径结合不统一 |
| 2D | 中等偏高 | 栅格底图、平移缩放、基础图层与 UI | 安装门禁、生命周期日志、更多集成测试 |
| 2.5D | 低到中 | 透视 Camera25D、倾斜交互、瓦片覆盖、QM 地形 | 默认画面严重异常，深度/LOD/纹理/坐标契约未锁定 |
| 3D Globe | 低到中 | 椭球瓦片、大气、天空、RTE、基础 orbit/zoom | 相机姿态契约错误，多项 API 占位，主渲染器职责重复 |
| Terrain | 低 | DEM、quantized-mesh、terrain drape 多条原型链路 | 三至四套实现并存，尚无统一数据/缓存/渲染接口 |
| Preset Full / Morph | 原型 | 模式入口和 morph 代码存在 | 当前应用通过销毁重建切换，不是同一场景平滑切换 |

成熟度采用“是否形成可验证闭环”判断，不按文件数量判断。

## 4. 已复现问题

### P0-1：新环境无法标准安装（本次已修复）

复现命令：

1. npm ci
2. npm 返回 ERESOLVE

根因是原 package-lock 解析到 @vitejs/plugin-react 4.7.0，而该版本 peer range 不包含 Vite 8；项目同时要求 vite 8.0.1。本次已升级到 @vitejs/plugin-react 6.0.3，并在停止占用 node_modules 的开发服务器后验证标准 npm ci 成功。

影响：

- README 的安装步骤不可复现。
- CI 或新开发机无法在默认 npm 策略下开始验证。
- 后续所有测试结论都依赖 legacy peer 模式，可信度下降。

验收：

- 干净目录中 npm ci 成功。
- npm run build、npm test、npm run check:deps、npm run check:bundle 全部能直接运行。

### P0-2：2.5D 默认演示存在严重渲染异常

在根应用默认 2.5D、北京、zoom 10、pitch 45° 下可稳定看到：

- 近景纹理被大幅放大并模糊。
- 远景出现明显条带、接缝和近似垂直幕墙的几何。
- 同一视口调度约 80 个栅格瓦片，而 2D 同位置约 9 个，缺少可解释的 LOD 指标。
- 平面 raster 与 Cesium terrain 同时渲染，但没有明确可测试的组合规则。

代码侧高风险点：

- RasterTileLayer 只有基础 mip level，未看到完整 mipmap 生成与各向异性采样闭环；倾斜视角会产生严重纹理 minification。
- Raster pipeline 使用 depthCompare=always 且不写深度；terrain 则依赖深度覆盖底图，组合结果对绘制顺序高度敏感。
- Camera25D、RasterTileLayer、CesiumTerrainLayer 分别使用相机相对世界像素、zoom 0 Mercator 像素、米制高度和当前纬度 ppm，契约散落在实现注释中。
- Geographic scheduler 使用固定 FOV 和经验半径，不是真正的 frustum/SSE 四叉树遍历。
- 平面 raster 与局部 terrain 并存时没有 stencil/mask 或明确的 coverage ownership，边界容易重叠、漏缝或闪烁。

结论：先把平面 2.5D 栅格链路单独修到正确，再打开 terrain；不要在两条链路叠加状态下继续猜测根因。

### P0-3：StrictMode 下 ready 回调与销毁发生竞态（本次已修复）

控制台可复现：

GeoForgeError: Map2D 已销毁

调用链来自 App 中 map.ready().then 后继续 wireEvents，而 React StrictMode 已经执行过一次 effect cleanup 并销毁旧实例。

相关问题：

- Map25D 构造函数自身也调用 ready().then 安装交互，没有取消标记。
- bootMap2D、bootMap25D、bootGlobe 都有独立 timer 和 ready continuation，取消协议不统一。
- Map2D 主动 destroy GPUDevice 后，device.lost 回调仍以 error 记录“Device was destroyed”，会把正常清理误报为运行故障。

本次修复：

- 三个 App boot 函数都为 ready continuation 和最短 loading timer 增加 cancelled gate。
- Map25D 自身的 ready continuation 在 remove 后不再安装交互。
- Map2D 对 reason=destroyed、正在 remove 和已经 destroyed 的 device lost 静默处理。
- StrictMode 默认启动和 2.5D → Globe 切换复测后控制台无 error/warn。

验收：

- StrictMode 保持开启。
- 连续快速切换 2D → 2.5D → Globe → 2D 50 次，无已销毁访问、无监听泄漏、无未处理 Promise。
- 主动销毁设备不记 error；非预期 device lost 才记 error。

### P0-4：Camera3D 公开姿态与初始化参数不一致（本次已修复）

根应用传入：

- bearing = 0°
- pitch = -90°

运行后状态栏报告约：

- bearing = 135°
- pitch = 0°

源码证据：

- getOrientation 和 CameraState 构建使用 asin(-dot(direction, normalUp)) - π/2。
- 对 nadir 视线，direction = -normalUp，公式结果为 0，而公开文档约定 nadir 应为 -π/2。
- nadir 时水平投影长度接近 0，但 bearing 仍对两个浮点噪声分量做 atan2，因此可返回任意角。
- _initFromGeodetic 的 bearing 分支调用会同时旋转 position 的 _applyRotate；heading 本应只改变姿态，不应把相机位置绕地心搬走。

本次修复：

- pitch 改为 direction 与局部地表法线点积的 asin，语义固定为 nadir=-90°、horizon=0°。
- nadir/zenith 时保存并返回最后一个有效 bearing，不再对浮点噪声做 atan2。
- 初始化 pitch、初始化 bearing 和 setOrientation 都改用只旋转 direction/up/right 的 look primitive，不再移动 position。
- 新增 3 项回归测试，覆盖 nadir、构造姿态不移动位置、setOrientation 与 CameraState 一致性。
- 浏览器状态栏从修复前的 P≈0° / B≈135° 恢复为 P=-90° / B=0°。

验收：

- 初始化、setOrientation、jumpTo、flyTo 后 getOrientation 与输入语义一致。
- nadir 时保留上一次有效 bearing，或按明确规则返回 0，不允许随机角。
- setOrientation 不改变 ECEF position 和 geodetic position。
- project/unproject 与屏幕中心拾取能在多个纬度、多个姿态下往返。

### P0-5：架构文档和运行路径不一致

目前存在以下并行实现：

1. Camera3D：
   - packages/camera-3d
   - packages/runtime/camera-3d

2. Globe：
   - packages/globe/GlobeRenderer，GPU encode 仍明确标为 stub
   - packages/preset-3d/globe-*，这是当前真正工作的 GPU 渲染路径

3. Terrain：
   - packages/layer-terrain，encode 仍为 MVP stub
   - packages/layer-cesium-terrain，当前 2.5D quantized-mesh 路径
   - packages/layer-terrain-drape，另一条网格地形路径
   - packages/preset-3d/globe-terrain，3D 专用未闭环路径

4. Camera25D 状态：
   - Map2D 保存 center/zoom/bearing/pitch 作为权威状态
   - Camera25D 每帧 jumpTo 同步，只负责矩阵

这会导致修复容易落到非主路径，并产生“文档显示已完成、示例仍异常”的错觉。

## 5. 重构目标架构

不进行全量重写，采用主路径收敛：

### 5.1 相机

- camera-2d、camera-25d、camera-3d 成为唯一相机实现。
- runtime 中旧相机实现先标 deprecated，完成兼容适配后删除。
- CameraState 只保存一种明确的标量语义：
  - center：经纬度，单位 degree
  - bearing/pitch/roll：内部 radian，对外 API 明确 degree 或 radian，不混用
  - position：必须带坐标空间标识，不能让 Mercator meter、world pixel、ECEF 共用同一无标签字段
- 所有矩阵统一 column-major、VP=P×V、WebGPU NDC z=[0,1]。

### 5.2 渲染职责

- preset-2d / preset-25d / preset-3d 只负责组装、生命周期和公共 facade。
- GPU pipeline、shader、tile mesh、culling 必须下沉到可复用包。
- packages/globe 成为 3D Globe 唯一渲染实现；preset-3d 不再长期持有一整套 globe-gpu/globe-render/globe-tiles。
- 依赖边界脚本必须零违规，或先修改正式架构规则并记录允许的 composition dependency，不能长期带 18 个已知失败。

### 5.3 地形

把“数据解码”和“视图渲染”拆开：

- terrain-core：
  - quantized-mesh provider/decoder
  - heightfield/normal/skirt
  - availability 与 tile metadata
  - CPU cache entry
- terrain-25d：
  - Mercator 投影
  - raster drape
  - 2.5D frustum/SSE 调度
- terrain-3d：
  - ECEF/ellipsoid 投影
  - horizon/frustum culling
  - RTE vertex encoding
- 公共 GPU 纹理和 buffer 的所有权必须由一个资源管理器控制，图层间不直接借用可被对方驱逐的 GPUTexture。

## 6. 实施顺序

### Phase 0：恢复工程门禁与可观测性（2–3 天）

目标：每一次后续修复都能被可靠验证。

- 修复 Vite / React plugin 版本组合，使 npm ci 成功。
- 修复 App 和 Map25D 的 ready/cancel 生命周期。
- 区分主动 GPU destroy 与意外 device lost。
- 增加稳定的本地 fixture：
  - 一组 OSM/NaturalEarth 栅格瓦片
  - 至少 4 个相邻 quantized-mesh 瓦片及 layer.json
- 增加 debug overlay：
  - camera space/zoom/pitch/bearing
  - near/far
  - tile z/x/y、父瓦片替代来源
  - terrain/raster draw count
  - device lost reason

退出条件：

- 四个 npm 门禁可复现。
- StrictMode 模式切换无错误。
- 不依赖在线服务也能复现 2.5D 和 3D。

### Phase 1：锁定相机与坐标契约（4–6 天）

目标：先证明数学正确，再看画面。

- 新增 CoordinateSpace 类型或 branded type，至少区分：
  - LngLatDegrees
  - MercatorMeters
  - WorldPixelsAtZoom
  - CameraRelativePixels
  - ECEF64
  - RTE32
- Camera25D 测试：
  - pitch 0/45/80°
  - bearing 0/90/180/270°
  - zoom 0/10/20
  - project/unproject 往返
  - near/far 与 ground coverage
- Camera3D 测试：
  - nadir/horizon/tilt
  - heading 不改变 position
  - 多纬度 ENU
  - ECEF/geodetic 往返
  - 屏幕中心射线与椭球交点
- 删除或适配 runtime 中重复 Camera3D。

退出条件：

- 相机纯数学测试覆盖主语义。
- 公开 getter 与输入一致。
- 所有渲染层消费同一 CameraState 契约。

### Phase 2：先修纯平面 2.5D，再接地形（1–2 周）

步骤 A：暂时在默认回归场景关闭 Cesium terrain，只验证 RasterTileLayer。

- 用 frustum 与地面 z=0 的交点计算真实覆盖范围。
- 为倾斜瓦片生成 mip chain，启用可用的 anisotropic filtering。
- 统一父瓦片替代和 fade，禁止同一区域父子同时以不透明方式绘制。
- 明确 reversed-Z：
  - clear depth
  - raster depth compare/write
  - terrain depth compare/write
  - overlay depth bias
- 增加 pitch 0/30/45/60/75/80° 截图回归。

步骤 B：接入 terrain。

- 使用本地 QM fixture 验证 decoder：
  - u/v/h 范围
  - high-water-mark 索引不越界
  - 四边 edge index 与裙边连续
  - 相邻瓦片边界高度误差
- terrain coverage 使用 frustum/SSE，不再只用固定半径。
- 对局部 terrain 生成明确 coverage mask；mask 内由 terrain 负责，mask 外由 raster 负责。
- 验证 exaggerated height、海拔负值、父瓦片 walk-up 和 LOD 切换。

退出条件：

- 默认 2.5D 无幕墙、无明显接缝、无近景超模糊。
- 离线 fixture 与在线服务表现一致。
- 15 分钟连续倾斜/缩放无 GPU validation error。

### Phase 3：收敛 3D Globe 主路径（1–2 周）

- 先修 Camera3D orientation 和 interaction primitive。
- 明确 packages/globe 为主实现，迁移 preset-3d 中 GPU 细节。
- GlobeRenderer 中的 encode stub 要么实现，要么删除，不能与真实路径并存。
- 使用离线全球低级别瓦片验证：
  - 日期变更线
  - 南北极
  - horizon/frustum
  - 父瓦片替代
  - atmosphere 与椭球对齐
- 把 addGeoJSON、add3DTileset、queryRenderedFeatures 从“记录配置/返回空”升级为真实实现，或从稳定 API 中移出并明确 experimental。
- 3D terrain 复用 terrain-core，但独立实现 ECEF/RTE 渲染，不能直接复用 2.5D Mercator 顶点。

退出条件：

- 相机状态、画面和 picking 三者一致。
- Globe 在高空、近地、极区和日期变更线都有自动回归。
- preset-3d 只做 facade，不再是 6,000 多行渲染实现的实际归宿。

### Phase 4：架构清理与发布门禁（约 1 周）

- 依赖边界零失败。
- 删除重复和未使用主路径。
- 为 experimental/stable API 建立显式清单。
- README 改为当前真实能力，去掉尚未闭环的“完成”表述。
- CI 固定运行：
  - npm ci
  - typecheck/build
  - unit
  - dependency check
  - bundle check
  - browser smoke
  - WebGPU visual regression

## 7. 优先级问题清单

| ID | 优先级 | 问题 | 建议动作 |
|---|---|---|---|
| ENV-01 | P0 | npm ci 失败 | 已修复：升级 React Vite plugin 并重建锁文件 |
| LIFE-01 | P0 | ready 回调访问已销毁 Map25D | 已修复第一阶段：cancel gate + 正常 device destroy 静默 |
| CAM3-01 | P0 | nadir pitch 返回 0 | 已修复：公式与黄金测试 |
| CAM3-02 | P0 | nadir bearing 随浮点噪声跳变 | 已修复：水平分量 epsilon + 保存最后有效 bearing |
| CAM3-03 | P0 | bearing 初始化可能旋转 position | 已修复：姿态 look 与 orbit rotate 分离 |
| 25D-01 | P0 | 默认 2.5D 严重拉伸/幕墙 | 分离 raster-only 与 terrain 场景定位 |
| 25D-02 | P0 | 缺少 mipmap/anisotropic 闭环 | 增加纹理 LOD 与倾斜采样 |
| DEPTH-01 | P0 | raster/terrain 深度所有权不明确 | 固化 reversed-Z 与各 layer depth contract |
| TEST-01 | P0 | 相机/渲染无回归测试 | 先建测试再继续叠功能 |
| ARCH-01 | P1 | 两套 Camera3D | 选 packages/camera-3d 为主路径并迁移 |
| ARCH-02 | P1 | GlobeRenderer stub 与真实 preset 路径并存 | 下沉真实渲染，删除 stub 路径 |
| ARCH-03 | P1 | 多套 terrain | 抽 terrain-core，分 25D/3D renderer |
| DEP-01 | P1 | 18 个跨层依赖违规 | 修架构或修规则，最终必须零失败 |
| API-01 | P1 | 3D API 多项返回空/仅记录 | 降级 experimental 或完成闭环 |
| PERF-01 | P2 | 固定半径 tile scheduler | 改为 frustum + SSE + cache-aware priority |

## 8. 推荐的首批提交

为了降低回归范围，建议按以下独立提交推进：

1. chore(deps): restore clean npm ci
2. fix(lifecycle): cancel stale engine ready continuations
3. test(camera-3d): lock orientation semantics and nadir behavior
4. fix(camera-3d): separate look rotation from orbit rotation
5. test(camera-25d): add matrix and project/unproject golden cases
6. test(terrain-qm): add local layer.json and adjacent tile fixtures
7. fix(raster-25d): mipmaps, sampler and raster-only visual baseline
8. fix(depth): define raster/terrain reversed-Z contract
9. refactor(terrain): extract provider/decoder/cache core
10. refactor(globe): move active render path out of preset-3d

每个提交都应能独立构建、独立回滚，并附带对应回归测试或截图基线。

## 9. Definition of Done

“3D / 2.5D 已修好”至少需要满足：

- 干净环境标准安装成功。
- 2D、2.5D、Globe 连续切换无生命周期错误。
- Camera25D/Camera3D 的公开状态与实际矩阵一致。
- 2.5D 在 0–80° pitch 下无明显幕墙、接缝、空洞和不可接受的纹理模糊。
- 3D 在全球、近地、极区和日期变更线场景无椭球变形、黑洞和瓦片翻转。
- terrain LOD 切换无父子重叠闪烁，边界有连续性检查。
- 所有上述场景都有可离线重复的 fixture 和自动测试。
- dependency check、bundle check、unit、browser smoke、visual regression 全部通过。
- 旧实现已删除或明确 deprecated，不再存在两个“都像主路径”的实现。

## 10. 本次审计的直接证据

- Git：本地 master 已快进到 origin/master 的 4a4597b。
- npm test：18 files / 207 tests passed。
- npm run build：通过。
- npm run check:bundle：通过，完整 JS gzip 143.6 KiB。
- npm run check:deps：失败，18 个 layer violation。
- npm ci：通过。
- npm audit --omit=dev：0 个生产依赖漏洞；Recharts 间接依赖的 lodash 已由 4.17.23 更新到 4.18.1。
- 浏览器：
  - 2D 北京 zoom 10 正常显示，约 9 个可见栅格瓦片。
  - 2.5D 北京 zoom 10 / pitch 45° 显示严重异常，约 80 个可见栅格瓦片。
  - 修复前 2.5D 控制台出现 Map2D 已销毁；修复后 StrictMode 启动和模式切换无 error/warn。
  - Globe 能显示球体和大气；修复后公开姿态与初始化参数一致。

这份文档应作为后续实施的入口；旧的专项问题文档可以保留作为背景资料，但任务状态以本文件和自动化门禁为准。
