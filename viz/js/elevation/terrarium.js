export function decodeTerrariumElevation(red, green, blue) {
  return red * 256 + green + blue / 256 - 32768;
}

export function lonLatToTileSample(lng, lat, zoom, tileSize) {
  const latitudeRadians = (lat * Math.PI) / 180;
  const scale = 2 ** zoom;
  const normalizedX = ((lng + 180) / 360) * scale;
  const normalizedY =
    ((1 - Math.log(Math.tan(latitudeRadians) + 1 / Math.cos(latitudeRadians)) / Math.PI) / 2) * scale;

  const tileX = Math.floor(normalizedX);
  const tileY = Math.floor(normalizedY);
  const pixelX = Math.min(tileSize - 1, Math.max(0, Math.floor((normalizedX - tileX) * tileSize)));
  const pixelY = Math.min(tileSize - 1, Math.max(0, Math.floor((normalizedY - tileY) * tileSize)));

  return { tileX, tileY, pixelX, pixelY };
}