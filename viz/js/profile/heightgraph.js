const BASE_PADDING = { top: 16, right: 22, bottom: 24, left: 42 };
const Y_AXIS_LABEL_GAP = 10;
const HEIGHTGRAPH_COLORS = {
  backgroundTop: '#f4fbff',
  backgroundBottom: '#dfeff7',
  grid: 'rgba(48, 84, 104, 0.12)',
  axisText: '#466072',
  areaTop: 'rgba(16, 185, 129, 0.42)',
  areaBottom: 'rgba(37, 99, 235, 0.08)',
  terrainLine: 'rgba(15, 118, 110, 0.44)',
  buildingAreaTop: 'rgba(245, 158, 11, 0.38)',
  buildingAreaBottom: 'rgba(234, 88, 12, 0.2)',
  buildingLine: '#b45309',
  line: '#0f766e',
  hoverLine: 'rgba(37, 99, 235, 0.45)',
  hoverPoint: '#2563eb',
  tooltipBg: 'rgba(15, 23, 42, 0.92)',
  tooltipText: '#ffffff',
};

const CSS_HEIGHT = 150;
const MIN_CSS_WIDTH = 280;

// Cache holds the pre-rendered static layer of the chart (background, grid,
// areas, lines, building overlay, distance labels) and the metadata needed
// to draw the hover indicator on top. Invalidated via a fingerprint over
// profileData stats + canvas size + devicePixelRatio.
const cache = {
  fingerprint: '',
  offscreenCanvas: null,
  offscreenContext: null,
  cssWidth: 0,
  cssHeight: 0,
  graphWidth: 0,
  graphHeight: 0,
  padding: null,
  xAxis: null,
  yAxis: null,
  points: null,
};

export function renderHeightgraph(profileData, hoverSampleIndex = null) {
  const canvas = document.getElementById('heightgraph-canvas');
  const context = canvas.getContext('2d');
  const devicePixelRatio = window.devicePixelRatio || 1;
  const cssWidth = Math.max(MIN_CSS_WIDTH, canvas.clientWidth || MIN_CSS_WIDTH);
  const cssHeight = CSS_HEIGHT;

  const elevations = filterFiniteElevations(profileData?.elevations);
  if (elevations.length < 2) {
    resizeCanvasIfNeeded(canvas, cssWidth, cssHeight, devicePixelRatio);
    context.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    context.clearRect(0, 0, cssWidth, cssHeight);
    drawEmptyState(context, cssWidth, cssHeight);
    cache.fingerprint = '';
    return;
  }

  const fingerprint = buildFingerprint(profileData, cssWidth, cssHeight, devicePixelRatio);
  if (cache.fingerprint !== fingerprint) {
    rebuildOffscreen(profileData, elevations, cssWidth, cssHeight, devicePixelRatio);
    cache.fingerprint = fingerprint;
  }

  resizeCanvasIfNeeded(canvas, cssWidth, cssHeight, devicePixelRatio);
  context.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  context.drawImage(cache.offscreenCanvas, 0, 0, cssWidth, cssHeight);

  if (hoverSampleIndex !== null && cache.points && cache.points[hoverSampleIndex]) {
    const terrainElevations = profileData.terrainElevations?.length === profileData.elevations.length
      ? profileData.terrainElevations
      : profileData.elevations;
    const buildingOffsets = profileData.buildingOffsets || [];

    drawHoverIndicator(
      context,
      cache.points[hoverSampleIndex],
      {
        elevation: profileData.elevations[hoverSampleIndex],
        terrainElevation: terrainElevations[hoverSampleIndex],
        buildingOffset: buildingOffsets[hoverSampleIndex] || 0,
      },
      cache.graphWidth,
      cache.graphHeight,
      cache.padding
    );
  }
}

