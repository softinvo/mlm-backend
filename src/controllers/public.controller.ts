import { Request, Response } from 'express';
import { z } from 'zod';
import { isValidObjectId } from 'mongoose';
import { cashbackDays, getCashbackSettings } from '../services/cashback.service';
import { AuditLog, CommissionPlan, ContactMessage, FranchiseTier, GalleryPhoto, Package, Product } from '../models';
import { deleteStoredImage, isStoredUrl } from '../services/storage.service';
import { HttpError } from '../utils/http';

/** What the public website shows: the live catalog (names, pictures, prices) and the current commission levels. No sign-in needed, nothing private. */
export const publicCatalog = async (_req: Request, res: Response) => {
  const [packages, products, plan, tiers, cb] = await Promise.all([
    Package.find({ active: true }).sort({ pricePaise: 1 }).lean(),
    Product.find({ active: true }).sort({ name: 1 }).lean(),
    CommissionPlan.findOne({ active: true, effectiveFrom: { $lte: new Date() } }).sort({ effectiveFrom: -1 }).lean(),
    FranchiseTier.find({ active: true }).sort({ rank: 1, discountPercent: 1 }).lean(),
    getCashbackSettings(),
  ]);
  res.set('Cache-Control', 'no-cache'); // always revalidate (cheap 304) so an admin's edit shows up straight away
  res.json({
    packages: packages.map((p) => ({ id: p._id.toString(), name: p.name, description: p.description ?? '', pricePaise: p.pricePaise, imageUrl: p.imageUrl ?? '' })),
    products: products.map((p) => ({ id: p._id.toString(), name: p.name, description: p.description, pricePaise: p.mrpPaise, imageUrl: p.imageUrl ?? '' })),
    // purchase cashback: only while the head office has it switched on, so the website never advertises something that is not running
    cashback: cb.enabled ? { percentPerDay: cb.percentPerDay, days: cashbackDays(cb), totalPercent: Math.round(cb.percentPerDay * cashbackDays(cb) * 100) / 100, includesPackages: cb.includePackages } : null,
    // franchise plans (Mini, Standard, Premium...) for the public "Franchise plans" section: what each costs to start and what it earns
    plans: tiers.map((t) => ({ name: t.name, description: t.description ?? '', rank: t.rank ?? 1, discountPercent: t.discountPercent, investmentPaise: t.investmentPaise ?? 0, maxMembers: t.maxMembers ?? 0 })),
    plan: plan ? { levels: [...plan.levels].sort((a, b) => a.level - b.level).map((l) => ({ level: l.level, percent: l.percent })), repurchaseLevels: [...(plan.repurchaseLevels ?? [])].sort((a, b) => a.level - b.level).map((l) => ({ level: l.level, percent: l.percent })) } : null,
  });
};

const contactSchema = z.object({
  name: z.string().trim().min(2, 'Please enter your name').max(80),
  email: z.string().trim().email('Please enter a valid email address').max(120),
  phone: z.string().trim().regex(/^[6-9]\d{9}$/, 'Enter a valid 10-digit mobile number').optional().or(z.literal('')),
  subject: z.string().trim().max(120).optional(),
  message: z.string().trim().min(10, 'Please write a little more so we can help').max(4000),
});

export const submitContact = async (req: Request, res: Response) => {
  if (typeof req.body?.website === 'string' && req.body.website.trim()) return res.json({ ok: true }); // a bot filled the hidden field: pretend it worked so it doesn't adapt
  const b = contactSchema.parse(req.body);
  await ContactMessage.create({ ...b, phone: b.phone || undefined });
  res.status(201).json({ ok: true });
};

// ───────── head office ─────────

