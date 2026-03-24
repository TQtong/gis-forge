import type { GeoJsonGeometry } from '@/types';

/** File extensions accepted by drag-and-drop and open dialogs. */
export const SUPPORTED_EXTENSIONS = ['.geojson', '.json', '.csv', '.kml', '.gpx'] as const;

/** Lowercase extensions including the leading dot. */
const EXT_SET = new Set<string>(SUPPORTED_EXTENSIONS);

/**
 * Returns true when the filename ends with a supported data extension (case-insensitive).
 *
 * @param filename - Original file name including extension.
 * @returns Whether the extension is supported.
 */
export function isSupportedFormat(filename: string): boolean {
  const lower = filename.trim().toLowerCase();
  const dot = lower.lastIndexOf('.');
  if (dot === -1) {
    return false;
  }
  const ext = lower.slice(dot);
  return EXT_SET.has(ext);
}

/**
 * Extracts the lower-case extension including the dot.
 *
 * @param filename - File name.
 * @returns Extension such as `.geojson`, or empty string when missing.
 */
function getExtension(filename: string): string {
  const lower = filename.trim().toLowerCase();
  const dot = lower.lastIndexOf('.');
  if (dot === -1) {
    return '';
  }
  return lower.slice(dot);
}

/**
 * Validates a parsed object as GeoJSON-like (Feature, FeatureCollection, or Geometry).
 *
 * @param data - Parsed JSON value.
 * @returns True when the structure is usable as GeoJSON.
 */
function isGeoJsonLike(data: unknown): boolean {
  if (!data || typeof data !== 'object') {
    return false;
  }
  const obj = data as Record<string, unknown>;
  const t = obj.type;
  if (t === 'FeatureCollection') {
    return Array.isArray(obj.features);
  }
  if (t === 'Feature') {
    return obj.geometry !== undefined;
  }
  if (
    t === 'Point' ||
    t === 'MultiPoint' ||
    t === 'LineString' ||
    t === 'MultiLineString' ||
    t === 'Polygon' ||
    t === 'MultiPolygon' ||
    t === 'GeometryCollection'
  ) {
    return Array.isArray(obj.coordinates) || t === 'GeometryCollection';
  }
  return false;
}

/**
 * Parses a single CSV line with comma separation and minimal quote handling.
 *
 * @param line - One line of text.
 * @returns Array of cell strings.
 */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/**
 * Finds latitude / longitude column indices from header names (case-insensitive).
 *
 * @param header - Header cells.
 * @returns Column indices or null when not found.
 */
function detectLatLngColumns(header: string[]): { latIdx: number; lngIdx: number } | null {
  const norm = header.map((h) => h.toLowerCase());
  const latNames = ['lat', 'latitude', 'y', 'northing'];
  const lngNames = ['lon', 'lng', 'longitude', 'x', 'easting'];
  let latIdx = -1;
  let lngIdx = -1;
  for (let i = 0; i < norm.length; i += 1) {
    const h = norm[i] ?? '';
    if (latNames.includes(h)) {
      latIdx = i;
    }
    if (lngNames.includes(h)) {
      lngIdx = i;
    }
  }
  if (latIdx === -1 || lngIdx === -1) {
    return null;
  }
  return { latIdx, lngIdx };
}

/**
 * Converts CSV text to a GeoJSON FeatureCollection of points.
 *
 * @param text - Raw CSV content.
 * @throws Error when no data rows or lat/lng columns are missing.
 * @returns GeoJSON FeatureCollection.
 */
function csvToGeoJsonPoints(text: string): Record<string, unknown> {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) {
    throw new Error('CSV 至少需要表头与一行数据');
  }
  const header = splitCsvLine(lines[0] ?? '');
  const cols = detectLatLngColumns(header);
  if (!cols) {
    throw new Error('未找到纬度/经度列（需要 lat/lng 或 latitude/longitude 等列名）');
  }
  const features: Record<string, unknown>[] = [];
  for (let r = 1; r < lines.length; r += 1) {
    const row = splitCsvLine(lines[r] ?? '');
    const latStr = row[cols.latIdx];
    const lngStr = row[cols.lngIdx];
    if (latStr === undefined || lngStr === undefined) {
      continue;
    }
    const lat = Number.parseFloat(latStr);
    const lng = Number.parseFloat(lngStr);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      continue;
    }
    const props: Record<string, unknown> = {};
    for (let c = 0; c < header.length; c += 1) {
      const key = header[c] ?? `col${c}`;
      props[key] = row[c];
    }
    features.push({
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: [lng, lat],
      } satisfies GeoJsonGeometry,
      properties: props,
    });
  }
  if (!features.length) {
    throw new Error('CSV 中没有有效的坐标行');
  }
  return {
    type: 'FeatureCollection',
    features,
  };
}

