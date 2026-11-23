import { Request, Response } from 'express';
import { AuditLog, SiteContent } from '../models';
import { DEFAULT_SITE } from '../services/site.defaults';
import { getSite, resetSite, saveSite, siteSchema } from '../services/site.service';

/** Public: what the website renders. */
export const publicSite = async (_req: Request, res: Response) => {
  res.set('Cache-Control', 'no-cache'); // always revalidate (cheap 304) so an admin's edit shows up straight away
  res.json((await getSite()).content);
};

// ───────── head office ─────────

export const adminSite = async (_req: Request, res: Response) => {
  const s = await getSite();
  res.json({ content: s.content, customised: s.customised, updatedAt: s.updatedAt, defaults: DEFAULT_SITE });
};

export const saveAdminSite = async (req: Request, res: Response) => {
  const content = siteSchema.parse(req.body); // zod errors become a clear 400 listing the field
  await saveSite(content, req.auth!.userId);
  const doc = await SiteContent.findOne({ key: 'site' });
  await AuditLog.create({ actorId: req.auth!.userId, action: 'SITE_UPDATED', entity: 'SiteContent', entityId: doc!._id });
  res.json({ ok: true, updatedAt: doc!.updatedAt });
};

export const resetAdminSite = async (req: Request, res: Response) => {
  const doc = await SiteContent.findOne({ key: 'site' });
  await resetSite();
  if (doc) await AuditLog.create({ actorId: req.auth!.userId, action: 'SITE_RESET', entity: 'SiteContent', entityId: doc._id });
  res.json({ ok: true });
};
