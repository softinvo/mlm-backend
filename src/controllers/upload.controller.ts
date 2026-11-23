import { Request, Response } from 'express';
import { z } from 'zod';
import { presignImageUpload } from '../services/storage.service';

const CATALOG_FOLDERS = ['package', 'product', 'gallery', 'site'] as const; // folders the admin may upload to

/** Step 1 of an upload: the admin asks for a signed URL, then the browser PUTs the image straight to the bucket. */
export const getUploadUrl = async (req: Request, res: Response) => {
  const b = z.object({
    extension: z.string({ message: 'extension is required' }).trim().toLowerCase().regex(/^[a-z0-9]{2,5}$/, 'extension is required'),
    type: z.enum(CATALOG_FOLDERS, { message: `type must be one of [${CATALOG_FOLDERS.join(', ')}]` }),
  }).parse(req.body);
  res.json({ success: true, ...(await presignImageUpload(b.type, b.extension)) });
};

/** A signed URL for a photo attached to a support ticket. Any signed-in member, franchise owner or admin may ask for one. */
export const getSupportUploadUrl = async (req: Request, res: Response) => {
  const b = z.object({ extension: z.string({ message: 'extension is required' }).trim().toLowerCase().regex(/^[a-z0-9]{2,5}$/, 'extension is required') }).parse(req.body);
  res.json({ success: true, ...(await presignImageUpload('support', b.extension)) });
};
