import { decodeTerrariumElevation, lonLatToTileSample } from './terrarium.js';
import { createLruPromiseCache } from '../utils/lruPromiseCache.js';

// Z13 + 512px tiles ≈ 6 m horizontal resolution at DACH latitudes (~51°N).
// At our default 10 m sample spacing that's ~2 samples per terrain pixel,
// so the elevation profile resolves small slope changes instead of stepping
// across multiple samples sharing one pixel value (Z12 was ~12 m/px). Costs
// 4× the tile fetches per route — still cheap thanks to the LRU cache.
const TILE_ZOOM = 13;
const TILE_ENDPOINT = 'https://tiles.mapterhorn.com';
const TILE_CACHE_LIMIT = 64;

export function createMapterhornClient() {
  const tileCache = createLruPromiseCache(TILE_CACHE_LIMIT);

  return {
    async sampleProfile(samples) {
      const elevations = await Promise.all(
        samples.map((sample) => sampleElevationAtPoint(sample.lng, sample.lat))
      );

      return {
        elevations,
      };
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