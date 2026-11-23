/**
 * Image storage on Cloudflare R2 (or any S3-compatible bucket). The browser uploads straight to the bucket with a short-lived
 * signed URL, so image bytes never pass through this server. Credentials stay on the server.
 */
import { randomUUID } from 'node:crypto';
import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../config/env';
import { HttpError } from '../utils/http';

/** Images only. (SVG is left out on purpose: it can carry scripts.) */
export const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };
export const UPLOAD_FOLDERS = ['package', 'product', 'support', 'gallery', 'site'] as const;
export type UploadFolder = (typeof UPLOAD_FOLDERS)[number];
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const EXPIRES_SECONDS = 600; // the signed URL is valid for 10 minutes

export const storageConfigured = () => !!(env.R2_S3_API_URL && env.R2_API_KEY_ID && env.R2_API_ACCESS_TOKEN && env.BUCKET_NAME && env.STORAGE_URL);

let client: S3Client | null = null;
const s3 = () => (client ??= new S3Client({ region: 'auto', endpoint: env.R2_S3_API_URL, forcePathStyle: true, credentials: { accessKeyId: env.R2_API_KEY_ID!, secretAccessKey: env.R2_API_ACCESS_TOKEN! } }));

const base = () => (env.STORAGE_URL ?? '').replace(/\/+$/, '');

/** True only for files in OUR bucket, so a catalog item can't point at somebody else's site. */
export const isStoredUrl = (url: string, folder?: UploadFolder) => storageConfigured() && url.startsWith(`${base()}/${folder ? `${folder}/` : ''}`) && !url.includes('..');

export async function presignImageUpload(folder: UploadFolder, extension: string) {
  if (!storageConfigured()) throw new HttpError(503, 'Image uploads are not set up yet. Add the R2 settings to the server environment.');
  const contentType = IMAGE_TYPES[extension.toLowerCase()];
  if (!contentType) throw new HttpError(400, `Image must be one of: ${Object.keys(IMAGE_TYPES).join(', ')}`);
  const name = randomUUID();
  const key = `${folder}/${name}.${extension.toLowerCase()}`;
  // The content type is part of the signature: the browser must upload exactly this type, so a script can't be smuggled in as an "image".
  const uploadUrl = await getSignedUrl(s3(), new PutObjectCommand({ Bucket: env.BUCKET_NAME, Key: key, ContentType: contentType }), { expiresIn: EXPIRES_SECONDS });
  return { uploadUrl, downloadUrl: `${base()}/${key}`, key, contentType, maxBytes: MAX_IMAGE_BYTES, expiresInSeconds: EXPIRES_SECONDS };
}

/** Removes a file we stored (best effort: a failure only leaves an unused file in the bucket). */
export async function deleteStoredImage(url: string) {
  if (!storageConfigured() || !url.startsWith(`${base()}/`)) return;
  const key = url.slice(base().length + 1);
  if (!/^[a-z]+\/[0-9a-f-]{36}\.[a-z0-9]{2,5}$/.test(key)) return; // only names we generated
  try { await s3().send(new DeleteObjectCommand({ Bucket: env.BUCKET_NAME, Key: key })); } catch { /* ignore */ }
}
