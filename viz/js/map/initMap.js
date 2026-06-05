// MapLibre setup with the OpenFreeMap Positron basemap and a PMTiles
// vector source for the gradient ways. The PMTiles protocol is registered
// once on the global maplibregl singleton.

const POSITRON_STYLE_URL = 'https://tiles.openfreemap.org/styles/positron';

// Registered gradient regions — one PMTiles archive per Bundesland. MapLibre
// will only fetch tiles from sources whose bounds intersect the viewport
// (the bounds come from each PMTiles header via the pmtiles:// protocol),
// so adding more states here has near-zero cost when they're off-screen.
//
// Add a new state by dropping its .pmtiles into ./data/ AND uploading the
// same filename to the remote bucket, then appending an entry here. `id` is used as a
// per-source/per-layer suffix; `file` is the basename used for both the
// local path and the remote fallback URL.
const GRADIENT_REGIONS = [
  { id: 'saarland',           label: 'Saarland',             file: 'saarland_v02.mlt.pmtiles' },
  { id: 'brandenburg',        label: 'Brandenburg + Berlin', file: 'brandenburg_v02.mlt.pmtiles' },
  { id: 'baden_wuerttemberg', label: 'Baden-Württemberg',    file: 'baden-wuerttemberg_v02.mlt.pmtiles' },
  { id: 'bayern',             label: 'Bayern',               file: 'bayern_v02.mlt.pmtiles' },
  { id: 'sachsen',            label: 'Sachsen',              file: 'sachsen_v02.mlt.pmtiles' },
];

// Where to look for PMTiles. We probe LOCAL first at startup — if the file
// is bundled with the deploy, range reads stay on the same origin (instant,
// no CORS). If LOCAL 404s (the case when the deploy is on GitHub Pages and
// the .pmtiles is too big to commit), we fall through to the REMOTE bucket
// (tiles.vizsim.de, a custom domain in front of the B2 storage).
const LOCAL_PMTILES_BASE = './data/';
const REMOTE_PMTILES_BASE = 'https://tiles.vizsim.de/file/gradients2osm/';

// Highway tiers — used both for build-time filtering (in tippecanoe) and
// runtime zoom-aware filtering on the main layer below.
const MAJOR_HIGHWAYS = [
  'motorway', 'motorway_link',
  'trunk', 'trunk_link',
  'primary', 'primary_link',
  'secondary', 'secondary_link',
  'tertiary', 'tertiary_link',
];

// Main-layer filter: at z<11.5 only show major roads; from z11.5 up the
// data already contains residentials/etc. and we let them through. Same
// `step` pattern as a layer-level minzoom, but applied per-feature so a
// single main layer per region is enough (no minor/major layer split).
const MAIN_LAYER_BASE_FILTER = [
  'step', ['zoom'],
  ['match', ['get', 'highway'], MAJOR_HIGHWAYS, true, false],
  11.5,
  true,
];

const SOURCE_LAYER = 'ways';
const sourceIdFor = (regionId) => `gradients-${regionId}`;
const layerIds = (regionId) => ({
  main: `gradients-${regionId}-ways`,
  hover: `gradients-${regionId}-hover`,
  pin: `gradients-${regionId}-pinned`,
  arrow: `gradients-${regionId}-arrows-fwd`,
});

// Flattened lookup of every region-layer ID by role — handy for the hover
// machinery to query all regions at once via map.queryRenderedFeatures.
const REGION_LAYER_IDS = GRADIENT_REGIONS.reduce(
  (acc, region) => {
    const ids = layerIds(region.id);
    acc.main.push(ids.main);
    acc.hover.push(ids.hover);
    acc.pin.push(ids.pin);
    acc.arrow.push(ids.arrow);
    return acc;
  },
  { main: [], hover: [], pin: [], arrow: [] },
);

const SAMPLE_SOURCE_ID = 'gradients-sample';
const SAMPLE_LAYER_ID = 'gradients-sample-marker';

