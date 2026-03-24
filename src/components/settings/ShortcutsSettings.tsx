/** One row in the shortcuts reference table. */
type ShortcutRow = { key: string; action: string };

const ROWS: ShortcutRow[] = [
  { key: 'Esc', action: '取消当前工具/关闭面板' },
  { key: 'Delete', action: '删除选中要素' },
  { key: 'Ctrl+Z', action: '撤销' },
  { key: 'Ctrl+Shift+Z', action: '重做' },
  { key: 'Ctrl+S', action: '导出' },
  { key: 'Space', action: '切换到平移模式' },
  { key: 'D', action: '切换绘制工具' },
  { key: 'M', action: '切换测量工具' },
  { key: 'S', action: '切换选择工具' },
  { key: '[', action: '折叠左侧面板' },
  { key: ']', action: '折叠右侧面板' },
  { key: '+/-', action: '缩放' },
  { key: 'F11', action: '全屏' },
];

/**
 * Read-only keyboard shortcut reference table.
 */
export function ShortcutsSettings() {
  return (
    <div className="overflow-auto text-sm">
      <table className="w-full border-collapse text-left">
        <thead>
          <tr className="border-b border-[var(--border)] text-[var(--text-secondary)]">
            <th className="py-2 pr-4 font-medium">Key</th>
            <th className="py-2 font-medium">Action</th>
          </tr>
        </thead>
        <tbody>
          {ROWS.map((row) => (
            <tr key={row.key} className="border-b border-[var(--border)]">
              <td className="py-2 pr-4 font-mono text-[var(--accent)]">{row.key}</td>
              <td className="py-2 text-[var(--text-primary)]">{row.action}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
