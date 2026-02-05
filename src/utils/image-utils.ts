/**
 * @file image-utils.ts
 * @description Utilities for fetching, decoding, encoding, and downloading images in the browser.
 */

/**
 * Encodes an array of float4 pixels into a PNG and triggers a browser download.
 */
export async function encodeAndDownloadImage(data: number[][], width: number, height: number, filename: string) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not get canvas context');

  const imageData = ctx.createImageData(width, height);
  const pixels = imageData.data;

  for (let i = 0; i < data.length; i++) {
    const pixel = data[i];
    const idx = i * 4;
    pixels[idx] = Math.max(0, Math.min(255, Math.floor(pixel[0] * 255)));
    pixels[idx + 1] = Math.max(0, Math.min(255, Math.floor(pixel[1] * 255)));
    pixels[idx + 2] = Math.max(0, Math.min(255, Math.floor(pixel[2] * 255)));
    pixels[idx + 3] = Math.max(0, Math.min(255, Math.floor((pixel[3] ?? 1.0) * 255)));
  }

  ctx.putImageData(imageData, 0, 0);

  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('Could not create blob');

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