// Raster basemap + DEM + 3D buildings overlay — all added once at init,
// toggled via visibility so we never need to swap styles (which would force
// us to re-add every gradient layer on each change).
const OSM_CARTO_SOURCE_ID = 'osm-carto-source';
const OSM_CARTO_LAYER_ID = 'osm-carto-layer';
const ESRI_SOURCE_ID = 'esri-imagery-source';
const ESRI_LAYER_ID = 'esri-imagery-layer';
const TERRAIN_DEM_SOURCE_ID = 'terrain-dem';
const HILLSHADE_LAYER_ID = 'hillshade-layer';
const BUILDINGS_SOURCE_ID = 'ofm-buildings-source';
const BUILDINGS_LAYER_ID = 'ofm-3d-buildings';
const TERRAIN_DEM_TILEJSON_URL = 'https://tiles.mapterhorn.com/tilejson.json';
const BUILDINGS_VECTOR_URL = 'https://tiles.openfreemap.org/planet';

// Blue atmospheric sky for the 3D terrain view — same palette as the
// hilo_profiler project. atmosphere-blend fades the sky out as you zoom
// down to street level, so the horizon haze doesn't bleed into close-ups.
const SKY_STYLE = {
  'sky-color': '#199EF3',
  'sky-horizon-blend': 0.7,
  'horizon-color': '#f0f8ff',
  'horizon-fog-blend': 0.8,
  'fog-color': '#2c7fb8',
  'fog-ground-blend': 0.9,
  'atmosphere-blend': [
    'interpolate',
    ['linear'],
    ['zoom'],
    0, 1,
    12, 0,
  ],
};

// Every layer we add ourselves; everything else in the style belongs to the
// Positron host style and gets hidden when a raster basemap is selected.
const CUSTOM_LAYER_IDS = new Set([
  OSM_CARTO_LAYER_ID,
  ESRI_LAYER_ID,
  HILLSHADE_LAYER_ID,
  BUILDINGS_LAYER_ID,
  SAMPLE_LAYER_ID,
  ...REGION_LAYER_IDS.main,
  ...REGION_LAYER_IDS.hover,
  ...REGION_LAYER_IDS.pin,
  ...REGION_LAYER_IDS.arrow,
]);

const EMPTY_FEATURE_COLLECTION = { type: 'FeatureCollection', features: [] };

// Color ramp: neutral grey for flat, warm yellow→orange→red for steeper,
// purple at the extreme end. Stops align with the categorical bins in the
// top legend (flach / 2-4 / 4-6 / 6-10 / >10) so the smooth map ramp and
// the categorical histogram tell the same story. Sign is treated as
// direction-agnostic in the paint via abs(). Stops are in percent.
const GRADIENT_COLOR_STOPS = [
  [0,  '#93a39a'],
  [2,  '#fee08b'],
  [4,  '#fdae61'],
  [6,  '#f46d43'],
  [10, '#d73027'],
  [20, '#7a0177'],
];

export async function initMap(container) {
  registerPmtilesProtocol();

  const map = new maplibregl.Map({
    container,
    style: POSITRON_STYLE_URL,
    // Default view: Berlin city centre at z~11 — enough to see one full
    // gradient region with residential streets in detail. `hash: true`
    // means the URL hash takes precedence on reload, so the user's last
    // position is sticky after the first visit.
    center: [13.4378, 52.5128],
    zoom: 10.92,
    minZoom: 5,
    maxZoom: 17,
    maxPitch: 75,
    hash: true,
    attributionControl: { compact: true },
    // Default tile cache scales with viewport (~150 tiles on a 1080p canvas).
    // We have three gradient sources active simultaneously, plus basemap +
    // optionally DEM/buildings, so the default fills up fast and tiles get
    // evicted when the user pans/zooms back to where they just were. 512
    // gives plenty of headroom (~200 MB peak with vector tiles) so revisits
    // don't trigger a re-fetch.
    maxTileCacheSize: 512,
  });

  map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'top-left');

  // Resolve LOCAL-vs-REMOTE URLs *in parallel* with the basemap loading —
  // by the time `map.once('load')` fires the HEAD probes are usually done
  // too, so this adds zero wall-clock time when probes succeed quickly.
  const regionUrlsPromise = resolveRegionUrls(GRADIENT_REGIONS);

  await new Promise((resolve) => {
    if (map.isStyleLoaded()) {
      resolve();
    } else {
      map.once('load', resolve);
    }
  });

  const regionUrls = await regionUrlsPromise;

  addBasemapAndTerrainLayers(map);
  addGradientLayers(map, regionUrls);
  // 3D buildings + DEM/hillshade are NOT added at init anymore — the
  // sources fire their tilejson + DEM tile fetches eagerly the moment they
  // exist, even if the corresponding layer is hidden. We lazy-add them in
  // the setMapBuildings / setMapRelief helpers below the first time the
  // user actually toggles them on.

  return { map };
}

