/**
 * @file FeatureTree.tsx
 * @description 左侧面板的功能树导航组件。
 * 按 GeoForge 七层架构组织，支持搜索过滤、展开/折叠、点击切换场景。
 * 无 Props，状态通过 Zustand stores 读写。
 *
 * 视觉规范：
 * - 分组标题：uppercase、muted color、小字号
 * - 文件夹节点：ChevronRight 箭头，展开时旋转 90°
 * - 叶子节点：hover 高亮、选中态带左侧竖线指示器
 * - 每层缩进 pl-4（16px）
 *
 * @stability experimental
 */

import { useState, useMemo, useCallback } from 'react';
import { ChevronRight, Search, FolderOpen, Folder, FileCode2 } from 'lucide-react';
import { useSceneStore } from '../stores/sceneStore';
import { featureTreeData, type TreeNode } from '../data/featureTreeData';

// ═══════════════════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════════════════

/** 树节点图标尺寸（px） */
const NODE_ICON_SIZE = 14;

/** 展开箭头图标尺寸（px） */
const CHEVRON_ICON_SIZE = 14;

/** 搜索图标尺寸（px） */
const SEARCH_ICON_SIZE = 16;

// ═══════════════════════════════════════════════════════════
// 辅助函数
// ═══════════════════════════════════════════════════════════

/**
 * 递归过滤树节点，保留匹配搜索词的节点及其祖先路径。
 * 搜索逻辑：如果一个节点的 label 包含搜索词（不区分大小写），或者它的任意后代匹配，则保留该节点。
 *
 * @param nodes - 待过滤的树节点数组
 * @param query - 搜索关键词（已转小写）
 * @returns 过滤后的新树节点数组（不修改原数组）
 *
 * @example
 * const filtered = filterTree(featureTreeData, 'vec');
 * // 返回包含 "vec2/vec3/vec4 运算验证" 及其所有祖先的树
 */
function filterTree(nodes: TreeNode[], query: string): TreeNode[] {
  // 空搜索词不过滤，返回原数组
  if (!query) {
    return nodes;
  }

  const result: TreeNode[] = [];

  for (const node of nodes) {
    // 检查当前节点 label 是否匹配
    const selfMatch = node.label.toLowerCase().includes(query);

    if (node.children) {
      // 文件夹节点：递归过滤子节点
      const filteredChildren = filterTree(node.children, query);

      // 如果自身匹配或有后代匹配，保留该文件夹
      if (selfMatch || filteredChildren.length > 0) {
        result.push({
          ...node,
          // 自身匹配时保留所有子节点，后代匹配时只保留匹配分支
          children: selfMatch ? node.children : filteredChildren,
        });
      }
    } else if (selfMatch) {
      // 叶子节点：仅当自身匹配时保留
      result.push(node);
    }
  }

  return result;
}

/**
 * 收集一棵子树中所有节点的 ID（用于搜索时自动展开所有匹配路径）。
 *
 * @param nodes - 树节点数组
 * @returns 包含所有节点 ID 的 Set
 *
 * @example
 * const allIds = collectAllIds(filteredTree);
 * setExpandedNodes(allIds);
 */
function collectAllIds(nodes: TreeNode[]): Set<string> {
  const ids = new Set<string>();

  for (const node of nodes) {
    ids.add(node.id);

    // 递归收集子节点 ID
    if (node.children) {
      for (const childId of collectAllIds(node.children)) {
        ids.add(childId);
      }
    }
  }

  return ids;
}

// ═══════════════════════════════════════════════════════════
// 子组件：树节点渲染
// ═══════════════════════════════════════════════════════════

/**
 * 树节点组件的 Props。
 */
interface TreeNodeItemProps {
  /** 当前节点数据 */
  node: TreeNode;

  /** 当前缩进层级（0 = 顶层） */
  level: number;

  /** 已展开节点的 ID 集合 */
  expandedNodes: Set<string>;

  /** 切换节点展开/折叠的回调 */
  onToggleExpand: (nodeId: string) => void;

  /** 当前选中的场景 ID */
  activeSceneId: string;

  /** 点击叶子节点选中场景的回调 */
  onSelectScene: (sceneId: string) => void;
}

/**
 * 单个树节点的渲染组件（递归）。
 * 文件夹节点显示展开箭头 + 文件夹图标 + label，点击展开/折叠子节点。
 * 叶子节点显示文件图标 + label，点击切换到对应场景。
 *
 * @param props - TreeNodeItemProps
 * @returns 树节点 JSX（可能包含递归子节点）
 *
 * @example
 * <TreeNodeItem
 *   node={node}
 *   level={0}
 *   expandedNodes={expandedSet}
 *   onToggleExpand={handleToggle}
 *   activeSceneId="l0-math-vec"
 *   onSelectScene={handleSelect}
 * />
 */
