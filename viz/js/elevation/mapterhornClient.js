import { decodeTerrariumElevation, lonLatToTileSample } from './terrarium.js';
import { createLruPromiseCache } from '../utils/lruPromiseCache.js';

// Z13 + 512px tiles ≈ 6 m horizontal resolution at DACH latitudes (~51°N).
// At our default 10 m sample spacing that's ~2 samples per terrain pixel,
// so the elevation profile resolves small slope changes instead of stepping
// across multiple samples sharing one pixel value (Z12 was ~12 m/px). Costs
// 4× the tile fetches per route — still cheap thanks to the LRU cache.
const TILE_ZOOM = 13;
const TILE_ENDPOINT = 'https://tiles.mapterhorn.com';
// A single route can need ~10-15 z13 terrain tiles; 64 caused thrashing once
// the user hovered across 4-5 unrelated routes in quick succession (eviction
// storm → every revisit re-fetched and re-decoded). 256 keeps roughly the
// last ~20 distinct routes warm. Each cached entry is one ImageData (~1 MB
// at 512×512 RGBA), so worst-case ~256 MB. Browsers handle that comfortably.
const TILE_CACHE_LIMIT = 256;

export function createMapterhornClient() {
  const tileCache = createLruPromiseCache(TILE_CACHE_LIMIT);

  return {
    // Optional `signal` lets callers cancel the wait when the user hovers
    // on. We don't propagate the signal into the inner tile fetches because
    // those are shared via the LRU cache — letting them finish keeps the
    // cache warm for adjacent routes (the typical next hover).
    async sampleProfile(samples, { signal } = {}) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

      const elevationsPromise = Promise.all(
        samples.map((sample) => sampleElevationAtPoint(sample.lng, sample.lat))
      );

      if (!signal) {
        const elevations = await elevationsPromise;
        return { elevations };
      }

      const elevations = await new Promise((resolve, reject) => {
        const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
        signal.addEventListener('abort', onAbort, { once: true });
        elevationsPromise.then(
          (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
          (err)   => { signal.removeEventListener('abort', onAbort); reject(err); },
        );
      });
      return { elevations };
    },
  };

  async function sampleElevationAtPoint(lng, lat) {
    const tile = await getTileForCoordinate(lng, lat);
    const { pixelX, pixelY } = lonLatToTileSample(lng, lat, TILE_ZOOM, tile.size);
    const offset = (pixelY * tile.size + pixelX) * 4;
    const red = tile.imageData[offset];
    const green = tile.imageData[offset + 1];
    const blue = tile.imageData[offset + 2];

    return decodeTerrariumElevation(red, green, blue);
  }

  async function getTileForCoordinate(lng, lat) {
    const { tileX, tileY } = lonLatToTileSample(lng, lat, TILE_ZOOM, 512);
    const cacheKey = `${TILE_ZOOM}/${tileX}/${tileY}`;
    return tileCache.getOrCompute(cacheKey, () => loadTile(TILE_ZOOM, tileX, tileY));
  }

  async function loadTile(zoom, tileX, tileY) {
    const response = await fetch(`${TILE_ENDPOINT}/${zoom}/${tileX}/${tileY}.webp`);
    if (!response.ok) {
      throw new Error(`Mapterhorn tile ${zoom}/${tileX}/${tileY} konnte nicht geladen werden.`);
    }

    const blob = await response.blob();
    const bitmap = await createBitmap(blob);
    const canvas = createRasterCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d', { willReadFrequently: true });

    context.drawImage(bitmap, 0, 0);
    const imageData = context.getImageData(0, 0, bitmap.width, bitmap.height).data;

    return {
      size: bitmap.width,
      imageData,
    };
  }
}

async function createBitmap(blob) {
  if (typeof createImageBitmap === 'function') {
    return createImageBitmap(blob);
  }

  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Tile-Bitmap konnte nicht dekodiert werden.'));
    image.src = URL.createObjectURL(blob);
  });
}

function createRasterCanvas(width, height) {
  if (typeof OffscreenCanvas === 'function') {
    return new OffscreenCanvas(width, height);
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}