renderHeightgraph.getHoverIndex = function getHoverIndex(profileData, canvas, event) {
  const rect = canvas.getBoundingClientRect();
  const relativeX = event.clientX - rect.left;
  const relativeY = event.clientY - rect.top;

  const cssWidth = Math.max(MIN_CSS_WIDTH, canvas.clientWidth || MIN_CSS_WIDTH);
  const cssHeight = CSS_HEIGHT;
  const devicePixelRatio = window.devicePixelRatio || 1;
  const fingerprint = buildFingerprint(profileData, cssWidth, cssHeight, devicePixelRatio);

  let xAxis;
  let padding;
  let graphWidth;
  let graphHeight;

  if (cache.fingerprint === fingerprint && cache.padding) {
    xAxis = cache.xAxis;
    padding = cache.padding;
    graphWidth = cache.graphWidth;
    graphHeight = cache.graphHeight;
  } else {
    const context = canvas.getContext('2d');
    const elevations = filterFiniteElevations(profileData?.elevations);
    const minElevation = elevations.length ? Math.min(...elevations) : 0;
    const maxElevation = elevations.length ? Math.max(...elevations) : 1;
    const yAxis = createNiceAxis(minElevation, maxElevation, 4);
    padding = getChartPadding(context, yAxis);
    graphWidth = cssWidth - padding.left - padding.right;
    graphHeight = cssHeight - padding.top - padding.bottom;
    xAxis = createDistanceAxis(Math.max(profileData.stats.distanceMeters, 1), 4);
  }

  if (
    relativeX < padding.left
    || relativeX > padding.left + graphWidth
    || relativeY < padding.top
    || relativeY > padding.top + graphHeight
  ) {
    return null;
  }

  const ratio = (relativeX - padding.left) / graphWidth;
  const targetDistance = ratio * xAxis.max;

  let nearestIndex = 0;
  let nearestDistance = Number.POSITIVE_INFINITY;

  profileData.samples.forEach((sample, index) => {
    const delta = Math.abs(sample.distanceMeters - targetDistance);
    if (delta < nearestDistance) {
      nearestDistance = delta;
      nearestIndex = index;
    }
  });

  return nearestIndex;
};

function buildFingerprint(profileData, cssWidth, cssHeight, devicePixelRatio) {
  if (!profileData) {
    return '';
  }
  const stats = profileData.stats || {};
  const sampleCount = profileData.samples?.length || 0;
  const buildingHits = (profileData.buildingOffsets || [])
    .reduce((sum, value) => sum + (value > 0 ? 1 : 0), 0);
  const routeBoundaries = profileData.route?.cumulativeStartsMeters?.length || 0;
  return [
    sampleCount,
    stats.distanceMeters,
    stats.minElevation,
    stats.maxElevation,
    stats.ascentMeters,
    stats.descentMeters,
    buildingHits,
    routeBoundaries,
    cssWidth,
    cssHeight,
    devicePixelRatio,
  ].join('|');
}

function filterFiniteElevations(elevations) {
  if (!Array.isArray(elevations)) {
    return [];
  }
  const finite = [];
  for (const value of elevations) {
    if (Number.isFinite(value)) {
      finite.push(value);
    }
  }
  return finite;
}

function resizeCanvasIfNeeded(canvas, cssWidth, cssHeight, devicePixelRatio) {
  const bitmapWidth = Math.floor(cssWidth * devicePixelRatio);
  const bitmapHeight = Math.floor(cssHeight * devicePixelRatio);
  if (canvas.width !== bitmapWidth || canvas.height !== bitmapHeight) {
    canvas.width = bitmapWidth;
    canvas.height = bitmapHeight;
  }
}

