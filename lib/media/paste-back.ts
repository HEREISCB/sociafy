import sharp from 'sharp';

/**
 * Masked-edit helpers for POST /api/v1/images.
 *
 * The provider treats a mask as guidance and regenerates every pixel, so "the
 * product stays exact" is only true if we put the product back ourselves. These
 * run on bytes that fetchReferenceImages has already vetted.
 */

/** Pixel dimensions with EXIF orientation applied — what a viewer shows, and
 *  what the caller built their mask against. null when sharp cannot read it. */
export async function orientedSize(buf: Buffer): Promise<{ width: number; height: number } | null> {
  try {
    const m = await sharp(buf).metadata();
    return m.autoOrient?.width && m.autoOrient.height ? m.autoOrient : null;
  } catch {
    return null;
  }
}

/** The image upright. Only re-encoded (as PNG) when EXIF actually rotates it, so
 *  an ordinary reference reaches the provider byte-for-byte as sent. */
export async function upright(file: File): Promise<File> {
  const buf = Buffer.from(await file.arrayBuffer());
  const { orientation } = await sharp(buf).metadata();
  if (!orientation || orientation === 1) return file;
  const png = await sharp(buf).autoOrient().png().toBuffer();
  return new File([new Uint8Array(png)], file.name.replace(/\.\w+$/, '.png'), { type: 'image/png' });
}

/**
 * Lay the reference's pixels back over the generated image wherever the mask is
 * opaque, using mask alpha as the blend weight — so alpha 255 is exactly the
 * reference, alpha 0 exactly the model, and a feathered edge is a smooth mix.
 *
 * The result is PNG at the reference's (oriented) dimensions: the generated
 * image is resized to it first, which is a no-op when `size` already matched
 * and a ≤1% stretch otherwise (checkMask refuses any larger aspect mismatch).
 * Throws on anything unexpected; the caller falls back to the raw output.
 */
export async function pasteBack(
  generated: Buffer,
  reference: Buffer,
  mask: Buffer,
): Promise<{ buf: Buffer; width: number; height: number }> {
  // Raw buffers rather than chained ops: sharp applies operations in its own
  // fixed order, not call order, so colourspace + joinChannel on one pipeline is
  // not something to rely on.
  const ref = await sharp(reference).autoOrient().removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = ref.info;
  const alpha = await sharp(mask).autoOrient().ensureAlpha().extractChannel(3).raw().toBuffer({ resolveWithObject: true });
  if (alpha.info.width !== width || alpha.info.height !== height) throw new Error('mask_reference_size_mismatch');

  const overlay = await sharp(ref.data, { raw: { width, height, channels } })
    .joinChannel(alpha.data, { raw: { width, height, channels: 1 } })
    .png()
    .toBuffer();
  const buf = await sharp(generated)
    .resize(width, height, { fit: 'fill' })
    .composite([{ input: overlay, blend: 'over' }])
    .png()
    .toBuffer();
  return { buf, width, height };
}
