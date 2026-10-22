import { ApiError, invalid } from './errors.js';

const DATA_URL_RE = /^data:(image\/png|image\/jpeg|image\/webp|image\/gif);base64,([A-Za-z0-9+/]+={0,2})$/;

/** Allowed image media types the outlet accepts as data URLs. */
export const ALLOWED_IMAGE_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/**
 * Decode one bounded base64 data URL. Remote URLs are rejected outright to
 * prevent SSRF: third-party clients must convert images to data URLs first.
 * Pure (no I/O, no save).
 * @returns {{ mediaType: string, data: Uint8Array }}
 */
export function decodeImageDataUrl(url, { maxImageBytes }) {
  if (typeof url !== 'string' || url.length === 0) throw invalid('image_url must be a non-empty string.');
  if (!url.startsWith('data:')) {
    throw new ApiError(400, 'remote_image_url_rejected',
      'Only bounded base64 data URLs are accepted. Remote image URLs are rejected to prevent SSRF; convert the image to a data URL client-side.');
  }
  const m = DATA_URL_RE.exec(url);
  if (!m) throw invalid('image_url must be a base64 data URL of type image/png, image/jpeg, image/webp or image/gif.');
  const mediaType = m[1];
  const b64 = m[2];
  const decoded = Buffer.from(b64, 'base64');
  if (decoded.toString('base64') !== b64) throw invalid('Image data is not canonical base64.');
  if (decoded.length === 0) throw invalid('Image data is empty.');
  if (decoded.length > maxImageBytes) throw new ApiError(413, 'image_too_large', `Each image must be at most ${maxImageBytes} bytes.`);
  return { mediaType, data: new Uint8Array(decoded) };
}

/** Extract the data-URL string from one chat image_url part, or undefined. */
export function chatImageUrl(part) {
  if (part && part.type === 'image_url') {
    return typeof part.image_url === 'string' ? part.image_url
      : part.image_url && typeof part.image_url === 'object' ? part.image_url.url : null;
  }
  return undefined;
}

/** Extract the data-URL string from one responses input_image part, or undefined. */
export function responsesImageUrl(part) {
  if (part && part.type === 'input_image') {
    return part.image_url ?? part.url ?? null;
  }
  return undefined;
}

/**
 * Validate and admit an ordered batch of data-URL images with a REQUEST-LEVEL
 * budget. Every URL/MIME/base64/size check runs before any storage write; the
 * whole batch is then committed atomically via attachments.saveImages (the
 * real dsh-attachment-local contract: saveImages([{data, mediaType, name?}])).
 * A later non-conforming image therefore fails before any earlier image was
 * saved, and no partial refs are produced.
 * @param urls - ordered data-URL strings (chat image_url or responses input_image).
 * @returns durable refs in the same order.
 */
export async function admitImages(urls, ctx, cfg) {
  if (urls.length > cfg.maxImagesPerRequest) {
    throw new ApiError(413, 'too_many_images', `At most ${cfg.maxImagesPerRequest} images per request.`);
  }
  // 1. decode all (pure validation, zero side effects)
  const decoded = urls.map(url => decodeImageDataUrl(url, cfg));
  // 2. attachment service must be mounted before any save
  const attachments = ctx.get('attachments');
  if (!attachments) {
    throw new ApiError(502, 'attachments_unavailable', 'Host attachment service is not mounted; cannot admit image input.');
  }
  // 3. atomic batch commit via the real saveImages contract
  let refs;
  try {
    refs = await attachments.saveImages(decoded);
  } catch (e) {
    if (e?.code) throw new ApiError(400, e.code, 'Image rejected: ' + (e.message ?? e.code));
    throw e;
  }
  if (!Array.isArray(refs) || refs.length !== decoded.length) {
    throw new ApiError(502, 'attachments_unavailable', 'Attachment service returned an unexpected image reference set.');
  }
  return refs;
}
