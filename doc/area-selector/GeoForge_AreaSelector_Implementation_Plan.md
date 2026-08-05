# GeoForge 行政区范围选择器：实施与测试计划

## 1. 实施原则

实施按“可替换数据层—可复用计算层—通用渲染层—工具 UI”推进。任何阶段都不能把 DataV URL、坐标转换或行政区特殊规则直接写入 React 组件。现有用户修改必须保留；每个阶段完成后运行相关单测和生产构建。

## 2. 建议模块边界

```text
src/
├── features/area-selector/       # 工具 UI、状态机、导出与校验编排
├── packages/core/                # 复用坐标、包含、测地与 GeoJSON 类型；仅补通用算法缺口
├── packages/runtime/             # 真实 WorkerPool 和行政区计算任务
├── packages/layer-geojson/       # 通用 WebGPU 点线面编码
├── packages/gpu/                 # 复用 L1/L2 buffer、pipeline、picking
└── packages/preset-2d/           # Map2D Source/Layer/异步拾取接入
```

工具集合只增加内部 `GisToolDefinition` 和首个 `area-selector` 注册项，不建设可见的工具市场。

## 3. 公共接口

数据层采用[数据设计](./GeoForge_AreaSelector_Data_Design.md)中的：

- `AdministrativeAreaProvider`；
- `AdministrativeAreaRecord` 与 `AdministrativeLevel`；
- `NormalizedAdministrativeDataset`；
- `BoundaryFeatureMode`；
- `BoundaryTopologyProperties`；
- `BoundaryGeometryConverter` 与 `GeometryConversionRequest/Result`；
- `AreaExportOptions/AreaExportResult`。

校验层采用[校验设计](./GeoForge_AreaSelector_Validation_Design.md)中的：

- `Wgs84ControlPoint`；
- `BoundaryPointMetrics`；
- `ValidationResult/ValidationStatus`。

服务层额外定义：

```ts
export interface PrepareAreaDatasetRequest {
  selectionAdcode: string;
  targetLevel: AdministrativeLevel;
  forceRefresh?: boolean;
  signal?: AbortSignal;
}

export interface AdministrativeAreaService {
  loadCatalog(signal?: AbortSignal): Promise<AdministrativeAreaRecord[]>;
  prepareDataset(request: PrepareAreaDatasetRequest): Promise<NormalizedAdministrativeDataset>;
  convertGeometry(
    request: GeometryConversionRequest,
    signal?: AbortSignal,
  ): Promise<GeometryConversionResult>;
  validateControlPoint(
    dataset: NormalizedAdministrativeDataset,
    point: Wgs84ControlPoint,
    signal?: AbortSignal,
  ): Promise<ValidationResult>;
  exportGeoJSON(
    dataset: NormalizedAdministrativeDataset,
    options: AreaExportOptions,
  ): Promise<AreaExportResult>;
}
```

## 4. Worker 协议

当前 `WorkerPool` 的优先级、取消、超时和统计接口继续保留，但执行体从 `setTimeout` 模拟改为真实 `Worker`。现有任务不改语义，新增通用任务键：

```ts
type AreaWorkerTaskType =
  | 'geojson-parse'
  | 'coordinates-transform'
  | 'administrative-aggregate'
  | 'boundary-geometry-convert'
  | 'boundary-topology-validate'
  | 'point-boundary-validate'
  | 'geojson-export-geometry';

interface WorkerRequest<T> {
  id: string;
  type: WorkerTaskType | AreaWorkerTaskType;
  payload: T;
  priority: number;
}

type WorkerResponse<T> =
  | { id: string; ok: true; result: T; durationMs: number }
  | { id: string; ok: false; error: SerializedGeoForgeError };
```

- 大坐标数组使用 Float64Array/Uint32Array 和 transferables；
- `boundary-geometry-convert` 的 payload 明确携带 `sourceMode/targetMode/topologyVersion`，六种方向使用同一任务入口；
- Worker 数默认 `clamp(hardwareConcurrency - 1, 2, 6)`；
- 交互校验优先级高于预取，当前选择高于后台缓存；
- AbortSignal 触发排队任务立即拒绝，并向运行 Worker 发送 cancel；不能安全中断的算法完成后丢弃结果；
- 单任务默认超时 30s，目录解析 10s；超时 Worker 重建一次，同一任务不无限重试；
- 结果必须带 request id，服务层用 selection generation 防止陈旧结果回写。

## 5. 结构化错误

```ts
type AreaSelectorErrorCode =
  | 'AREA_NETWORK_FAILED'
  | 'AREA_PROVIDER_UNSUPPORTED_RESPONSE'
  | 'AREA_CATALOG_INVALID'
  | 'AREA_BOUNDARY_NOT_FOUND'
  | 'AREA_GEOMETRY_INVALID'
  | 'AREA_TOPOLOGY_METADATA_MISSING'
  | 'AREA_GEOMETRY_CONVERSION_FAILED'
  | 'AREA_COORDINATE_INVALID'
  | 'AREA_DATASET_INCOMPLETE'
  | 'AREA_CACHE_CORRUPTED'
  | 'AREA_WORKER_TIMEOUT'
  | 'AREA_TASK_CANCELLED'
  | 'AREA_GPU_UNAVAILABLE'
  | 'AREA_EXPORT_BLOCKED'
  | 'AREA_VALIDATION_INDETERMINATE';
```

错误包含 `code/message/recoverable/details/cause`。UI 按 code 提供刷新、重试缺失项、清理单条缓存或继续无地图模式，不能依赖字符串匹配。

## 6. 分阶段实施

### 阶段一：Provider 与标准化数据

