import type { LayerConfig, LayerKind, LegendItem, LegendItemEntry, LegendShape } from '@/types';

/**
 * Coerces a paint value to a CSS color string for legend swatches.
 *
 * @param value - Raw paint value (string, expression array, or object).
 * @param fallback - Color when value is missing or non-string.
 */
function colorFromPaintValue(value: unknown, fallback: string): string {
  if (typeof value === 'string' && value.trim() !== '') {
    return value;
  }
  return fallback;
}

/**
 * Picks a default label for a layer kind when no class breakdown exists.
 *
 * @param type - Layer renderer family.
 */
function defaultLabelForKind(type: LayerKind): string {
  switch (type) {
    case 'fill':
      return '填充';
    case 'line':
      return '线';
    case 'circle':
      return '点';
    case 'symbol':
      return '符号';
    case 'raster':
      return '栅格';
    case 'extrusion':
      return '挤出';
    case 'heatmap':
      return '热力';
    case '3d-tiles':
      return '3D Tiles';
    default:
      return '图层';
  }
}

/**
 * Resolves legend shape from layer kind.
 *
 * @param type - Layer kind.
 */
function shapeForKind(type: LayerKind): LegendShape {
  switch (type) {
    case 'line':
      return 'line';
    case 'circle':
    case 'symbol':
      return 'circle';
    case 'heatmap':
      return 'gradient';
    default:
      return 'square';
  }
}

/**
 * Builds legend rows from a single layer's `paint` map (best-effort heuristics).
 *
 * @param layer - Map layer configuration.
 * @returns One legend group for this layer.
 */
export function generateLegendItems(layers: LayerConfig[]): LegendItem[] {
  const fallback = 'var(--accent)';
  const out: LegendItem[] = [];

  for (const layer of layers) {
    if (!layer.visible) {
      continue;
    }
    const paint = layer.paint ?? {};
    const entries: LegendItemEntry[] = [];
    const shape = shapeForKind(layer.type);

    switch (layer.type) {
      case 'fill': {
        const c = colorFromPaintValue(paint['fill-color'], fallback);
        entries.push({ color: c, label: defaultLabelForKind('fill'), shape });
        break;
      }
      case 'line': {
        const c = colorFromPaintValue(paint['line-color'], fallback);
        entries.push({ color: c, label: defaultLabelForKind('line'), shape: 'line' });
        break;
      }
      case 'circle': {
        const c = colorFromPaintValue(paint['circle-color'], fallback);
        entries.push({ color: c, label: defaultLabelForKind('circle'), shape: 'circle' });
        break;
      }
      case 'symbol': {
        const c = colorFromPaintValue(
          paint['icon-color'] ?? paint['text-color'],
          fallback,
        );
        entries.push({ color: c, label: defaultLabelForKind('symbol'), shape: 'circle' });
        break;
      }
      case 'heatmap': {
        const c = colorFromPaintValue(paint['heatmap-color'] ?? paint['heatmap-opacity'], fallback);
        entries.push({
          color: c,
          label: defaultLabelForKind('heatmap'),
          shape: 'gradient',
        });
        break;
      }
      case 'extrusion': {
        const c = colorFromPaintValue(paint['extrusion-color'], fallback);
        entries.push({ color: c, label: defaultLabelForKind('extrusion'), shape: 'square' });
        break;
      }
      case 'raster': {
        entries.push({
          color: fallback,
          label: defaultLabelForKind('raster'),
          shape: 'square',
        });
        break;
      }
      case '3d-tiles': {
        entries.push({
          color: fallback,
          label: defaultLabelForKind('3d-tiles'),
          shape: 'square',
        });
        break;
      }
      default:
        entries.push({
          color: fallback,
          label: defaultLabelForKind(layer.type),
          shape: 'square',
        });
    }

    if (entries.length > 0) {
      out.push({ layerName: layer.name, entries });
    }
  }

  return out;
}