function TreeNodeItem({
  node,
  level,
  expandedNodes,
  onToggleExpand,
  activeSceneId,
  onSelectScene,
}: TreeNodeItemProps): JSX.Element {
  /** 当前节点是否是文件夹（有 children） */
  const isFolder = Boolean(node.children);

  /** 当前文件夹是否已展开 */
  const isExpanded = expandedNodes.has(node.id);

  /** 当前叶子是否是选中状态 */
  const isSelected = !isFolder && node.sceneId === activeSceneId;

  /** 是否为顶层分组节点（level 0，有 children） */
  const isTopLevelGroup = level === 0 && isFolder;

  /**
   * 处理节点点击。
   * 文件夹 → 展开/折叠；叶子 → 选中场景 + 更新 URL hash。
   */
  const handleClick = (): void => {
    if (isFolder) {
      onToggleExpand(node.id);
    } else if (node.sceneId) {
      onSelectScene(node.sceneId);
      // 同步 URL hash，便于分享直链
      window.location.hash = `/${node.sceneId}`;
    }
  };

  return (
    <div>
      {/* ─── 节点行 ─── */}
      <div
        role={isFolder ? 'treeitem' : 'option'}
        aria-expanded={isFolder ? isExpanded : undefined}
        aria-selected={isSelected}
        onClick={handleClick}
        className="flex items-center cursor-pointer select-none transition-colors duration-100"
        style={{
          // 缩进：每层 16px，顶层分组无额外缩进
          paddingLeft: `${level * 16 + 12}px`,
          paddingRight: '12px',
          height: isTopLevelGroup ? '36px' : '30px',
          // 选中态：高亮背景 + 左侧竖线指示器
          background: isSelected ? 'var(--highlight)' : 'transparent',
          color: isSelected
            ? 'var(--accent)'
            : isTopLevelGroup
              ? 'var(--text-muted)'
              : 'var(--text-primary)',
          borderLeft: isSelected ? '2px solid var(--accent)' : '2px solid transparent',
          // 顶层分组标题使用更小字号 + 大写
          fontSize: isTopLevelGroup ? '11px' : '13px',
          fontWeight: isTopLevelGroup ? 600 : 400,
          letterSpacing: isTopLevelGroup ? '0.05em' : 'normal',
          textTransform: isTopLevelGroup ? 'uppercase' : 'none',
        }}
        onMouseEnter={(e) => {
          // 非选中态才显示 hover 背景
          if (!isSelected) {
            (e.currentTarget as HTMLElement).style.background =
              'var(--bg-panel-hover)';
          }
        }}
        onMouseLeave={(e) => {
          if (!isSelected) {
            (e.currentTarget as HTMLElement).style.background = 'transparent';
          }
        }}
      >
        {/* 展开/折叠箭头（仅文件夹节点显示） */}
        {isFolder ? (
          <ChevronRight
            size={CHEVRON_ICON_SIZE}
            className="shrink-0 transition-transform duration-200"
            style={{
              transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
              marginRight: '4px',
              color: isTopLevelGroup ? 'var(--text-muted)' : 'var(--text-secondary)',
            }}
          />
        ) : (
          // 叶子节点用文件图标，保持对齐
          <FileCode2
            size={NODE_ICON_SIZE}
            className="shrink-0"
            style={{
              marginRight: '6px',
              color: isSelected ? 'var(--accent)' : 'var(--text-secondary)',
            }}
          />
        )}

        {/* 文件夹图标（仅非顶层文件夹显示） */}
        {isFolder && !isTopLevelGroup && (
          isExpanded ? (
            <FolderOpen
              size={NODE_ICON_SIZE}
              className="shrink-0"
              style={{ marginRight: '6px', color: 'var(--text-secondary)' }}
            />
          ) : (
            <Folder
              size={NODE_ICON_SIZE}
              className="shrink-0"
              style={{ marginRight: '6px', color: 'var(--text-secondary)' }}
            />
          )
        )}

        {/* 节点标签文字 */}
        <span className="truncate">{node.label}</span>
      </div>

      {/* ─── 子节点列表（仅展开时渲染，避免不必要的 DOM） ─── */}
      {isFolder && isExpanded && node.children && (
        <div role="group">
          {node.children.map((child) => (
            <TreeNodeItem
              key={child.id}
              node={child}
              level={level + 1}
              expandedNodes={expandedNodes}
              onToggleExpand={onToggleExpand}
              activeSceneId={activeSceneId}
              onSelectScene={onSelectScene}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// 主组件
// ═══════════════════════════════════════════════════════════

/**
 * GeoForge DevPlayground 左侧功能树导航组件。
 *
 * 功能：
 * 1. 搜索框实时过滤树节点（按 label 模糊匹配，搜索时自动展开匹配路径）
 * 2. 文件夹节点点击展开/折叠
 * 3. 叶子节点点击切换场景（sceneStore.setActiveScene + URL hash）
 * 4. 选中态高亮 + 左侧竖线指示器
 *
 * @returns FeatureTree JSX
 *
 * @example
 * <FeatureTree />
 */
export function FeatureTree(): JSX.Element {
  // ─── 本地状态 ───

  /** 搜索关键词 */
  const [searchQuery, setSearchQuery] = useState<string>('');

  /** 已展开节点 ID 集合 */
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(
    // 默认展开所有顶层分组
    () => new Set(featureTreeData.map((node) => node.id)),
  );

  // ─── Store 订阅 ───

  /** 当前激活的场景 ID */
  const activeSceneId = useSceneStore((s) => s.activeSceneId);

  /** 切换场景 action */
  const setActiveScene = useSceneStore((s) => s.setActiveScene);

  // ─── 派生数据 ───

  /** 搜索词（小写化，用于不区分大小写匹配） */
  const normalizedQuery = searchQuery.trim().toLowerCase();

  /**
   * 过滤后的树数据。
   * 当有搜索词时，只保留匹配节点及其祖先链。
   * 使用 useMemo 避免每次渲染都重新过滤。
   */
  const filteredTree = useMemo(
    () => filterTree(featureTreeData, normalizedQuery),
    [normalizedQuery],
  );

  /**
   * 搜索模式下，自动展开所有过滤后的节点路径。
   * 无搜索时使用用户手动控制的 expandedNodes。
   */
  const effectiveExpandedNodes = useMemo(() => {
    if (normalizedQuery) {
      // 搜索模式：展开所有匹配路径
      return collectAllIds(filteredTree);
    }
    return expandedNodes;
  }, [normalizedQuery, filteredTree, expandedNodes]);

  // ─── 事件处理 ───

  /**
   * 切换指定节点的展开/折叠状态。
   * 使用函数式 setState 确保基于最新状态。
   */
  const handleToggleExpand = useCallback((nodeId: string): void => {
    setExpandedNodes((prev) => {
      const next = new Set(prev);

      if (next.has(nodeId)) {
        next.delete(nodeId);
      } else {
        next.add(nodeId);
      }

      return next;
    });
  }, []);

  /**
   * 选中叶子节点对应的场景。
   * 写入 sceneStore，URL hash 在 TreeNodeItem 内更新。
   */
  const handleSelectScene = useCallback(
    (sceneId: string): void => {
      setActiveScene(sceneId);
    },
    [setActiveScene],
  );

  /**
   * 搜索框输入变化处理。
   */
  const handleSearchChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>): void => {
      setSearchQuery(e.target.value);
    },
    [],
  );

  return (
    <div
      className="h-full flex flex-col overflow-hidden"
      style={{ background: 'var(--bg-panel)' }}
      role="tree"
      aria-label="GeoForge 功能树导航"
    >
      {/* ─── 搜索框（sticky 固定在顶部） ─── */}
      <div
        className="sticky top-0 z-10 p-3 shrink-0"
        style={{
          background: 'var(--bg-panel)',
          borderBottom: '1px solid var(--border)',
        }}
      >
        <div
          className="flex items-center gap-2 px-2.5 rounded-md h-8"
          style={{
            background: 'var(--bg-input)',
            border: '1px solid var(--border)',
          }}
        >
          {/* 搜索图标 */}
          <Search
            size={SEARCH_ICON_SIZE}
            className="shrink-0"
            style={{ color: 'var(--text-muted)' }}
          />

          {/* 搜索输入框 */}
          <input
            type="text"
            placeholder="搜索功能..."
            value={searchQuery}
            onChange={handleSearchChange}
            className="flex-1 bg-transparent border-none outline-none text-sm"
            style={{
              color: 'var(--text-primary)',
            }}
            aria-label="搜索功能树"
          />
        </div>
      </div>

      {/* ─── 树节点列表（可滚动） ─── */}
      <div className="flex-1 overflow-y-auto py-1">
        {filteredTree.length > 0 ? (
          filteredTree.map((node) => (
            <TreeNodeItem
              key={node.id}
              node={node}
              level={0}
              expandedNodes={effectiveExpandedNodes}
              onToggleExpand={handleToggleExpand}
              activeSceneId={activeSceneId}
              onSelectScene={handleSelectScene}
            />
          ))
        ) : (
          // 搜索无结果时的空状态提示
          <div
            className="flex flex-col items-center justify-center py-12 px-4 text-center"
            style={{ color: 'var(--text-muted)' }}
          >
            <Search size={32} className="mb-3 opacity-40" />
            <p className="text-sm">没有匹配的功能项</p>
            <p className="text-xs mt-1 opacity-60">
              尝试其他关键词，如 "vec3"、"瓦片"、"shader"
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