export const adminEnquiries = async (req: Request, res: Response) => {
  const q = z.object({ page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(50).default(15), status: z.enum(['NEW', 'HANDLED']).optional() }).parse(req.query);
  const filter = q.status ? { status: q.status } : {};
  const [rows, total, fresh] = await Promise.all([ContactMessage.find(filter).sort({ createdAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(), ContactMessage.countDocuments(filter), ContactMessage.countDocuments({ status: 'NEW' })]);
  res.json({ items: rows.map((m) => ({ id: m._id.toString(), name: m.name, email: m.email, phone: m.phone ?? null, subject: m.subject ?? null, message: m.message, status: m.status, createdAt: m.createdAt, handledAt: m.handledAt ?? null })), total, page: q.page, limit: q.limit, pages: Math.max(1, Math.ceil(total / q.limit)), newCount: fresh });
};

export const handleEnquiry = async (req: Request, res: Response) => {
  const m = await ContactMessage.findByIdAndUpdate(req.params.id, { $set: { status: 'HANDLED', handledBy: req.auth!.userId, handledAt: new Date() } }, { new: true });
  if (!m) throw new HttpError(404, 'Message not found');
  await AuditLog.create({ actorId: req.auth!.userId, action: 'ENQUIRY_HANDLED', entity: 'ContactMessage', entityId: m._id });
  res.json({ id: m._id.toString(), status: m.status });
};

// ───────── Photo gallery ─────────

export const publicGallery = async (_req: Request, res: Response) => {
  const rows = await GalleryPhoto.find({ active: true }).sort({ order: 1, createdAt: 1 }).lean();
  res.set('Cache-Control', 'no-cache'); // always revalidate (cheap 304) so an admin's edit shows up straight away
  res.json({ items: rows.map((p) => ({ id: p._id.toString(), url: p.imageUrl, caption: p.caption ?? '' })) });
};

const view = (p: any) => ({ id: p._id.toString(), url: p.imageUrl, caption: p.caption ?? '', active: p.active, order: p.order, createdAt: p.createdAt });
const oid = (req: Request) => { const id = req.params.id as string; if (!isValidObjectId(id)) throw new HttpError(404, 'Photo not found'); return id; };

export const adminGallery = async (_req: Request, res: Response) => {
  const rows = await GalleryPhoto.find().sort({ order: 1, createdAt: 1 }).lean();
  res.json({ items: rows.map(view), shown: rows.filter((r) => r.active).length });
};

export const addGalleryPhoto = async (req: Request, res: Response) => {
  const b = z.object({ imageUrl: z.string().trim().max(500), caption: z.string().trim().max(140).optional() }).parse(req.body);
  if (!isStoredUrl(b.imageUrl, 'gallery')) throw new HttpError(400, 'Upload the photo through the app (it must be stored in your bucket).');
  const last = await GalleryPhoto.findOne().sort({ order: -1 }).select('order').lean();
  const p = await GalleryPhoto.create({ imageUrl: b.imageUrl, caption: b.caption ?? '', order: (last?.order ?? 0) + 1 });
  await AuditLog.create({ actorId: req.auth!.userId, action: 'GALLERY_ADDED', entity: 'GalleryPhoto', entityId: p._id });
  res.status(201).json(view(p));
};

export const updateGalleryPhoto = async (req: Request, res: Response) => {
  const b = z.object({ caption: z.string().trim().max(140).optional(), active: z.boolean().optional() }).parse(req.body);
  const p = await GalleryPhoto.findByIdAndUpdate(oid(req), { $set: b }, { new: true });
  if (!p) throw new HttpError(404, 'Photo not found');
  await AuditLog.create({ actorId: req.auth!.userId, action: 'GALLERY_UPDATED', entity: 'GalleryPhoto', entityId: p._id, after: b });
  res.json(view(p));
};

/** The admin sends every photo id in the order they want; unknown or missing ids are rejected so the order can't get corrupted. */
export const reorderGallery = async (req: Request, res: Response) => {
  const { ids } = z.object({ ids: z.array(z.string().length(24)).min(1).max(500) }).parse(req.body);
  const existing = await GalleryPhoto.find().select('_id').lean();
  if (ids.length !== existing.length || new Set(ids).size !== ids.length || !existing.every((e) => ids.includes(e._id.toString()))) throw new HttpError(400, 'The list is out of date. Refresh and try again.');
  await GalleryPhoto.bulkWrite(ids.map((id, i) => ({ updateOne: { filter: { _id: id }, update: { $set: { order: i + 1 } } } })));
  res.json({ ok: true });
};

export const deleteGalleryPhoto = async (req: Request, res: Response) => {
  const p = await GalleryPhoto.findByIdAndDelete(oid(req));
  if (!p) throw new HttpError(404, 'Photo not found');
  await AuditLog.create({ actorId: req.auth!.userId, action: 'GALLERY_DELETED', entity: 'GalleryPhoto', entityId: p._id });
  void deleteStoredImage(p.imageUrl);
  res.json({ ok: true });
};