// HEAD-probe each region's local URL; fall back to the B2 mirror if the
// file isn't deployed locally. Logs a one-liner per region so it's obvious
// in the console whether the deploy is serving everything itself or
// streaming from B2.
async function resolveRegionUrls(regions) {
  const probes = regions.map(async (region) => {
    const localUrl = `${LOCAL_PMTILES_BASE}${region.file}`;
    const remoteUrl = `${REMOTE_PMTILES_BASE}${region.file}`;
    try {
      const response = await fetch(localUrl, { method: 'HEAD' });
      if (response.ok) {
        // eslint-disable-next-line no-console
        console.info(`[gradients] ${region.id}: local (${localUrl})`);
        return `pmtiles://${localUrl}`;
      }
    } catch {
      // local fetch threw (server down, CORS, etc.) → fall through
    }
    // eslint-disable-next-line no-console
    console.info(`[gradients] ${region.id}: remote fallback (${remoteUrl})`);
    return `pmtiles://${remoteUrl}`;
  });
  const urls = await Promise.all(probes);
  return Object.fromEntries(regions.map((r, i) => [r.id, urls[i]]));
}

function addBasemapAndTerrainLayers(map) {
  // The two raster basemaps. Inserted before any of the Positron labels so
  // when shown they cover the positron canvas but stay under labels — but
  // because we hide ALL Positron layers when a raster basemap is active,
  // that ordering only matters for the brief moment of switching.
  const firstSymbol = findFirstSymbolLayer(map);

  map.addSource(OSM_CARTO_SOURCE_ID, {
    type: 'raster',
    tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
    tileSize: 256,
    attribution: '© OpenStreetMap contributors',
  });
  map.addLayer(
    {
      id: OSM_CARTO_LAYER_ID,
      type: 'raster',
      source: OSM_CARTO_SOURCE_ID,
      layout: { visibility: 'none' },
    },
    firstSymbol,
  );

  map.addSource(ESRI_SOURCE_ID, {
    type: 'raster',
    tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
    tileSize: 256,
    attribution: 'Tiles © Esri',
  });
  map.addLayer(
    {
      id: ESRI_LAYER_ID,
      type: 'raster',
      source: ESRI_SOURCE_ID,
      layout: { visibility: 'none' },
    },
    firstSymbol,
  );

  // Mapterhorn DEM source + hillshade layer are NOT added here anymore —
  // the source's tilejson fetches eagerly the moment we register it, even
  // with no consumer. `ensureTerrainArtifacts` adds them on first relief
  // toggle.
}

// Lazy adders for DEM + buildings. Kept out of init so an unused toggle
// doesn't cost a tilejson roundtrip on every page load.
function ensureTerrainArtifacts(map) {
  if (map.getSource(TERRAIN_DEM_SOURCE_ID)) return;
  map.addSource(TERRAIN_DEM_SOURCE_ID, {
    type: 'raster-dem',
    url: TERRAIN_DEM_TILEJSON_URL,
    tileSize: 512,
    encoding: 'terrarium',
    attribution: '© Mapterhorn',
  });
  map.addLayer(
    {
      id: HILLSHADE_LAYER_ID,
      type: 'hillshade',
      source: TERRAIN_DEM_SOURCE_ID,
      layout: { visibility: 'none' },
      paint: {
        'hillshade-exaggeration': 0.35,
        'hillshade-illumination-anchor': 'map',
      },
    },
    findFirstSymbolLayer(map),
  );
}

function ensureBuildingsArtifacts(map) {
  if (map.getSource(BUILDINGS_SOURCE_ID)) return;
  map.addSource(BUILDINGS_SOURCE_ID, {
    type: 'vector',
    url: BUILDINGS_VECTOR_URL,
  });
  map.addLayer({
    id: BUILDINGS_LAYER_ID,
    type: 'fill-extrusion',
    source: BUILDINGS_SOURCE_ID,
    'source-layer': 'building',
    minzoom: 14,
    layout: { visibility: 'none' },
    paint: {
      'fill-extrusion-color': 'hsl(35, 8%, 85%)',
      'fill-extrusion-height': [
        'max',
        ['coalesce', ['to-number', ['get', 'render_height']], 12],
        ['coalesce', ['to-number', ['get', 'render_min_height']], 0],
      ],
      'fill-extrusion-base': ['coalesce', ['to-number', ['get', 'render_min_height']], 0],
      'fill-extrusion-opacity': 0.8,
    },
  });
}

