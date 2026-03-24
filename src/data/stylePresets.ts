import type { StylePreset } from '@/types';

/**
 * Built-in thematic style presets for the style panel (rainbow, sequential ramps, heat, quantile).
 */
export const STYLE_PRESETS: StylePreset[] = [
  {
    id: 'rainbow',
    name: '🌈 彩虹渐变',
    colors: [
      '#6e40aa',
      '#bf3caf',
      '#fe4b83',
      '#ff7847',
      '#f2f735',
      '#7cca23',
      '#12a980',
      '#0b79a4',
    ],
    type: 'categorical',
  },
  {
    id: 'blues',
    name: '🔵 蓝色系',
    colors: ['#f7fbff', '#c6dbef', '#6baed6', '#2171b5', '#084594'],
    type: 'sequential',
  },
  {
    id: 'reds',
    name: '🔴 红色系',
    colors: ['#fff5f0', '#fcbba1', '#fb6a4a', '#cb181d', '#67000d'],
    type: 'sequential',
  },
  {
    id: 'greens',
    name: '🟢 绿色系',
    colors: ['#f7fcf5', '#c7e9c0', '#74c476', '#238b45', '#00441b'],
    type: 'sequential',
  },
  {
    id: 'heat',
    name: '🌡️ 热度',
    colors: ['#313695', '#4575b4', '#74add1', '#abd9e9', '#fee090', '#fdae61', '#f46d43', '#d73027'],
    type: 'diverging',
  },
  {
    id: 'quantile',
    name: '📊 分位数',
    colors: ['#edf8fb', '#ccece6', '#99d8c9', '#66c2a4', '#41ae76', '#238b45', '#005824'],
    type: 'categorical',
  },
];
