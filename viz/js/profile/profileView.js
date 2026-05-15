import { renderHeightgraph } from './heightgraph.js';
import { GRADIENT_METRICS } from '../state/appState.js';

const HIGHWAY_LABELS = {
  motorway: 'Autobahn',
  trunk: 'Schnellstraße',
  primary: 'Hauptstraße',
  secondary: 'Verbindungsstraße',
  tertiary: 'Verbindungsstraße',
  residential: 'Wohnstraße',
  service: 'Erschließungsstraße',
  living_street: 'Spielstraße',
  unclassified: 'Sonstige Straße',
  pedestrian: 'Fußgängerzone',
  footway: 'Fußweg',
  cycleway: 'Radweg',
  path: 'Pfad',
  track: 'Wirtschaftsweg',
  steps: 'Treppe',
};

const SLOPE_BUCKETS = [
  { id: 1, label: '2–4 %', cls: 'slope-1' },
  { id: 2, label: '4–6 %', cls: 'slope-2' },
  { id: 3, label: '6–10 %', cls: 'slope-3' },
  { id: 4, label: '> 10 %', cls: 'slope-4' },
];

export function setupProfileView(appState) {
  // DOM refs cached once — every renderUi tick previously did ~14 getElementById
  // lookups, plus a querySelectorAll. Now we just read object properties.
  const dom = cacheDom();

  // Last-rendered keys, one per section. We only redraw a section when its
  // key changes — the heightgraph hover case (the hottest path) now skips
  // the expensive store-section/gradient-list/segment-meta rebuilds entirely.
  const rendered = {
    activeOsmId: undefined,
    gradientListKey: undefined,
    profileSegmentId: undefined,
    profileMode: undefined, // 'loading' | 'error' | 'data' | 'empty'
    profileErrorMessage: undefined,
    pinned: undefined,
    showNote: undefined,
    showLive: undefined,
    showStore: undefined,
    storeAggregateMode: undefined,
    hoverSampleIndex: undefined,
    routeChipsKey: undefined,
    routeChipsFocusKey: undefined,
  };

  if (dom.unpinButton) {
    dom.unpinButton.addEventListener('click', () => appState.unpin());
  }

  // Click on a row in the gradient list switches the active metric — same
  // effect as the picker pinned to the bottom of the panel. Event
  // delegation here is robust to the list rebuilding on every active-segment
  // change.
  if (dom.gradientList) {
    dom.gradientList.addEventListener('click', (event) => {
      const item = event.target.closest('.metric-list-item[data-metric]');
      if (!item) return;
      appState.setGradientMetric(item.dataset.metric);
    });
    dom.gradientList.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const item = event.target.closest('.metric-list-item[data-metric]');
      if (!item) return;
      event.preventDefault();
      appState.setGradientMetric(item.dataset.metric);
    });
  }

  // Route chips: click a chip = focus that segment's details; click the X =
  // drop that segment from the route. Delegation on the list so we don't
  // need to rebind per re-render.
  if (dom.routeChipsList) {
    dom.routeChipsList.addEventListener('click', (event) => {
      const removeBtn = event.target.closest('.route-chip-remove');
      if (removeBtn) {
        event.stopPropagation();
        const idx = Number(removeBtn.dataset.index);
        if (Number.isInteger(idx)) appState.removePinnedAt(idx);
        return;
      }
      const chip = event.target.closest('.route-chip[data-index]');
      if (!chip) return;
      const idx = Number(chip.dataset.index);
      if (Number.isInteger(idx)) appState.setFocusedPinnedIndex(idx);
    });
  }

  let lastState = appState.getState();
  let resizeFrame = null;
  let lastCanvasWidth = 0;

  appState.subscribe((state) => {
    lastState = state;
    renderUi(dom, rendered, state);
  });

  // ResizeObserver catches every change to the canvas's laid-out width:
  // - the first layout pass after `hidden=false` un-hides the shell (the
  //   case where clientWidth was 0 / a fallback on the very first paint
  //   and the chart bitmap got stretched until the user moved the mouse)
  // - panel collapse/expand, scrollbar appearing or disappearing
  // - window resize
  // Cheaper and more correct than the previous window.resize listener.
  const observer = new ResizeObserver((entries) => {
    const entry = entries[0];
    if (!entry) return;
    const width = entry.contentBoxSize?.[0]?.inlineSize ?? entry.contentRect.width;
    if (width <= 0 || width === lastCanvasWidth) return;
    lastCanvasWidth = width;
    if (resizeFrame) cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = null;
      rendered.profileSegmentId = '__force__';
      renderUi(dom, rendered, lastState);
    });
  });
  observer.observe(dom.canvas);

  setupCanvasHoverThrottle(dom.canvas, appState);
}