function registerPmtilesProtocol() {
  if (registerPmtilesProtocol.done) return;
  if (typeof pmtiles === 'undefined') {
    throw new Error('pmtiles library not loaded — check the <script> tag in index.html');
  }
  const protocol = new pmtiles.Protocol();
  maplibregl.addProtocol('pmtiles', protocol.tile);
  registerPmtilesProtocol.done = true;
}

function addGradientLayers(map, regionUrls) {
  // Find a label layer so our lines sit *below* labels but above the basemap
  // background. Falls back to the very top if no label layer is found.
  const firstLabelLayer = findFirstSymbolLayer(map);

  // pmtiles.js reads each archive's bounds out of its header and exposes
  // them via TileJSON, so MapLibre only fetches tiles for the regions that
  // intersect the current viewport. The Mapterhorn/gradients2osm
  // attribution is set on the first region only to avoid N duplicates in
  // the attribution control.
  GRADIENT_REGIONS.forEach((region, regionIndex) => {
    map.addSource(sourceIdFor(region.id), {
      type: 'vector',
      url: regionUrls[region.id],
      // Tiles in these PMTiles are MapLibre Tiles (MLT), not MVT. Without
      // this hint MapLibre's vector source tries to protobuf-decode them
      // and throws "Unimplemented type: N" for every tile.
      encoding: 'mlt',
      attribution: regionIndex === 0
        ? 'Live-DEM <a href="https://mapterhorn.com" target="_blank" rel="noreferrer">Mapterhorn</a>'
            + ' · Steigungen auf Basis von'
            + ' <a href="https://sonny.4lima.de/" target="_blank" rel="noreferrer">Sonny DTM Germany 20 m</a>'
        : undefined,
    });
  });

  // Layer order: ALL region mains first, THEN all hovers, THEN all pins,
  // THEN all arrows. Otherwise region B's `main` line would render on top
  // of region A's `pin` highlight at a border tile and the pinned segment
  // would visually disappear.
  GRADIENT_REGIONS.forEach((region) => {
    map.addLayer(
      {
        id: layerIds(region.id).main,
        type: 'line',
        source: sourceIdFor(region.id),
        'source-layer': SOURCE_LAYER,
        // Hide residentials/etc. below z11.5 — keeps the overview view
        // legible at zoom 9–11. Hover/pin/arrow layers don't get this filter
        // so a pinned residential stays visible even after zooming out.
        filter: MAIN_LAYER_BASE_FILTER,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': buildGradientColorExpression(),
          'line-width': [
            'interpolate',
            ['exponential', 1.6],
            ['zoom'],
            9, 1.6,
            13, 1.8,
            15, 3,
            17, 6,
          ],
          'line-opacity': [
            'interpolate', ['linear'], ['zoom'],
            9, 0.85,
            12, 0.9,
            14, 0.95,
          ],
        },
      },
      firstLabelLayer,
    );
  });

  GRADIENT_REGIONS.forEach((region) => {
    map.addLayer(
      {
        id: layerIds(region.id).hover,
        type: 'line',
        source: sourceIdFor(region.id),
        'source-layer': SOURCE_LAYER,
        // `osm_id` is stored as a string in the MLT tiles (tippecanoe was
        // built with `-T osm_id:string` because real OSM IDs overflow int32).
        // MapLibre's `==` is type-strict, so all hover/pin/arrow filters in
        // this file and in segmentHover.js coerce the tile value back to a
        // number to match against the numeric IDs the JS side passes in.
        filter: ['==', ['to-number', ['get', 'osm_id']], -1],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#1d4ed8',
          'line-width': [
            'interpolate',
            ['exponential', 1.6],
            ['zoom'],
            10, 1.6,
            13, 3.2,
            15, 5.5,
            17, 9,
          ],
          'line-opacity': 0.45,
        },
      },
      firstLabelLayer,
    );
  });

  GRADIENT_REGIONS.forEach((region) => {
    map.addLayer(
      {
        id: layerIds(region.id).pin,
        type: 'line',
        source: sourceIdFor(region.id),
        'source-layer': SOURCE_LAYER,
        filter: ['==', ['to-number', ['get', 'osm_id']], -1],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#1d4ed8',
          'line-width': [
            'interpolate',
            ['exponential', 1.6],
            ['zoom'],
            10, 2.4,
            13, 4.6,
            15, 8,
            17, 14,
          ],
          'line-opacity': 0.95,
        },
      },
      firstLabelLayer,
    );
  });

  GRADIENT_REGIONS.forEach((region) => {
    map.addLayer({
      id: layerIds(region.id).arrow,
      type: 'symbol',
      source: sourceIdFor(region.id),
      'source-layer': SOURCE_LAYER,
      filter: ['==', ['to-number', ['get', 'osm_id']], -1],
      layout: {
        'symbol-placement': 'line',
        'symbol-spacing': 110,
        'text-field': '▶',
        'text-size': [
          'interpolate', ['linear'], ['zoom'],
          12, 11,
          14, 15,
          17, 22,
        ],
        'text-keep-upright': false,
        'text-rotation-alignment': 'map',
        'text-allow-overlap': true,
        'text-ignore-placement': true,
      },
      paint: {
        'text-color': '#1d4ed8',
        'text-halo-color': '#ffffff',
        'text-halo-width': 1.8,
      },
    });
  });

  // Marker that mirrors the heightgraph hover cursor onto the map.
  // Sits above all the highlight layers (and labels) so it's always visible.
  map.addSource(SAMPLE_SOURCE_ID, {
    type: 'geojson',
    data: EMPTY_FEATURE_COLLECTION,
  });

  map.addLayer({
    id: SAMPLE_LAYER_ID,
    type: 'circle',
    source: SAMPLE_SOURCE_ID,
    paint: {
      'circle-radius': [
        'interpolate',
        ['linear'],
        ['zoom'],
        10, 3.5,
        14, 5.5,
        17, 8,
      ],
      'circle-color': '#2563eb',
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': 2,
      'circle-pitch-alignment': 'map',
    },
  });
}