- 实现 Provider 接口、DataV 适配器、目录树和搜索索引；
- 完成原始结构校验、GCJ-02→WGS84 递归转换、完整性判断；
- 实现自身和按目标层级的 FeatureCollection 聚合；
- 实现面→线、线→点、面→点、点→线、线→面、点→面六种转换；
- 为环和顶点写入稳定 ID、部件/环/孔洞/顶点顺序元数据，并完成往返拓扑校验；
- 完成目标几何导出和稳定文件命名。

完成条件：不依赖地图即可搜索、选择、转换并下载三种 GeoJSON；工具生成的点/线可无歧义恢复为原面。

### 阶段二：真实 Worker 与缓存

- 将 WorkerPool 接入真实 Worker 入口，保留既有接口；
- 接入 transferable、优先级、取消、超时和崩溃恢复；
- 建立 64 MiB 内存 LRU 和 IndexedDB 四个 store（目录、原始边界、标准化面、派生几何）；
- 支持缓存版本、TTL、请求合并和损坏记录回源。

完成条件：大 GeoJSON 解析和计算不阻塞主线程，重复选择命中标准化缓存。

### 阶段三：通用 GeoJSON WebGPU 渲染

- 补齐 Point、LineString、Polygon/MultiPolygon GPU 编码，并批量渲染大量边界顶点和环；
- Map2D 接入真实 GeoJSON Source/Layer 更新；
- 接入 L1 Buffer/Uploader、L2 Pipeline/Shader/Picking；
- 完成异步 Color-ID 拾取、资源释放和 device lost 处理。

完成条件：点线面正确显示，孔洞正确，点击可返回稳定 adcode，无 GPU 资源持续增长。

### 阶段四：范围选择 UI

- 在现有 App 工作区接入唯一工具页面；
- 实现搜索、点击选择、二次点击下钻、面包屑返回；
- 实现目标粒度、面⇄线⇄点转换选择、转换统计和来源信息面板；
- 完成桌面布局与移动抽屉、加载/部分失败/无 GPU 状态。

完成条件：用户可完成从选择到下载的完整流程，且没有其他未实现工具入口干扰。

### 阶段五：控制点校验与收尾

- 实现控制点表单、原始/转换边界叠加和最近点连线；
- Worker 计算点面关系、测地距离、差值和状态；
- 导出可选携带校验摘要；失败状态下载前二次确认；
- 完成可访问性、性能统计、错误文案和文档同步。

完成条件：同一数据集的视觉叠加、校验指标和下载结果能够相互复核。

## 7. 测试矩阵

### 7.1 单元测试

- 目录：普通省、直辖市直接挂区县、港澳台、孤儿节点、父链循环、同名搜索；
- 坐标系转换：环坐标递归、境外不偏移、非法经纬度、不得重复转换；目录中心点不能混入边界 Point；
- 面→线：Polygon/MultiPolygon、多个 part、外环、孔洞、闭合坐标和稳定 LineString ID；
- 线→点：闭合末点去重、非闭合端点、重复坐标保序、稳定 Point ID；
- 点→线：分组、连续 vertexIndex、缺号/重复号、闭合恢复和元数据缺失错误；
- 线→面：外环/孔洞归属、单/多 part、开放线拒绝、孔洞无外环拒绝；
- 面→点与点→面：直接路径和链式路径结果一致；
- 往返：`polygon→line→polygon`、`polygon→point→polygon`、`line→point→line` 坐标和拓扑等价；
- 导出：点为边界顶点 Feature 集合、线为边界环 Feature 集合、面保留孔洞和 MultiPolygon；
- 校验：内部、外部、边界容差、孔洞、多个 Feature 最近距离、四种状态；
- 缓存：命中、TTL、版本变更、损坏单条记录、LRU 淘汰；
- Worker：优先级、transferable、取消、超时、崩溃重建、陈旧结果丢弃。

### 7.2 集成测试

- 国家→省、普通省→市/区县、市→区县、区县自身；
- 子级部分 404 或超时后禁止导出，重试缺失项后恢复；
- 搜索结果定位、地图点击、再次点击下钻、面包屑返回保持状态一致；
- Feature 形态切换不改变行政区选择、WGS84 坐标和校验面；Feature 数按“行政区面数/环数/顶点数”正确变化；
- 将工具导出的点或线送回转换服务可恢复原行政区面；删除一个顶点或拓扑字段后必须拒绝反向转换；
- 原始红色边界、转换绿色边界、控制点和两条最近点连线正确叠加；
- WebGPU 缺失或 device lost 时数值功能和下载继续可用。

### 7.3 渲染和性能测试

- GPU 截图/像素测试覆盖点、宽线/虚线、Polygon 孔洞和 MultiPolygon；
- 拾取测试覆盖重叠图层、3×3 容错、陈旧异步结果和图层销毁；
- 普通省级数据处理期间主线程长任务不得超过 50ms，目标单次工作片小于 8ms；
- 重复打开相同范围或目标形态必须命中缓存，不能重复坐标系转换、几何转换和三角剖分；
- 连续切换 100 次范围后 CPU、GPU 和事件监听器无单调增长。

## 8. 最终验收

- 当前仓库既有测试全部通过，新增测试全部通过；
- TypeScript 严格检查和生产构建通过；
- GeoJSON 可被标准 GIS 工具读取，坐标为 WGS84 `[经度, 纬度]`；
- 点是边界顶点、线是边界环、面是 Polygon/MultiPolygon，禁止再用行政区中心点替代面→点；
- 六种点线面转换均通过，工具生成数据的三条往返等式成立；
- 数据不完整时没有任何下载绕过路径；
- 控制点结果能复现，且明确展示数据来源、版本、容差和限制；
- 首期页面没有 KML、SVG、TopoJSON、批量 ZIP、乡镇或 3D 地球入口。
