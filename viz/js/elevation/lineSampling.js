// Sample a polyline (array of [lng, lat] vertices) into evenly-spaced points
// with cumulative distance, so we can feed it to mapterhornClient and get
// an elevation profile compatible with heightgraph.js.

const DEFAULT_SPACING_METERS = 10;
const MIN_SAMPLES = 8;
const MAX_SAMPLES = 220;
const EARTH_RADIUS_METERS = 6371008.8;

export function samplePolyline(coordinates, options = {}) {
  if (!Array.isArray(coordinates) || coordinates.length < 2) {
    return { samples: [], totalDistanceMeters: 0 };
  }

  const segments = [];
  let totalDistanceMeters = 0;
  for (let i = 0; i < coordinates.length - 1; i += 1) {
    const a = toLngLat(coordinates[i]);
    const b = toLngLat(coordinates[i + 1]);
    if (!a || !b) continue;
    const length = haversineMeters(a, b);
    if (!(length > 0)) continue;
    segments.push({ a, b, length, startDistance: totalDistanceMeters });
    totalDistanceMeters += length;
  }

  if (segments.length === 0 || totalDistanceMeters <= 0) {
    return { samples: [], totalDistanceMeters: 0 };
  }

  const spacingMeters = options.spacingMeters || DEFAULT_SPACING_METERS;
  const targetCount = Math.ceil(totalDistanceMeters / spacingMeters) + 1;
  const sampleCount = Math.max(MIN_SAMPLES, Math.min(MAX_SAMPLES, targetCount));

  const samples = new Array(sampleCount);
  let segmentIndex = 0;
  for (let i = 0; i < sampleCount; i += 1) {
    const t = sampleCount === 1 ? 0 : i / (sampleCount - 1);
    const target = t * totalDistanceMeters;
    while (
      segmentIndex < segments.length - 1
      && segments[segmentIndex].startDistance + segments[segmentIndex].length < target
    ) {
      segmentIndex += 1;
    }
    const seg = segments[segmentIndex];
    const localRatio = seg.length > 0
      ? Math.max(0, Math.min(1, (target - seg.startDistance) / seg.length))
      : 0;
    samples[i] = {
      lng: seg.a.lng + (seg.b.lng - seg.a.lng) * localRatio,
      lat: seg.a.lat + (seg.b.lat - seg.a.lat) * localRatio,
      distanceMeters: target,
    };
  }

  return { samples, totalDistanceMeters };
}

function toLngLat(coord) {
  if (!Array.isArray(coord) || coord.length < 2) return null;
  const lng = Number(coord[0]);
  const lat = Number(coord[1]);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  return { lng, lat };
}

function haversineMeters(a, b) {
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const latDelta = ((b.lat - a.lat) * Math.PI) / 180;
  const lngDelta = ((b.lng - a.lng) * Math.PI) / 180;
  const h = Math.sin(latDelta / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(lngDelta / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}
