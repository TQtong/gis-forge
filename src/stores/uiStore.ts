import { create } from 'zustand';
import type { AnalysisDialogId, CoordinateFormat, DistanceUnit } from '@/types';

/** UI theme: dark matches default `:root` CSS; light uses `[data-theme="light"]`. */
export type UITheme = 'dark' | 'light';

/** Right panel tab identifiers. */
export type RightPanelTab = 'attributes' | 'style' | 'legend';

/** Split-view comparison layout mode. */
export type SplitViewMode = 'side-by-side' | 'slider';

/** UI language for labels that support i18n. */
export type UILanguage = 'zh' | 'en';

/** Full-screen sheet opened from the mobile bottom tab bar (<768px). */
export type MobileOverlayTab = 'layers' | 'tools' | 'attributes' | 'settings';

/**
 * Global UI layout state (panels, theme, right tab).
 */
interface UIState {
  /** When true, left panel is collapsed. */
  leftPanelCollapsed: boolean;
  /** When true, right panel is collapsed. */
  rightPanelCollapsed: boolean;
  /** Active color theme key applied to `document.documentElement`. */
  theme: UITheme;
  /** Active tab in the right inspector panel. */
  rightPanelTab: RightPanelTab;
  /** When true, the add-layer modal is visible. */
  addLayerDialogOpen: boolean;
  /** Cursor / map coordinate readout format (DD, DMS, UTM, …). */
  coordinateFormat: CoordinateFormat;
  /** When set, the analysis dialog with this id should be shown (or null). */
  activeAnalysisDialog: AnalysisDialogId | null;
  /** When true, the settings modal is visible (independent from right panel). */
  settingsOpen: boolean;
  /** When true, map split / comparison chrome is shown. */
  splitViewEnabled: boolean;
  /** Comparison layout: side-by-side panes or sliding curtain. */
  splitViewMode: SplitViewMode;
  /** UI copy language (中文 / English). */
  language: UILanguage;
  /** Distance and area display units (metric / imperial / nautical). */
  distanceUnit: DistanceUnit;
  /** Base font size in pixels for shell UI (12–18). */
  fontSizePx: number;
  /** When true, the floating operation history panel is visible. */
  historyPanelOpen: boolean;
  /** When true, the MiniMap overview is shown on the map viewport. */
  showMiniMap: boolean;
  /** Full-screen mobile overlay; null when closed. */
  mobileOverlay: MobileOverlayTab | null;
  /** Opens or closes the add-layer dialog. */
  setAddLayerDialogOpen: (open: boolean) => void;
  /** Sets coordinate format for coordinate display and copy actions. */
  setCoordinateFormat: (format: CoordinateFormat) => void;
  /** Opens a specific analysis dialog or closes all when `null`. */
  setActiveAnalysisDialog: (id: AnalysisDialogId | null) => void;
  /** Opens or closes the settings dialog. */
  setSettingsOpen: (open: boolean) => void;
  /** Enables or disables split-view comparison mode. */
  setSplitViewEnabled: (enabled: boolean) => void;
  /** Sets split-view layout mode. */
  setSplitViewMode: (mode: SplitViewMode) => void;
  /** Sets UI language. */
  setLanguage: (language: UILanguage) => void;
  /** Sets distance / area unit preference. */
  setDistanceUnit: (unit: DistanceUnit) => void;
  /** Sets base UI font size in pixels. */
  setFontSizePx: (px: number) => void;
  /** Shows or hides the history panel. */
  setHistoryPanelOpen: (open: boolean) => void;
  /** Shows or hides the MiniMap eagle-eye control. */
  setShowMiniMap: (show: boolean) => void;
  /** Opens a mobile full-screen panel or closes it when `null`. */
  setMobileOverlay: (tab: MobileOverlayTab | null) => void;
  /** Toggles left panel collapsed state (keyboard `[`). */
  toggleLeftPanel: () => void;
  /** Toggles right panel collapsed state (keyboard `]`). */
  toggleRightPanel: () => void;
  /** Sets application theme. */
  setTheme: (theme: UITheme) => void;
  /** Toggles between dark and light theme. */
  toggleTheme: () => void;
  /** Sets active right panel tab. */
  setRightPanelTab: (tab: RightPanelTab) => void;
}

/**
 * Zustand store for shell UI: resizable panels, theme, inspector tab.
 */
export const useUIStore = create<UIState>((set) => ({
  leftPanelCollapsed: false,
  rightPanelCollapsed: false,
  theme: 'dark',
  rightPanelTab: 'attributes',
  addLayerDialogOpen: false,
  coordinateFormat: 'dd',
  activeAnalysisDialog: null,
  settingsOpen: false,
  splitViewEnabled: false,
  splitViewMode: 'side-by-side',
  language: 'zh',
  distanceUnit: 'metric',
  fontSizePx: 14,
  historyPanelOpen: false,
  showMiniMap: true,
  mobileOverlay: null,
  setAddLayerDialogOpen: (open) => set({ addLayerDialogOpen: open }),
  setCoordinateFormat: (coordinateFormat) => set({ coordinateFormat }),
  setActiveAnalysisDialog: (activeAnalysisDialog) => set({ activeAnalysisDialog }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setSplitViewEnabled: (splitViewEnabled) => set({ splitViewEnabled }),
  setSplitViewMode: (splitViewMode) => set({ splitViewMode }),
  setLanguage: (language) => set({ language }),
  setDistanceUnit: (distanceUnit) => set({ distanceUnit }),
  setFontSizePx: (fontSizePx) =>
    set({
      fontSizePx: Math.min(18, Math.max(12, Number.isFinite(fontSizePx) ? fontSizePx : 14)),
    }),
  setHistoryPanelOpen: (historyPanelOpen) => set({ historyPanelOpen }),
  setShowMiniMap: (show) => set({ showMiniMap: show }),
  setMobileOverlay: (mobileOverlay) => set({ mobileOverlay }),
  toggleLeftPanel: () => set((s) => ({ leftPanelCollapsed: !s.leftPanelCollapsed })),
  toggleRightPanel: () => set((s) => ({ rightPanelCollapsed: !s.rightPanelCollapsed })),
  setTheme: (theme) => set({ theme }),
  toggleTheme: () => set((s) => ({ theme: s.theme === 'dark' ? 'light' : 'dark' })),
  setRightPanelTab: (rightPanelTab) => set({ rightPanelTab }),
}));