function rebuildOffscreen(profileData, elevations, cssWidth, cssHeight, devicePixelRatio) {
  if (!cache.offscreenCanvas) {
    cache.offscreenCanvas = document.createElement('canvas');
    cache.offscreenContext = cache.offscreenCanvas.getContext('2d');
  }
  const bitmapWidth = Math.floor(cssWidth * devicePixelRatio);
  const bitmapHeight = Math.floor(cssHeight * devicePixelRatio);
  if (cache.offscreenCanvas.width !== bitmapWidth || cache.offscreenCanvas.height !== bitmapHeight) {
    cache.offscreenCanvas.width = bitmapWidth;
    cache.offscreenCanvas.height = bitmapHeight;
  }
  const context = cache.offscreenContext;
  context.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  context.clearRect(0, 0, cssWidth, cssHeight);

  const minElevation = Math.min(...elevations);
  const maxElevation = Math.max(...elevations);
  const yAxis = createNiceAxis(minElevation, maxElevation, 4);
  const xAxis = createDistanceAxis(Math.max(profileData.stats.distanceMeters, 1), 4);
  const padding = getChartPadding(context, yAxis);
  const elevationRange = Math.max(1, yAxis.max - yAxis.min);

  const graphWidth = cssWidth - padding.left - padding.right;
  const graphHeight = cssHeight - padding.top - padding.bottom;

  drawBackground(context, cssWidth, cssHeight);
  drawGrid(context, graphWidth, graphHeight, yAxis, padding);

  const terrainElevations = profileData.terrainElevations?.length === profileData.elevations.length
    ? profileData.terrainElevations
    : profileData.elevations;
  const buildingOffsets = profileData.buildingOffsets || [];
  const terrainPoints = createGraphPoints(profileData.samples, terrainElevations, xAxis.max, yAxis.min, elevationRange, graphWidth, graphHeight, padding);
  const points = createGraphPoints(profileData.samples, profileData.elevations, xAxis.max, yAxis.min, elevationRange, graphWidth, graphHeight, padding);

  drawArea(context, terrainPoints, graphHeight, padding);
  drawLine(context, terrainPoints, HEIGHTGRAPH_COLORS.terrainLine, 1.75);
  drawBuildingOverlay(context, terrainPoints, points, buildingOffsets);
  drawLine(context, points, HEIGHTGRAPH_COLORS.line, 2.5);
  drawSegmentBoundaries(context, profileData.route, xAxis, graphWidth, graphHeight, padding);
  drawDistanceLabels(context, graphWidth, graphHeight, xAxis, padding);

  cache.cssWidth = cssWidth;
  cache.cssHeight = cssHeight;
  cache.graphWidth = graphWidth;
  cache.graphHeight = graphHeight;
  cache.padding = padding;
  cache.xAxis = xAxis;
  cache.yAxis = yAxis;
  cache.points = points;
}

function drawBackground(context, width, height) {
  const gradient = context.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, HEIGHTGRAPH_COLORS.backgroundTop);
  gradient.addColorStop(1, HEIGHTGRAPH_COLORS.backgroundBottom);
  context.fillStyle = gradient;
  context.fillRect(0, 0, width, height);

  const glow = context.createRadialGradient(width * 0.22, height * 0.12, 0, width * 0.22, height * 0.12, width * 0.65);
  glow.addColorStop(0, 'rgba(255, 255, 255, 0.72)');
  glow.addColorStop(1, 'rgba(255, 255, 255, 0)');
  context.fillStyle = glow;
  context.fillRect(0, 0, width, height);
}

function drawGrid(context, graphWidth, graphHeight, yAxis, padding) {
  context.strokeStyle = HEIGHTGRAPH_COLORS.grid;
  context.fillStyle = HEIGHTGRAPH_COLORS.axisText;
  context.font = '12px IBM Plex Sans, sans-serif';
  context.textAlign = 'right';

  yAxis.ticks.forEach((value) => {
    const y = padding.top + graphHeight - ((value - yAxis.min) / (yAxis.max - yAxis.min || 1)) * graphHeight;
    context.beginPath();
    context.moveTo(padding.left, y);
    context.lineTo(padding.left + graphWidth, y);
    context.stroke();
    context.fillText(formatElevationTick(value), padding.left - Y_AXIS_LABEL_GAP, y + 4);
  });
}

function drawArea(context, points, graphHeight, padding) {
  if (!points.length) {
    return;
  }

  const gradient = context.createLinearGradient(0, padding.top, 0, padding.top + graphHeight);
  gradient.addColorStop(0, HEIGHTGRAPH_COLORS.areaTop);
  gradient.addColorStop(1, HEIGHTGRAPH_COLORS.areaBottom);
  context.fillStyle = gradient;
  context.beginPath();
  context.moveTo(points[0].x, padding.top + graphHeight);
  points.forEach((point) => context.lineTo(point.x, point.y));
  context.lineTo(points[points.length - 1].x, padding.top + graphHeight);
  context.closePath();
  context.fill();
}

function drawBuildingOverlay(context, terrainPoints, combinedPoints, buildingOffsets) {
  if (!terrainPoints.length || !combinedPoints.length || !buildingOffsets.length) {
    return;
  }

  let segmentStart = null;

  for (let index = 0; index < combinedPoints.length; index += 1) {
    const hasBuilding = Number.isFinite(buildingOffsets[index])
      && buildingOffsets[index] > 0
      && terrainPoints[index]
      && combinedPoints[index];

    if (hasBuilding && segmentStart === null) {
      segmentStart = index;
      continue;
    }

    if (!hasBuilding && segmentStart !== null) {
      drawBuildingSegment(context, terrainPoints, combinedPoints, segmentStart, index - 1);
      segmentStart = null;
    }
  }

  if (segmentStart !== null) {
    drawBuildingSegment(context, terrainPoints, combinedPoints, segmentStart, combinedPoints.length - 1);
  }
}