function buildGradientColorExpression(metric = 'gradient_smooth_pct') {
  const expression = [
    'interpolate',
    ['linear'],
    ['abs', ['coalesce', ['to-number', ['get', metric]], 0]],
  ];

  GRADIENT_COLOR_STOPS.forEach(([stop, color]) => {
    expression.push(stop, color);
  });

  return expression;
}

export function setMapGradientMetric(map, metric) {
  if (!map) return;
  const expr = buildGradientColorExpression(metric);
  for (const layerId of REGION_LAYER_IDS.main) {
    if (map.getLayer(layerId)) {
      map.setPaintProperty(layerId, 'line-color', expr);
    }
  }
}

// Restrict the main ways layer to features whose |metric| lies inside
// [min, max]. We always keep the zoom-tier base filter active — the slider
// composes on top of it instead of replacing it.
export function setMapGradientFilter(map, { metric, min, max, legendMax }) {
  if (!map) return;

  const hasLower = min > 0;
  const hasUpper = max < legendMax;

  let filter = MAIN_LAYER_BASE_FILTER;
  if (hasLower || hasUpper) {
    // to-number(get, 0) is strictly typed as `number` (with 0 as the fallback
    // for null/missing); coalesce + get returns `value | number` which fails
    // MapLibre's static typecheck on abs() with "expected number, found null".
    const valueExpr = ['abs', ['to-number', ['get', metric], 0]];
    const clauses = [MAIN_LAYER_BASE_FILTER];
    if (hasLower) clauses.push(['>=', valueExpr, min]);
    if (hasUpper) clauses.push(['<=', valueExpr, max]);
    filter = ['all', ...clauses];
  }

  for (const layerId of REGION_LAYER_IDS.main) {
    if (!map.getLayer(layerId)) continue;
    try {
      map.setFilter(layerId, filter);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[gradients] setFilter failed', layerId, filter, err);
    }
  }
}

// ── Basemap / terrain / building toggles ────────────────────────────────

