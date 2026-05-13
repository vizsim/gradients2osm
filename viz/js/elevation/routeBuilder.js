// Stitches the user's Ctrl+click sequence of way segments into a single
// polyline suitable for elevation sampling. Each new segment is auto-
// oriented relative to the previous tail: if its END is closer to the tail
// than its START, we walk it backwards.
//
// The output also includes:
//   - `joins`: per-segment metadata { reversed: boolean, gapMeters: number }
//     so the panel can tell the user where the route doesn't connect.
//   - `segmentLengthsMeters`: parallel array for aggregation.
//   - `cumulativeStartsMeters`: parallel array — distance along the route
//     where each segment's first vertex sits. Used by the heightgraph to
//     draw vertical separators.

const EARTH_RADIUS_METERS = 6371008.8;

// Endpoints closer than this are considered "connected" — anything beyond
// shows up as a gap in the heightgraph and a dashed connector on the map.
const CONNECTION_TOLERANCE_METERS = 10;

export function orientAgainstTail(prevTailCoord, segmentCoordinates) {
  if (!prevTailCoord || !segmentCoordinates?.length) {
    return { reversed: false, gapMeters: 0 };
  }
  const first = segmentCoordinates[0];
  const last = segmentCoordinates[segmentCoordinates.length - 1];
  const dStart = haversine(prevTailCoord, first);
  const dEnd = haversine(prevTailCoord, last);
  const reversed = dEnd < dStart;
  const gapMeters = reversed ? dEnd : dStart;
  return { reversed, gapMeters };
}

export function buildRouteFromSegments(segments) {
  if (!Array.isArray(segments) || segments.length === 0) {
    return {
      coordinates: [],
      joins: [],
      segmentLengthsMeters: [],
      cumulativeStartsMeters: [],
    };
  }

  const coordinates = [];
  const joins = [];
  const segmentLengthsMeters = [];
  const cumulativeStartsMeters = [];

  let cumulative = 0;
  let prevTail = null;

  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i];
    const rawCoords = seg.coordinates || [];
    if (rawCoords.length < 2) {
      joins.push({ reversed: !!seg.reversed, gapMeters: 0 });
      segmentLengthsMeters.push(0);
      cumulativeStartsMeters.push(cumulative);
      continue;
    }

    // Use the orientation that was decided at click-time (segmentHover sets
    // `reversed` against the previous tail). For the first segment it's
    // always false. We re-compute the gap here so the heightgraph can show
    // it; the orientation itself is trusted from the segment record.
    const reversed = !!seg.reversed;
    const orientedCoords = reversed ? rawCoords.slice().reverse() : rawCoords;

    const gapMeters = prevTail ? haversine(prevTail, orientedCoords[0]) : 0;
    joins.push({ reversed, gapMeters });

    cumulativeStartsMeters.push(cumulative);

    // Skip the duplicate joint vertex when we're appending a connected
    // segment (gap below tolerance). For larger gaps we keep both vertices
    // so the heightgraph can render the jump.
    const startIndex = (i > 0 && gapMeters <= CONNECTION_TOLERANCE_METERS) ? 1 : 0;

    let segmentLength = 0;
    let lastVertex = coordinates.length ? coordinates[coordinates.length - 1] : null;
    for (let v = startIndex; v < orientedCoords.length; v += 1) {
      const vertex = orientedCoords[v];
      if (lastVertex) {
        segmentLength += haversine(lastVertex, vertex);
      }
      coordinates.push(vertex);
      lastVertex = vertex;
    }

    segmentLengthsMeters.push(segmentLength);
    cumulative += segmentLength;
    prevTail = orientedCoords[orientedCoords.length - 1];
  }

  return {
    coordinates,
    joins,
    segmentLengthsMeters,
    cumulativeStartsMeters,
  };
}

function haversine(a, b) {
  const aLng = a[0];
  const aLat = a[1];
  const bLng = b[0];
  const bLat = b[1];
  if (!Number.isFinite(aLng) || !Number.isFinite(aLat) || !Number.isFinite(bLng) || !Number.isFinite(bLat)) {
    return Number.POSITIVE_INFINITY;
  }
  const lat1 = (aLat * Math.PI) / 180;
  const lat2 = (bLat * Math.PI) / 180;
  const latDelta = ((bLat - aLat) * Math.PI) / 180;
  const lngDelta = ((bLng - aLng) * Math.PI) / 180;
  const h = Math.sin(latDelta / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(lngDelta / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

export { CONNECTION_TOLERANCE_METERS };