function drawBuildingSegment(context, terrainPoints, combinedPoints, startIndex, endIndex) {
  if (startIndex > endIndex) {
    return;
  }

  const fillGradient = context.createLinearGradient(0, combinedPoints[startIndex].y, 0, terrainPoints[startIndex].y);
  fillGradient.addColorStop(0, HEIGHTGRAPH_COLORS.buildingAreaTop);
  fillGradient.addColorStop(1, HEIGHTGRAPH_COLORS.buildingAreaBottom);
  context.fillStyle = fillGradient;

  if (startIndex === endIndex) {
    const point = combinedPoints[startIndex];
    const basePoint = terrainPoints[startIndex];
    const halfWidth = getSingleSampleWidth(combinedPoints, startIndex);
    context.fillRect(point.x - halfWidth, point.y, halfWidth * 2, Math.max(1, basePoint.y - point.y));
    context.strokeStyle = HEIGHTGRAPH_COLORS.buildingLine;
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(point.x - halfWidth, point.y);
    context.lineTo(point.x + halfWidth, point.y);
    context.stroke();
    return;
  }

  context.beginPath();
  context.moveTo(combinedPoints[startIndex].x, combinedPoints[startIndex].y);
  for (let index = startIndex + 1; index <= endIndex; index += 1) {
    context.lineTo(combinedPoints[index].x, combinedPoints[index].y);
  }
  for (let index = endIndex; index >= startIndex; index -= 1) {
    context.lineTo(terrainPoints[index].x, terrainPoints[index].y);
  }
  context.closePath();
  context.fill();

  drawLine(
    context,
    combinedPoints.slice(startIndex, endIndex + 1),
    HEIGHTGRAPH_COLORS.buildingLine,
    2.1
  );
}

function getSingleSampleWidth(points, index) {
  const previousSpan = index > 0 ? points[index].x - points[index - 1].x : 0;
  const nextSpan = index < points.length - 1 ? points[index + 1].x - points[index].x : 0;
  return Math.max(4, Math.min(14, Math.max(previousSpan, nextSpan, 8) * 0.45));
}

function drawLine(context, points, strokeStyle = HEIGHTGRAPH_COLORS.line, lineWidth = 2.5) {
  context.strokeStyle = strokeStyle;
  context.lineWidth = lineWidth;
  context.beginPath();
  points.forEach((point, index) => {
    if (index === 0) {
      context.moveTo(point.x, point.y);
      return;
    }
    context.lineTo(point.x, point.y);
  });
  context.stroke();
}

function drawHoverIndicator(context, point, hoverData, graphWidth, graphHeight, padding) {
  context.strokeStyle = HEIGHTGRAPH_COLORS.hoverLine;
  context.lineWidth = 1.5;
  context.beginPath();
  context.moveTo(point.x, padding.top);
  context.lineTo(point.x, padding.top + graphHeight);
  context.stroke();

  context.fillStyle = '#ffffff';
  context.strokeStyle = HEIGHTGRAPH_COLORS.hoverPoint;
  context.lineWidth = 2;
  context.beginPath();
  context.arc(point.x, point.y, 4.5, 0, Math.PI * 2);
  context.fill();
  context.stroke();

  if (Number.isFinite(hoverData.elevation)) {
    drawHoverTooltip(context, point, buildHoverLabels(hoverData), graphWidth, graphHeight, padding);
  }
}

function buildHoverLabels({ elevation, terrainElevation, buildingOffset }) {
  if (!Number.isFinite(elevation)) {
    return [];
  }

  if (Number.isFinite(terrainElevation) && Number.isFinite(buildingOffset) && buildingOffset > 0) {
    return [
      `Gesamt ${formatElevationTick(elevation)}`,
      `Terrain ${formatElevationTick(terrainElevation)} + Geb. ${formatElevationTick(buildingOffset)}`,
    ];
  }

  return [formatElevationTick(elevation)];
}