export function setMapBasemap(map, basemap) {
  if (!map) return;
  const showOsm = basemap === 'osm';
  const showEsri = basemap === 'satellite';
  const hideHost = showOsm || showEsri;

  if (map.getLayer(OSM_CARTO_LAYER_ID)) {
    map.setLayoutProperty(OSM_CARTO_LAYER_ID, 'visibility', showOsm ? 'visible' : 'none');
  }
  if (map.getLayer(ESRI_LAYER_ID)) {
    map.setLayoutProperty(ESRI_LAYER_ID, 'visibility', showEsri ? 'visible' : 'none');
  }

  // Hide Positron's own background/road/label layers when a raster basemap
  // is showing — otherwise the Positron labels bleed through OSM Carto's own
  // labels and you get double text everywhere.
  const layers = map.getStyle()?.layers || [];
  layers.forEach((layer) => {
    if (CUSTOM_LAYER_IDS.has(layer.id)) return;
    map.setLayoutProperty(layer.id, 'visibility', hideHost ? 'none' : 'visible');
  });
}

export function setMapRelief(map, enabled) {
  if (!map) return;
  // Lazy: only fetch the Mapterhorn tilejson + start streaming DEM tiles
  // the first time the user actually flips this toggle.
  if (enabled) ensureTerrainArtifacts(map);
  if (map.getLayer(HILLSHADE_LAYER_ID)) {
    map.setLayoutProperty(HILLSHADE_LAYER_ID, 'visibility', enabled ? 'visible' : 'none');
  }
  if (map.getSource(TERRAIN_DEM_SOURCE_ID)) {
    map.setTerrain(enabled ? { source: TERRAIN_DEM_SOURCE_ID, exaggeration: 1 } : null);
  }
  // Blue atmosphere only when terrain is showing. setSky is gated on the
  // method existing because some older MapLibre builds don't ship it.
  if (typeof map.setSky === 'function') {
    map.setSky(enabled ? SKY_STYLE : undefined);
  }
  // Tilt the camera so the 3D terrain is actually visible when enabling,
  // and bring it back flat when disabling. Skip if the user is already
  // mid-pan/pitch so we don't fight their input.
  if (!map.isMoving()) {
    if (enabled && map.getPitch() < 45) {
      map.easeTo({ pitch: 55, duration: 700 });
    } else if (!enabled && map.getPitch() > 5) {
      map.easeTo({ pitch: 0, duration: 500 });
    }
  }
}

export function setMapBuildings(map, enabled) {
  if (!map) return;
  // Lazy: only fetch the OpenFreeMap planet tilejson + start streaming
  // building polygons the first time the user actually flips this toggle.
  if (enabled) ensureBuildingsArtifacts(map);
  if (map.getLayer(BUILDINGS_LAYER_ID)) {
    map.setLayoutProperty(BUILDINGS_LAYER_ID, 'visibility', enabled ? 'visible' : 'none');
  }
}

export function setActiveOsmIdForArrows(map, osmId) {
  if (!map) return;
  const filterValue = osmId ?? -1;
  const filter = ['==', ['to-number', ['get', 'osm_id']], filterValue];
  for (const layerId of REGION_LAYER_IDS.arrow) {
    if (map.getLayer(layerId)) {
      map.setFilter(layerId, filter);
    }
  }
}

export function setSampleMarker(map, lngLat) {
  if (!map) return;
  const source = map.getSource(SAMPLE_SOURCE_ID);
  if (!source) return;
  if (!lngLat || !Number.isFinite(lngLat.lng) || !Number.isFinite(lngLat.lat)) {
    source.setData(EMPTY_FEATURE_COLLECTION);
    return;
  }
  source.setData({
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lngLat.lng, lngLat.lat] },
      properties: {},
    }],
  });
}

function findFirstSymbolLayer(map) {
  const layers = map.getStyle().layers || [];
  for (const layer of layers) {
    if (layer.type === 'symbol') {
      return layer.id;
    }
  }
  return undefined;
}

export const GRADIENTS_MAIN_LAYER_IDS = REGION_LAYER_IDS.main;
export const GRADIENTS_HOVER_LAYER_IDS = REGION_LAYER_IDS.hover;
export const GRADIENTS_PIN_LAYER_IDS = REGION_LAYER_IDS.pin;
export { GRADIENT_COLOR_STOPS, GRADIENT_REGIONS };