/**
 * Reads text from a File with UTF-8 decoding.
 *
 * @param file - Browser File object.
 * @returns UTF-8 text.
 */
async function readTextFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result === 'string') {
        resolve(result);
      } else {
        reject(new Error('无法读取文件为文本'));
      }
    };
    reader.onerror = () => {
      reject(new Error(reader.error?.message ?? '文件读取失败'));
    };
    reader.readAsText(file, 'UTF-8');
  });
}

/**
 * Parses KML placemarks into a GeoJSON FeatureCollection (points, lines, polygons simplified).
 *
 * @param xmlText - Raw KML XML.
 * @returns GeoJSON FeatureCollection.
 */
function kmlToGeoJson(xmlText: string): Record<string, unknown> {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, 'application/xml');
  const parseError = doc.querySelector('parsererror');
  if (parseError) {
    throw new Error('KML XML 解析失败');
  }
  const features: Record<string, unknown>[] = [];

  const placemarks = doc.getElementsByTagName('Placemark');
  for (let i = 0; i < placemarks.length; i += 1) {
    const pm = placemarks[i];
    if (!pm) {
      continue;
    }
    const nameEl = pm.getElementsByTagName('name')[0];
    const name = nameEl?.textContent ?? `kml-${i}`;

    const point = pm.getElementsByTagName('Point')[0];
    const line = pm.getElementsByTagName('LineString')[0];
    const poly = pm.getElementsByTagName('Polygon')[0];

    if (point) {
      const coordEl = point.getElementsByTagName('coordinates')[0];
      const coordText = coordEl?.textContent?.trim() ?? '';
      const first = coordText.split(/\s+/)[0] ?? '';
      const parts = first.split(',');
      const lng = Number.parseFloat(parts[0] ?? '');
      const lat = Number.parseFloat(parts[1] ?? '');
      if (Number.isFinite(lng) && Number.isFinite(lat)) {
        features.push({
          type: 'Feature',
          properties: { name },
          geometry: { type: 'Point', coordinates: [lng, lat] } satisfies GeoJsonGeometry,
        });
      }
    } else if (line) {
      const coordEl = line.getElementsByTagName('coordinates')[0];
      const coords = parseKmlCoordString(coordEl?.textContent ?? '');
      if (coords.length >= 2) {
        features.push({
          type: 'Feature',
          properties: { name },
          geometry: { type: 'LineString', coordinates: coords } satisfies GeoJsonGeometry,
        });
      }
    } else if (poly) {
      const outer = poly.getElementsByTagName('outerBoundaryIs')[0];
      const ring = outer?.getElementsByTagName('LinearRing')[0];
      const coordEl = ring?.getElementsByTagName('coordinates')[0];
      const coords = parseKmlCoordString(coordEl?.textContent ?? '');
      if (coords.length >= 4) {
        const ringClosed = [...coords];
        const first = ringClosed[0];
        const last = ringClosed[ringClosed.length - 1];
        if (
          first &&
          last &&
          (first[0] !== last[0] || first[1] !== last[1]) &&
          first.length >= 2 &&
          last.length >= 2
        ) {
          ringClosed.push([first[0], first[1]]);
        }
        features.push({
          type: 'Feature',
          properties: { name },
          geometry: {
            type: 'Polygon',
            coordinates: [ringClosed],
          } satisfies GeoJsonGeometry,
        });
      }
    }
  }

  if (!features.length) {
    throw new Error('KML 中未找到可解析的矢量要素');
  }
  return { type: 'FeatureCollection', features };
}

/**
 * Parses KML coordinate tuples (lng,lat[,alt]) separated by spaces.
 *
 * @param text - Raw coordinates text.
 * @returns Array of [lng,lat] pairs.
 */