function drawHoverTooltip(context, point, labels, graphWidth, graphHeight, padding) {
  if (!labels.length) {
    return;
  }

  context.save();
  context.font = '11px IBM Plex Sans, sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'top';

  const textWidth = labels.reduce((widest, label) => Math.max(widest, context.measureText(label).width), 0);
  const lineHeight = 13;
  const tooltipWidth = Math.ceil(textWidth + 16);
  const tooltipHeight = Math.ceil(labels.length * lineHeight + 10);
  const minX = padding.left;
  const maxX = padding.left + graphWidth - tooltipWidth;
  const tooltipX = Math.min(Math.max(point.x - tooltipWidth / 2, minX), maxX);
  const preferredTop = point.y - tooltipHeight - 14;
  const tooltipY = preferredTop >= 6 ? preferredTop : Math.min(point.y + 14, padding.top + graphHeight - tooltipHeight - 8);
  const tooltipCenterX = tooltipX + tooltipWidth / 2;

  context.fillStyle = HEIGHTGRAPH_COLORS.tooltipBg;
  drawRoundedRectPath(context, tooltipX, tooltipY, tooltipWidth, tooltipHeight, 8);
  context.fill();

  context.fillStyle = HEIGHTGRAPH_COLORS.tooltipText;
  labels.forEach((label, index) => {
    context.fillText(label, tooltipCenterX, tooltipY + 5 + index * lineHeight);
  });
  context.restore();
}

function createGraphPoints(samples, elevations, maxDistance, minElevation, elevationRange, graphWidth, graphHeight, padding) {
  return samples.map((sample, index) => {
    const x = padding.left + (graphWidth * sample.distanceMeters) / maxDistance;
    const y = padding.top + graphHeight - ((elevations[index] - minElevation) / elevationRange) * graphHeight;
    return { x, y };
  });
}

function drawRoundedRectPath(context, x, y, width, height, radius) {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.lineTo(x + width - radius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + radius);
  context.lineTo(x + width, y + height - radius);
  context.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  context.lineTo(x + radius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - radius);
  context.lineTo(x, y + radius);
  context.quadraticCurveTo(x, y, x + radius, y);
  context.closePath();
}

// Vertical separator at the start of each pinned segment (except the very
// first). A short tick at the top + a faint full-height divider makes it
// easy to see "this is where segment 2 starts" without dominating the chart.
function drawSegmentBoundaries(context, route, xAxis, graphWidth, graphHeight, padding) {
  if (!route?.cumulativeStartsMeters || route.cumulativeStartsMeters.length < 2) return;

  context.save();
  context.strokeStyle = 'rgba(99, 102, 241, 0.55)'; // indigo, subtle
  context.setLineDash([3, 3]);
  context.lineWidth = 1;

  // Skip index 0 — that's just the origin.
  for (let i = 1; i < route.cumulativeStartsMeters.length; i += 1) {
    const distance = route.cumulativeStartsMeters[i];
    if (distance > xAxis.max) continue;
    const x = padding.left + (graphWidth * distance) / xAxis.max;
    context.beginPath();
    context.moveTo(x, padding.top);
    context.lineTo(x, padding.top + graphHeight);
    context.stroke();
  }

  context.restore();
}

function drawDistanceLabels(context, graphWidth, graphHeight, xAxis, padding) {
  context.fillStyle = HEIGHTGRAPH_COLORS.axisText;
  context.font = '12px IBM Plex Sans, sans-serif';
  const labelInset = 8;

  xAxis.ticks.forEach((value, index) => {
    let x = padding.left + (graphWidth * value) / xAxis.max;
    if (index === 0) {
      context.textAlign = 'left';
      x += labelInset;
    } else if (index === xAxis.ticks.length - 1) {
      context.textAlign = 'right';
      x -= labelInset;
    } else {
      context.textAlign = 'center';
    }

    context.fillText(formatDistanceTick(value, xAxis.step), x, padding.top + graphHeight + 18);
  });
}

function getChartPadding(context, yAxis) {
  context.save();
  context.font = '12px IBM Plex Sans, sans-serif';
  const maxLabelWidth = yAxis.ticks.reduce((widest, value) => {
    return Math.max(widest, context.measureText(formatElevationTick(value)).width);
  }, 0);
  context.restore();

  return {
    ...BASE_PADDING,
    left: Math.max(BASE_PADDING.left, Math.ceil(maxLabelWidth + Y_AXIS_LABEL_GAP + 2)),
  };
}

