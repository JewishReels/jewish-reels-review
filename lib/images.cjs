const fs = require('node:fs/promises');
const { retryIO, inputOperation, inputError } = require('./recovery.cjs');
function positions(size, edge, overlap) {
  if (size <= edge) return [0];
  const values = [];
  for (let start = 0; ; start += edge - overlap) {
    const pos = Math.min(start, size - edge);
    if (values.at(-1) !== pos) values.push(pos);
    if (pos + edge >= size) break;
  }
  return values;
}
function makeImageAdapter(nativeImage) {
  return async function prepareCard(filename, detail = true) {
    const bytes = await inputOperation(() => retryIO(() => fs.readFile(filename)));
    const img = nativeImage.createFromBuffer(bytes);
    if (img.isEmpty()) throw inputError('An image file cannot be decoded. It has not been marked reviewed.', { path: filename });
    const { width, height } = img.getSize();
    if (width * height > 100_000_000) throw inputError('Contact sheet exceeds 100 megapixels. Split it into smaller sheets first.', { path: filename });
    const regions = [];
    const edge = detail ? 1280 : Math.max(width, height);
    for (const top of positions(height, edge, 160)) for (const left of positions(width, edge, 160)) {
      const bounds = { x: left, y: top, width: Math.min(edge, width), height: Math.min(edge, height) };
      const data = img.crop(bounds).toJPEG(92);
      if (data.length > 7_000_000) throw inputError('Image region exceeds 7 MB. Enable detailed image regions or use smaller contact sheets.', { path: filename });
      regions.push({ data: data.toString('base64'), mime: 'image/jpeg', bounds, imageSize: { width, height } });
    }
    return regions;
  };
}
module.exports = { positions, makeImageAdapter };