function parseKmlCoordString(text: string): number[][] {
  const out: number[][] = [];
  const chunks = text.trim().split(/\s+/);
  for (const chunk of chunks) {
    if (!chunk) {
      continue;
    }
    const p = chunk.split(',');
    const lng = Number.parseFloat(p[0] ?? '');
    const lat = Number.parseFloat(p[1] ?? '');
    if (Number.isFinite(lng) && Number.isFinite(lat)) {
      out.push([lng, lat]);
    }
  }
  return out;
}

/**
 * Parses GPX waypoints and tracks into GeoJSON features.
 *
 * @param xmlText - Raw GPX XML.
 * @returns GeoJSON FeatureCollection.
 */
function gpxToGeoJson(xmlText: string): Record<string, unknown> {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, 'application/xml');
  const parseError = doc.querySelector('parsererror');
  if (parseError) {
    throw new Error('GPX XML 解析失败');
  }
  const features: Record<string, unknown>[] = [];

  const wpts = doc.getElementsByTagName('wpt');
  for (let i = 0; i < wpts.length; i += 1) {
    const w = wpts[i];
    if (!w) {
      continue;
    }
    const lat = Number.parseFloat(w.getAttribute('lat') ?? '');
    const lon = Number.parseFloat(w.getAttribute('lon') ?? '');
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      const nameEl = w.getElementsByTagName('name')[0];
      features.push({
        type: 'Feature',
        properties: { name: nameEl?.textContent ?? `wpt-${i}` },
        geometry: { type: 'Point', coordinates: [lon, lat] } satisfies GeoJsonGeometry,
      });
    }
  }

  const trkSegs = doc.getElementsByTagName('trkseg');
  for (let s = 0; s < trkSegs.length; s += 1) {
    const seg = trkSegs[s];
    if (!seg) {
      continue;
    }
    const pts = seg.getElementsByTagName('trkpt');
    const coords: number[][] = [];
    for (let p = 0; p < pts.length; p += 1) {
      const pt = pts[p];
      if (!pt) {
        continue;
      }
      const lat = Number.parseFloat(pt.getAttribute('lat') ?? '');
      const lon = Number.parseFloat(pt.getAttribute('lon') ?? '');
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        coords.push([lon, lat]);
      }
    }
    if (coords.length >= 2) {
      features.push({
        type: 'Feature',
        properties: { name: `track-${s}` },
        geometry: { type: 'LineString', coordinates: coords } satisfies GeoJsonGeometry,
      });
    }
  }

  if (!features.length) {
    throw new Error('GPX 中未找到航点或轨迹点');
  }
  return { type: 'FeatureCollection', features };
}

/**
 * Parsed file payload for layer creation.
 */
export type ParsedFileResult = {
  /** Logical format id (`geojson`, `csv`, `kml`, `gpx`). */
  type: string;
  /** Parsed GeoJSON-like data. */
  data: unknown;
  /** Original file name (without path). */
  name: string;
};

/**
 * Reads and parses a geospatial file into GeoJSON-compatible data.
 *
 * @param file - Browser File from input or drag-and-drop.
 * @returns Parsed result with format tag and GeoJSON data.
 * @throws Error when the extension is unsupported or parsing fails.
 */
export async function parseFile(file: File): Promise<ParsedFileResult> {
  const name = file.name;
  const ext = getExtension(name);
  if (!EXT_SET.has(ext)) {
    throw new Error(`不支持的文件格式: ${ext || '(无扩展名)'}`);
  }

  if (ext === '.geojson' || ext === '.json') {
    const text = await readTextFile(file);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw new Error('JSON 解析失败');
    }
    if (!isGeoJsonLike(parsed)) {
      throw new Error('JSON 不是有效的 GeoJSON 结构');
    }
    return { type: 'geojson', data: parsed, name };
  }

  if (ext === '.csv') {
    const text = await readTextFile(file);
    const data = csvToGeoJsonPoints(text);
    return { type: 'csv', data, name };
  }

  if (ext === '.kml') {
    const text = await readTextFile(file);
    const data = kmlToGeoJson(text);
    return { type: 'kml', data, name };
  }

  if (ext === '.gpx') {
    const text = await readTextFile(file);
    const data = gpxToGeoJson(text);
    return { type: 'gpx', data, name };
  }

  throw new Error(`不支持的文件格式: ${ext}`);
}