function formatElevationTick(value) {
  return `${Math.round(value)} m`;
}

function drawEmptyState(context, width, height) {
  context.fillStyle = HEIGHTGRAPH_COLORS.axisText;
  context.font = '13px IBM Plex Sans, sans-serif';
  context.textAlign = 'center';
  context.fillText('Zu wenige Höhendaten verfügbar.', width / 2, height / 2);
}

// Floor for the y-axis span. On near-flat segments the real range can be
// well under 1 m; without this pad the tick labels round to the same integer
// and the chart looks dead. Pinning the axis to at least MIN_AXIS_RANGE_M
// keeps the line scaled to a physically meaningful frame.
const MIN_AXIS_RANGE_M = 10;

function createNiceAxis(minValue, maxValue, targetTickCount) {
  if (!Number.isFinite(minValue) || !Number.isFinite(maxValue)) {
    return { min: 0, max: 1, step: 1, ticks: [0, 1] };
  }

  const dataRange = Math.max(maxValue - minValue, 0);
  const range = Math.max(dataRange, MIN_AXIS_RANGE_M);
  const center = (minValue + maxValue) / 2;
  const paddedMin = center - range / 2;
  const paddedMax = center + range / 2;
  const step = niceStep(range / targetTickCount);
  const min = Math.floor(paddedMin / step) * step;
  const max = Math.ceil(paddedMax / step) * step;
  return { min, max, step, ticks: buildTicks(min, max, step) };
}

function createDistanceAxis(maxValue, targetTickCount) {
  if (!Number.isFinite(maxValue) || maxValue <= 0) {
    return { min: 0, max: 1, step: 1, ticks: [0, 1] };
  }

  const step = niceStep(maxValue / targetTickCount);
  return { min: 0, max: maxValue, step, ticks: buildDistanceTicks(maxValue, step) };
}

function niceStep(rawStep) {
  const exponent = Math.floor(Math.log10(rawStep || 1));
  const magnitude = 10 ** exponent;
  const normalized = rawStep / magnitude;

  if (normalized <= 1) {
    return 1 * magnitude;
  }
  if (normalized <= 2) {
    return 2 * magnitude;
  }
  if (normalized <= 5) {
    return 5 * magnitude;
  }
  return 10 * magnitude;
}

function buildTicks(minValue, maxValue, step) {
  const ticks = [];
  for (let value = minValue; value <= maxValue + step * 0.5; value += step) {
    ticks.push(Number(value.toFixed(6)));
  }
  return ticks;
}

function buildDistanceTicks(maxValue, step) {
  if (maxValue <= step) {
    return [0, Number(maxValue.toFixed(6))];
  }

  const ticks = [0];
  for (let value = step; value < maxValue; value += step) {
    ticks.push(Number(value.toFixed(6)));
  }

  const lastTick = ticks[ticks.length - 1];
  const roundedMax = Number(maxValue.toFixed(6));
  const remainingDistance = maxValue - lastTick;

  if (Math.abs(remainingDistance) <= step * 0.05) {
    ticks[ticks.length - 1] = roundedMax;
    return ticks;
  }

  // Drop the second-to-last regular tick when it lies within ~60 % of a step
  // away from the rounded-max label — anything closer and the two labels
  // crowd visually. Empirically 0.5 was too lenient (e.g. 1770 m / step 500
  // has rem = 270 = 54 %, still cramped); 0.6 catches both the 480/200 case
  // (40 %) and the 1770/500 case (54 %) without sacrificing usable density
  // when the max sits cleanly inside the next step.
  if (ticks.length > 2 && remainingDistance < step * 0.6) {
    ticks[ticks.length - 1] = roundedMax;
    return ticks;
  }

  ticks.push(roundedMax);
  return ticks;
}

function formatDistanceTick(distanceMeters, step = 0) {
  if (distanceMeters >= 1000) {
    const distanceKm = distanceMeters / 1000;
    const stepKm = step / 1000;
    const decimals = stepKm >= 1 || Number.isInteger(distanceKm)
      ? 0
      : stepKm >= 0.5 || distanceKm >= 10
        ? 1
        : 2;
    return `${distanceKm.toFixed(decimals)} km`;
  }

  return `${Math.round(distanceMeters)} m`;
}