// ─────────────────────────────────────────────────────────────────────────
// DOM caching
// ─────────────────────────────────────────────────────────────────────────

function cacheDom() {
  return {
    canvas: document.getElementById('heightgraph-canvas'),
    note: document.getElementById('routing-note'),
    empty: document.getElementById('profile-empty'),
    summary: document.getElementById('profile-summary'),
    canvasShell: document.getElementById('profile-canvas-shell'),
    liveSection: document.getElementById('live-section'),
    storeSection: document.getElementById('store-section'),
    meta: document.getElementById('segment-meta'),
    pinIndicator: document.getElementById('pin-indicator'),
    unpinButton: document.getElementById('unpin-button'),
    distanceSummary: document.getElementById('distance-summary'),
    ascentSummary: document.getElementById('ascent-summary'),
    descentSummary: document.getElementById('descent-summary'),
    minSummary: document.getElementById('min-summary'),
    maxSummary: document.getElementById('max-summary'),
    storeGain: document.getElementById('store-gain'),
    storeLoss: document.getElementById('store-loss'),
    storeLength: document.getElementById('store-length'),
    storeSamples: document.getElementById('store-samples'),
    gradientList: document.getElementById('gradient-list'),
    slopeBarFwd: document.getElementById('slope-bar-fwd'),
    slopeBarBwd: document.getElementById('slope-bar-bwd'),
    metricPickerButtons: Array.from(document.querySelectorAll('.metric-picker-btn')),
    routeChips: document.getElementById('route-chips'),
    routeChipsList: document.getElementById('route-chips-list'),
    routeChipsTitle: document.getElementById('route-chips-title'),
    routeChipsHint: document.getElementById('route-chips-hint'),
    storeMultiPinHint: document.getElementById('store-multi-pin-hint'),
    storeBlocks: Array.from(document.querySelectorAll('#store-section .store-block')),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// rAF-throttled heightgraph mousemove
// ─────────────────────────────────────────────────────────────────────────

function setupCanvasHoverThrottle(canvas, appState) {
  let rafId = null;
  let pendingX = 0;
  let pendingY = 0;

  const flush = () => {
    rafId = null;
    const state = appState.getState();
    if (!state.profileData) return;
    const idx = renderHeightgraph.getHoverIndex(
      state.profileData,
      canvas,
      { clientX: pendingX, clientY: pendingY },
    );
    appState.setHoverSampleIndex(idx);
  };

  canvas.addEventListener('mousemove', (event) => {
    pendingX = event.clientX;
    pendingY = event.clientY;
    if (rafId === null) {
      rafId = requestAnimationFrame(flush);
    }
  });

  canvas.addEventListener('mouseleave', () => {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    appState.setHoverSampleIndex(null);
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Main render dispatcher — gates each section by its own key
// ─────────────────────────────────────────────────────────────────────────

function renderUi(dom, rendered, state) {
  const hasProfile = Boolean(state.profileData);
  const hasActive = Boolean(state.activeFeature);
  const props = state.profileData?.properties || state.activeFeature?.properties || null;
  const activeOsmId = state.activeFeature?.osmId ?? null;

  // ── Always-cheap visibility toggles ──
  const showNote = !hasActive && !state.profileLoading && !state.profileError && !hasProfile;
  if (rendered.showNote !== showNote) {
    if (dom.note) {
      dom.note.hidden = !showNote;
      dom.note.style.display = showNote ? '' : 'none';
    }
    rendered.showNote = showNote;
  }

  if (rendered.pinned !== state.pinned) {
    if (dom.pinIndicator) dom.pinIndicator.hidden = !state.pinned;
    if (dom.unpinButton) dom.unpinButton.hidden = !state.pinned;
    rendered.pinned = state.pinned;
  }

  const showLive = hasActive || state.profileLoading || state.profileError || hasProfile;
  if (rendered.showLive !== showLive) {
    dom.liveSection.hidden = !showLive;
    rendered.showLive = showLive;
  }

  const showStore = Boolean(props);
  if (rendered.showStore !== showStore) {
    dom.storeSection.hidden = !showStore;
    rendered.showStore = showStore;
  }

  // When ≥2 segments are pinned, hide the per-segment PMTiles data blocks
  // and show a hint instead — naively length-weighted aggregations across
  // multiple ways tend to be misleading more than they help.
  const aggregateMode = (state.pinnedSegments?.length ?? 0) >= 2;
  if (rendered.storeAggregateMode !== aggregateMode) {
    if (dom.storeMultiPinHint) dom.storeMultiPinHint.hidden = !aggregateMode;
    for (const block of dom.storeBlocks) {
      block.hidden = aggregateMode;
    }
    rendered.storeAggregateMode = aggregateMode;
  }

  // ── Live section content (profile data, height summary, heightgraph) ──
  renderLiveSection(dom, rendered, state);

  // ── Store section content (segment meta, gradient list, store cells, slopes) ──
  // The expensive DOM rebuilds — gated by activeOsmId so they only run when
  // the active segment actually changes.
  if (props && rendered.activeOsmId !== activeOsmId) {
    renderSegmentMeta(dom.meta, props);
    renderStoreElevation(dom, props);
    renderSlopeBars(dom, props);
    rendered.activeOsmId = activeOsmId;
    rendered.gradientListKey = undefined; // force gradient-list rebuild below
  } else if (!props && rendered.activeOsmId !== null) {
    dom.meta.replaceChildren();
    dom.meta.hidden = true;
    rendered.activeOsmId = null;
    rendered.gradientListKey = undefined;
  }

  // Gradient list DOM is expensive (3 × N elements per item), so we only
  // rebuild it when the active segment changes — the values inside depend
  // on `props`, not on the picked metric. The is-active highlight is a
  // separate concern below.
  if (props && rendered.gradientListKey !== activeOsmId) {
    renderGradientList(dom.gradientList, props, state.gradientMetric);
    rendered.gradientListKey = activeOsmId;
  }

  // is-active highlight in the list + .selected on the picker buttons —
  // both reflect the same `state.gradientMetric`. We always sync them
  // unconditionally (no `rendered.pickerMetric` gating): three class
  // toggles each is essentially free, and a single source of truth means
  // the picker and the list cannot drift out of sync.
  if (props && dom.gradientList) {
    const listItems = dom.gradientList.querySelectorAll('.metric-list-item[data-metric]');
    for (const item of listItems) {
      item.classList.toggle('is-active', item.dataset.metric === state.gradientMetric);
    }
  }
  for (const btn of dom.metricPickerButtons) {
    btn.classList.toggle('selected', btn.dataset.metric === state.gradientMetric);
  }

  renderRouteChips(dom, rendered, state);
}

function renderRouteChips(dom, rendered, state) {
  if (!dom.routeChips || !dom.routeChipsList) return;

  const pinned = state.pinnedSegments || [];
  // Composition key: rebuild the chip DOM only when the route changes
  // composition (osm_ids in order). Focus moves use a separate key so we
  // only restyle the `.is-focused` flag without recreating chips.
  const compositionKey = pinned.map((s) => `${s.regionId}:${s.osmId}`).join('|');
  const focusKey = `${state.focusedPinnedIndex}`;

  // The chips bar is only useful in route mode (≥2 pinned). For a single
  // pin the segment-meta block below already shows everything; the chips
  // bar would just duplicate the name.
  if (pinned.length < 2) {
    if (rendered.routeChipsKey !== '') {
      dom.routeChips.hidden = true;
      dom.routeChipsList.replaceChildren();
      rendered.routeChipsKey = '';
      rendered.routeChipsFocusKey = '';
    }
    return;
  }

  if (rendered.routeChipsKey !== compositionKey) {
    dom.routeChipsList.replaceChildren();
    pinned.forEach((seg, index) => {
      const chip = document.createElement('li');
      chip.className = 'route-chip';
      chip.dataset.index = String(index);
      chip.setAttribute('role', 'button');
      chip.setAttribute('tabindex', '0');
      chip.setAttribute('title', 'Klick: Details · X: aus Route entfernen');

      const dot = document.createElement('span');
      dot.className = 'route-chip-dot';
      const gradPct = readNumber(seg.properties?.gradient_smooth_pct);
      if (gradPct !== null) {
        dot.style.background = colorForGradient(Math.abs(gradPct));
      }

      const name = document.createElement('span');
      name.className = 'route-chip-name';
      name.textContent = seg.properties?.name
        || seg.properties?.ref
        || (seg.properties?.highway ? labelHighway(seg.properties.highway) : `Way ${seg.osmId}`);

      const length = readNumber(seg.properties?.length_m);
      const meta = document.createElement('span');
      meta.className = 'route-chip-meta';
      meta.textContent = length !== null ? formatDistance(length) : '';

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'route-chip-remove';
      remove.dataset.index = String(index);
      remove.setAttribute('aria-label', `Segment ${index + 1} entfernen`);
      remove.textContent = '×';

      chip.append(dot, name, meta, remove);
      dom.routeChipsList.appendChild(chip);
    });
    rendered.routeChipsKey = compositionKey;
    rendered.routeChipsFocusKey = ''; // force focus-style sync below
  }

  if (rendered.routeChipsFocusKey !== focusKey) {
    const children = dom.routeChipsList.children;
    for (let i = 0; i < children.length; i += 1) {
      children[i].classList.toggle('is-focused', i === state.focusedPinnedIndex);
    }
    rendered.routeChipsFocusKey = focusKey;
  }

  dom.routeChips.hidden = false;
  dom.routeChipsTitle.textContent = `Route · ${pinned.length} Segmente`;

  // Aggregate hint: PMTiles sums (length / gain / loss) across the route.
  if (dom.routeChipsHint) {
    const totalLength = pinned.reduce((sum, s) => {
      const len = readNumber(s.properties?.length_m);
      return sum + (len ?? 0);
    }, 0);
    const totalGain = pinned.reduce((sum, s) => {
      const g = readNumber(s.properties?.elevation_gain_m);
      return sum + (g ?? 0);
    }, 0);
    const totalLoss = pinned.reduce((sum, s) => {
      const l = readNumber(s.properties?.elevation_loss_m);
      return sum + (l ?? 0);
    }, 0);
    dom.routeChipsHint.textContent = `${formatDistance(totalLength)} · ↑ ${formatHeight(totalGain)} · ↓ ${formatHeight(totalLoss)}`;
  }
}

function renderLiveSection(dom, rendered, state) {
  let mode;
  if (state.profileLoading) mode = 'loading';
  else if (state.profileError) mode = 'error';
  else if (state.profileData) mode = 'data';
  else mode = 'empty';

  if (mode === 'loading') {
    if (rendered.profileMode !== 'loading') {
      dom.empty.textContent = 'Höhendaten werden geladen …';
      dom.empty.hidden = false;
      dom.summary.hidden = true;
      dom.canvasShell.hidden = true;
      rendered.profileMode = 'loading';
      rendered.profileSegmentId = undefined;
    }
    return;
  }

  if (mode === 'error') {
    if (rendered.profileMode !== 'error' || rendered.profileErrorMessage !== state.profileError) {
      dom.empty.textContent = state.profileError;
      dom.empty.hidden = false;
      dom.summary.hidden = true;
      dom.canvasShell.hidden = true;
      rendered.profileMode = 'error';
      rendered.profileErrorMessage = state.profileError;
      rendered.profileSegmentId = undefined;
    }
    return;
  }

  if (mode === 'data') {
    const segmentId = state.profileSegmentId;
    const segmentChanged = rendered.profileSegmentId !== segmentId;
    if (segmentChanged) {
      dom.empty.hidden = true;
      dom.summary.hidden = false;
      dom.canvasShell.hidden = false;

      const stats = state.profileData.stats;
      dom.distanceSummary.textContent = formatDistance(stats.distanceMeters);
      dom.ascentSummary.textContent = formatHeight(stats.ascentMeters);
      dom.descentSummary.textContent = formatHeight(stats.descentMeters);
      dom.minSummary.textContent = formatHeight(stats.minElevation);
      dom.maxSummary.textContent = formatHeight(stats.maxElevation);

      rendered.profileMode = 'data';
      rendered.profileSegmentId = segmentId;
      rendered.profileErrorMessage = undefined;
    }
    // Heightgraph: cheap when only hoverSampleIndex changed (offscreen
    // canvas cache hands back the prerendered chart and only repaints the
    // hover indicator). Still skip the call entirely if the segment AND
    // hover index are both unchanged.
    if (segmentChanged || rendered.hoverSampleIndex !== state.hoverSampleIndex) {
      renderHeightgraph(state.profileData, state.hoverSampleIndex);
      rendered.hoverSampleIndex = state.hoverSampleIndex;
    }
    return;
  }

  // mode === 'empty'
  if (rendered.profileMode !== 'empty') {
    dom.empty.hidden = true;
    dom.summary.hidden = true;
    dom.canvasShell.hidden = true;
    rendered.profileMode = 'empty';
    rendered.profileSegmentId = undefined;
    rendered.profileErrorMessage = undefined;
    rendered.hoverSampleIndex = undefined;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Section renderers (only called when their section's key changed)
// ─────────────────────────────────────────────────────────────────────────

function renderSegmentMeta(container, props) {
  if (!container) return;

  container.hidden = false;

  const name = props.name || props.ref || (props.highway ? labelHighway(props.highway) : 'Unbenannter Weg');
  const length = readNumber(props.length_m);
  const subtitleParts = [];
  if (props.highway) subtitleParts.push(labelHighway(props.highway));
  if (length !== null) subtitleParts.push(formatDistance(length));
  if (props.maxspeed) subtitleParts.push(`${props.maxspeed} km/h`);
  if (props.surface) subtitleParts.push(props.surface);

  container.replaceChildren();

  const titleRow = document.createElement('div');
  titleRow.className = 'segment-title-row';

  const title = document.createElement('h2');
  title.className = 'segment-title';
  title.textContent = name;
  titleRow.appendChild(title);

  const osmId = readNumber(props.osm_id);
  if (osmId !== null) {
    const osmLink = document.createElement('a');
    osmLink.className = 'osm-link';
    osmLink.href = `https://www.openstreetmap.org/way/${osmId}`;
    osmLink.target = '_blank';
    osmLink.rel = 'noreferrer';
    osmLink.title = `OSM-Way ${osmId} auf openstreetmap.org öffnen`;
    osmLink.setAttribute('aria-label', `OSM-Way ${osmId} öffnen`);

    const osmImg = document.createElement('img');
    osmImg.src = './assets/osm_logo.svg';
    osmImg.alt = '';
    osmImg.decoding = 'async';
    osmImg.loading = 'lazy';
    osmLink.appendChild(osmImg);

    titleRow.appendChild(osmLink);
  }

  container.appendChild(titleRow);

  if (subtitleParts.length > 0) {
    const subtitle = document.createElement('p');
    subtitle.className = 'segment-subtitle';
    subtitle.textContent = subtitleParts.join(' · ');
    container.appendChild(subtitle);
  }

  const chips = document.createElement('div');
  chips.className = 'segment-chips';
  if (props.is_bridge_or_tunnel) chips.appendChild(makeChip('Brücke/Tunnel'));
  if (props.is_bridge_adjacent) chips.appendChild(makeChip('Brücke benachbart'));
  if (props.is_implausible_grad) chips.appendChild(makeChip('Steigung unplausibel', 'warn'));
  if (props.bridge && !props.is_bridge_or_tunnel) chips.appendChild(makeChip(`Brücke: ${props.bridge}`));
  if (props.tunnel && !props.is_bridge_or_tunnel) chips.appendChild(makeChip(`Tunnel: ${props.tunnel}`));
  if (chips.childNodes.length > 0) container.appendChild(chips);
}

function renderGradientList(list, props, activeMetric) {
  if (!list) return;
  list.replaceChildren();

  for (const { id, label, description } of GRADIENT_METRICS) {
    const value = readNumber(props[id]);
    const item = document.createElement('li');
    item.className = 'metric-list-item';
    item.dataset.metric = id;
    item.setAttribute('role', 'button');
    item.setAttribute('tabindex', '0');
    item.setAttribute('title', `Karte nach „${label}" einfärben`);
    if (id === activeMetric) item.classList.add('is-active');

    const swatch = document.createElement('span');
    swatch.className = 'metric-list-swatch';
    if (value !== null) {
      swatch.style.background = colorForGradient(Math.abs(value));
      swatch.style.borderColor = 'transparent';
    } else {
      swatch.style.background = 'transparent';
      swatch.style.borderColor = 'var(--border-secondary)';
    }

    const labelEl = document.createElement('span');
    labelEl.className = 'metric-list-label';
    labelEl.textContent = label;
    labelEl.title = description;

    const valueEl = document.createElement('strong');
    valueEl.className = 'metric-list-value';
    valueEl.textContent = value !== null ? `${value.toFixed(2)} %` : '–';

    item.append(swatch, labelEl, valueEl);
    list.appendChild(item);
  }
}

function renderStoreElevation(dom, props) {
  const gain = readNumber(props.elevation_gain_m);
  const loss = readNumber(props.elevation_loss_m);
  const length = readNumber(props.length_m);
  const samples = readNumber(props.n_samples);

  dom.storeGain.textContent = gain !== null ? formatHeight(gain) : '–';
  dom.storeLoss.textContent = loss !== null ? formatHeight(loss) : '–';
  dom.storeLength.textContent = length !== null ? formatDistance(length) : '–';
  dom.storeSamples.textContent = samples !== null ? String(Math.round(samples)) : '–';
}

function renderSlopeBars(dom, props) {
  renderSlopeBar(dom.slopeBarFwd, props, 'fwd');
  renderSlopeBar(dom.slopeBarBwd, props, 'bwd');
}

function renderSlopeBar(container, props, direction) {
  if (!container) return;
  container.replaceChildren();

  // Slopes are stored as percent-of-length already (0–100). Anything left over
  // is "flat". Negative/NaN values get coerced to 0 via readNumber + clamp.
  const buckets = SLOPE_BUCKETS.map((b) => ({
    ...b,
    value: clamp01(readNumber(props[`slope_${b.id}_${direction}_pct`]) ?? 0),
  }));
  const usedPct = buckets.reduce((sum, b) => sum + b.value, 0);
  const flatPct = Math.max(0, 100 - usedPct);

  const segments = [
    { id: 'flat', label: 'flach', cls: 'slope-flat', value: flatPct },
    ...buckets,
  ];

  let nonEmpty = false;
  for (const seg of segments) {
    if (seg.value <= 0.01) continue;
    nonEmpty = true;
    const slice = document.createElement('span');
    slice.className = `slope-slice slope-slice-${seg.cls}`;
    slice.style.flexGrow = String(seg.value);
    slice.title = `${seg.label}: ${seg.value.toFixed(1)} %`;
    if (seg.value >= 8) {
      slice.textContent = `${Math.round(seg.value)}`;
    }
    container.appendChild(slice);
  }

  if (!nonEmpty) {
    const note = document.createElement('span');
    note.className = 'slope-slice-empty';
    note.textContent = 'keine Daten';
    container.appendChild(note);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────────────────

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}

function makeChip(text, variant) {
  const chip = document.createElement('span');
  chip.className = `segment-chip${variant ? ` segment-chip-${variant}` : ''}`;
  chip.textContent = text;
  return chip;
}

function labelHighway(value) {
  return HIGHWAY_LABELS[value] || value;
}

function colorForGradient(pct) {
  if (pct < 2) return '#1a9850';
  if (pct < 4) return '#66bd63';
  if (pct < 6) return '#fee08b';
  if (pct < 8) return '#fdae61';
  if (pct < 12) return '#f46d43';
  if (pct < 20) return '#d73027';
  return '#7a0177';
}

function readNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function formatDistance(distanceMeters) {
  if (!Number.isFinite(distanceMeters)) return '-';
  if (distanceMeters < 1000) return `${Math.round(distanceMeters)} m`;
  return `${(distanceMeters / 1000).toFixed(2)} km`;
}

function formatHeight(value) {
  if (!Number.isFinite(value)) return '-';
  return `${Math.round(value)} m`;
}
