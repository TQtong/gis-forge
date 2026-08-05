# GeoForge 行政区范围选择器设计文档

> 文档版本：v1.0
>
> 设计基线：2026-08-05
>
> 实施状态：设计完成，功能待实现

## 1. 目标

在 GeoForge 当前 React、TypeScript 与纯 WebGPU GIS 引擎基础上，增加一个类似 DataV 范围选择器的行政区边界下载工具。首期只交付“行政区范围选择器”，不展示工具市场，也不同时建设其他 GIS 工具。

范围选择器必须同时支持：

- 按中文名称或 adcode 搜索行政区；
- 在地图上点击选择、再次点击下钻；
- 通过面包屑返回上级；
- 选择单个行政区，或聚合其直接/指定层级后代；
- 将 DataV 面 GeoJSON 在点、线、面三种边界 Feature 之间转换并导出；
- 使用已知 WGS84 控制点，对原始边界和转换后边界做可视化与数值校验。

## 2. 文档导航

| 文档 | 说明 |
| --- | --- |
| [产品与交互设计](./GeoForge_AreaSelector_Product_Design.md) | 页面布局、选择流程、三种 Feature、状态与错误反馈 |
| [数据与转换设计](./GeoForge_AreaSelector_Data_Design.md) | Provider、行政层级、DataV 适配、WGS84 标准化、缓存与导出 |
| [WebGPU 渲染设计](./GeoForge_AreaSelector_Rendering_Design.md) | GeoJSON 点线面渲染、拾取、资源和性能策略 |
| [控制点校验设计](./GeoForge_AreaSelector_Validation_Design.md) | 转换前后叠加、点面关系、最近边界距离与判定规则 |
| [实施与测试计划](./GeoForge_AreaSelector_Implementation_Plan.md) | 接口、Worker 协议、实施阶段、测试与验收标准 |

## 3. 统一术语

| 术语 | 定义 |
| --- | --- |
| 范围 | 当前选中的一个行政区，或按目标层级聚合得到的一组行政区 |
| 原始边界 | Provider 返回、尚未转换到 WGS84 的 Polygon/MultiPolygon 数据 |
| 标准化边界 | 完成结构校验、坐标转换和属性补全的 WGS84 Polygon/MultiPolygon |
| 点 Feature | 行政区边界上的有序顶点；每个 Point 都携带所属面、部件、环和顶点序号 |
| 线 Feature | 行政区面的外环或孔洞环；每个环输出一个 LineString Feature |
| 面 Feature | 保留行政区 Polygon/MultiPolygon 及孔洞拓扑 |
| 拓扑元数据 | 点线面互转时保留的 `sourceFeatureId/partIndex/ringIndex/ringRole/vertexIndex/closed` 等字段 |
| 控制点 | 用户确认坐标正确、坐标系为 WGS84 的点位，用于验证边界转换结果 |
| 聚合 | 将目标层级的多个行政区 Feature 放入同一个 FeatureCollection；不执行几何 dissolve |

“点、线、面”是边界数据的三种 **Feature 几何形态**，不是三种文件格式，也不是行政区中心点。首期下载格式固定为 RFC 7946 GeoJSON，坐标顺序固定为 `[longitude, latitude]`。

## 4. 已锁定决策

1. 首个数据适配器使用 DataV `areas_v3`，业务层只依赖 `AdministrativeAreaProvider`。
2. DataV 输入的权威几何固定为 Polygon/MultiPolygon；行政区中心点只用于地图定位，绝不作为“面转点”的结果。
3. 几何转换支持六个方向：面→线、线→点、面→点、点→线、线→面、点→面；面→点与点→面分别复用两步转换，保证规则一致。
4. 反向转换只对带完整拓扑元数据的点/线保证无歧义恢复；缺少顺序、分组或孔洞角色的数据必须报错，不能猜测连线或造面。
5. 首期层级为国家、省、市、区县，不支持乡镇街道。
6. 父子关系以 Provider 目录为准，不通过 adcode 截位推导。
7. 地图预览、空间校验和最终下载共用同一个 `NormalizedAdministrativeDataset`。
8. 原始数据按 Provider 声明的坐标系解释；DataV 适配器将边界声明为 GCJ-02，并统一转换到 WGS84。
9. 省可导出自身、市级集合或区县集合；市可导出自身或区县集合；区县只导出自身。全国首期只允许自身或省级集合，禁止直接聚合全国区县。
10. 任一子级缺失、请求失败或坐标/几何转换失败时，聚合结果标记为不完整并禁止下载。
11. Map2D 是当前工具唯一视图；引擎能力保持兼容 Map25D，不扩展 Globe3D。
12. WebGPU 不可用时关闭地图与叠加预览，但搜索、数据处理、校验数值和下载仍可使用。
13. 校验结果用于发现坐标系、拓扑和空间一致性问题，不构成测绘级精度认证。

## 5. 工具集合的扩展边界

首期页面不出现工具中心，但保留轻量工具描述接口，避免以后把路由、权限和导航写死在范围选择器中：

```ts
export interface GisToolDefinition {
  id: string;
  title: string;
  description: string;
  route: string;
  availability: 'enabled' | 'disabled' | 'experimental';
}
```

首期注册表只包含 `area-selector`。数据 Provider、Worker 任务和 GeoJSON Layer 是可复用基础能力；范围选择状态、控制点表单和导出面板属于该工具自身，不能下沉到引擎核心。

## 6. 明确不做

- 多选行政区、跨区域合并、批量任务和 ZIP 下载；
- 对缺少拓扑元数据的任意散点自动猜测连接顺序、凹包或行政区面；
- KML、TopoJSON、Shapefile、SVG 等其他导出格式；
- 乡镇街道数据、全国区县一次性下载；
- 文本标注系统、三维拉伸、3D 地球和测绘认证；
- 绕过 WebGPU 使用 Canvas 2D 或 SVG 绘制地图边界。
