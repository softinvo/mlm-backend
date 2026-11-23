import { isStoredUrl } from '../services/storage.service';
import bcrypt from 'bcryptjs';
import { Request, Response } from 'express';
import { isValidObjectId, Types } from 'mongoose';
import { z } from 'zod';
import { AuditLog, Franchise, FranchiseTier, Member, Order, Package, Product, User, Wallet } from '../models';
import { HttpError } from '../utils/http';

const oid = (req: Request, name = 'id') => {
  const v = req.params[name] as string;
  if (!isValidObjectId(v)) throw new HttpError(404, 'Not found');
  return v;
};
const audit = (req: Request, action: string, entity: string, entityId: unknown, after?: unknown) =>
  AuditLog.create({ actorId: req.auth!.userId, action, entity, entityId, after });
const dup = (e: any, msg: string): never => { throw e?.code === 11000 ? new HttpError(409, msg) : e; };

// ───────── Franchise tiers (size types) ─────────

// No defaults in the shape: a PATCH that changes one field must not reset the others (zod re-applies defaults to omitted fields). Defaults are added for create only.
const tierFields = {
  name: z.string().trim().min(2).max(40),
  description: z.string().trim().max(200),
  discountPercent: z.number().min(0).max(50),
  rank: z.number().int().min(1).max(9),
  investmentPaise: z.number().int().min(0).max(100_000_000_000),
  maxMembers: z.number().int().min(0).max(1_000_000),
  dailyWalletSalesLimitPaise: z.number().int().min(0),
};
const createTierSchema = z.object({
  ...tierFields, description: tierFields.description.default(''), rank: tierFields.rank.default(1), investmentPaise: tierFields.investmentPaise.default(0),
  maxMembers: tierFields.maxMembers.default(0), dailyWalletSalesLimitPaise: tierFields.dailyWalletSalesLimitPaise.default(0),
});

export const listTiers = async (_req: Request, res: Response) => {
  const [tiers, counts] = await Promise.all([FranchiseTier.find().sort({ rank: 1, discountPercent: 1, name: 1 }).lean(), Franchise.aggregate([{ $group: { _id: '$tierId', n: { $sum: 1 } } }])]);
  res.json({ items: tiers.map((t) => ({ id: t._id.toString(), name: t.name, description: t.description, rank: t.rank ?? 1, discountPercent: t.discountPercent, investmentPaise: t.investmentPaise ?? 0, maxMembers: t.maxMembers, dailyWalletSalesLimitPaise: t.dailyWalletSalesLimitPaise, active: t.active, franchises: counts.find((c) => t._id.equals(c._id))?.n ?? 0 })) });
};
export const createTier = async (req: Request, res: Response) => {
  const b = createTierSchema.parse(req.body);
  const t = await FranchiseTier.create(b).catch((e) => dup(e, 'A tier with that name already exists'));
  await audit(req, 'TIER_CREATED', 'FranchiseTier', t._id, b);
  res.status(201).json({ id: t._id.toString() });
};
export const updateTier = async (req: Request, res: Response) => {
  const b = z.object({ ...tierFields, active: z.boolean() }).partial().parse(req.body);
  const t = await FranchiseTier.findByIdAndUpdate(oid(req), { $set: b }, { new: true }).catch((e) => dup(e, 'A tier with that name already exists'));
  if (!t) throw new HttpError(404, 'Tier not found');
  await audit(req, 'TIER_UPDATED', 'FranchiseTier', t._id, b);
  res.json({ id: t._id.toString() });
};

// ───────── Catalog: joining packages and repurchase products ─────────

const money = z.number().int().min(0).max(100_000_000);
/** A picture uploaded to OUR bucket (see storage.service), or empty to remove it. */
const image = z.string().trim().max(500).refine((u) => u === '' || isStoredUrl(u), 'Upload the image through the app (it must be stored in your bucket)');
// Field shapes carry no defaults: a PATCH that only changes one field must not reset the others. Creating fills defaults in below.
const pkgFields = { name: z.string().trim().min(2).max(60), description: z.string().trim().max(500), pricePaise: money, taxPercent: z.number().min(0).max(100), imageUrl: image };
const prodFields = { sku: z.string().trim().toUpperCase().regex(/^[A-Z0-9\-]{2,30}$/, 'SKU: 2 to 30 letters, digits or dashes'), name: z.string().trim().min(2).max(80), description: z.string().trim().min(1).max(500), pricePaise: money, taxPercent: z.number().min(0).max(100), commissionable: z.boolean(), imageUrl: image };
const createPkg = z.object({ ...pkgFields, description: pkgFields.description.default(''), taxPercent: pkgFields.taxPercent.default(0), imageUrl: image.default('') });
const createProd = z.object({ ...prodFields, taxPercent: prodFields.taxPercent.default(0), commissionable: prodFields.commissionable.default(true), imageUrl: image.default('') });

export const adminCatalog = async (_req: Request, res: Response) => {
  const [pk, pr] = await Promise.all([Package.find().sort({ pricePaise: 1 }).lean(), Product.find().sort({ name: 1 }).lean()]);
  res.json({
    packages: pk.map((p) => ({ id: p._id.toString(), kind: 'JOINING', name: p.name, description: p.description ?? '', pricePaise: p.pricePaise, taxPercent: p.taxPercent ?? 0, imageUrl: p.imageUrl ?? '', active: p.active })),
    products: pr.map((p) => ({ id: p._id.toString(), kind: 'REPURCHASE', sku: p.sku, name: p.name, description: p.description, pricePaise: p.mrpPaise, taxPercent: p.taxPercent, commissionable: p.commissionable, imageUrl: p.imageUrl ?? '', active: p.active })),
  });
};
export const createPackage = async (req: Request, res: Response) => {
  const b = createPkg.parse(req.body);
  const p = await Package.create(b).catch((e) => dup(e, 'A package with that name already exists'));
  await audit(req, 'PACKAGE_CREATED', 'Package', p._id, b);
  res.status(201).json({ id: p._id.toString() });
};
export const updatePackage = async (req: Request, res: Response) => {
  const b = z.object({ ...pkgFields, active: z.boolean() }).partial().parse(req.body);
  const p = await Package.findByIdAndUpdate(oid(req), { $set: b }, { new: true }).catch((e) => dup(e, 'A package with that name already exists'));
  if (!p) throw new HttpError(404, 'Package not found');
  await audit(req, 'PACKAGE_UPDATED', 'Package', p._id, b); // past orders keep the price they were bought at
  res.json({ id: p._id.toString() });
};
export const createProduct = async (req: Request, res: Response) => {
  const b = createProd.parse(req.body);
  const { pricePaise, ...rest } = b;
  const p = await Product.create({ ...rest, mrpPaise: pricePaise }).catch((e) => dup(e, 'A product with that SKU already exists'));
  await audit(req, 'PRODUCT_CREATED', 'Product', p._id, b);
  res.status(201).json({ id: p._id.toString() });
};
export const updateProduct = async (req: Request, res: Response) => {
  const { pricePaise, ...b } = z.object({ ...prodFields, active: z.boolean() }).partial().parse(req.body);
  const p = await Product.findByIdAndUpdate(oid(req), { $set: { ...b, ...(pricePaise !== undefined ? { mrpPaise: pricePaise } : {}) } }, { new: true }).catch((e) => dup(e, 'A product with that SKU already exists'));
  if (!p) throw new HttpError(404, 'Product not found');
  await audit(req, 'PRODUCT_UPDATED', 'Product', p._id, b);
  res.json({ id: p._id.toString() });
};

// ───────── Members ─────────

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const listMembersAdmin = async (req: Request, res: Response) => {
  const q = z.object({
    page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(20),
    search: z.string().trim().max(50).optional(), status: z.enum(['ACTIVE', 'SUSPENDED', 'PENDING', 'TERMINATED']).optional(),
    franchiseId: z.string().length(24).optional(),
  }).parse(req.query);
  const rx = q.search ? { $regex: escape(q.search), $options: 'i' } : null;
  const [r] = await Member.aggregate([
    { $match: q.franchiseId ? { franchiseId: new Types.ObjectId(q.franchiseId) } : {} },
    { $lookup: { from: User.collection.name, localField: 'userId', foreignField: '_id', as: 'u', pipeline: [{ $project: { name: 1, email: 1, phone: 1, status: 1, kyc: 1 } }] } },
    { $unwind: '$u' },
    ...(q.status ? [{ $match: { 'u.status': q.status } }] : []),
    ...(rx ? [{ $match: { $or: [{ 'u.name': rx }, { memberCode: rx }, { 'u.email': rx }, { 'u.phone': rx }] } }] : []),
    { $sort: { joinedAt: -1, _id: -1 } },
    { $facet: {
      items: [
        { $skip: (q.page - 1) * q.limit }, { $limit: q.limit },
        { $lookup: { from: Franchise.collection.name, localField: 'franchiseId', foreignField: '_id', as: 'f', pipeline: [{ $project: { code: 1, name: 1 } }] } },
        { $lookup: { from: Wallet.collection.name, localField: 'userId', foreignField: 'userId', as: 'w', pipeline: [{ $project: { type: 1, balancePaise: 1 } }] } },
        { $project: {
          _id: 0, userId: { $toString: '$userId' }, memberCode: 1, rank: 1, joinedAt: 1, name: '$u.name', email: '$u.email', phone: '$u.phone', status: '$u.status',
          kycStatus: { $ifNull: ['$u.kyc.status', 'NOT_SUBMITTED'] }, franchiseCode: { $arrayElemAt: ['$f.code', 0] },
          incomePaise: { $ifNull: [{ $arrayElemAt: [{ $map: { input: { $filter: { input: '$w', cond: { $eq: ['$$this.type', 'INCOME'] } } }, in: '$$this.balancePaise' } }, 0] }, 0] },
          shoppingPaise: { $ifNull: [{ $arrayElemAt: [{ $map: { input: { $filter: { input: '$w', cond: { $eq: ['$$this.type', 'SHOPPING'] } } }, in: '$$this.balancePaise' } }, 0] }, 0] },
        } },
      ],
      total: [{ $count: 'n' }],
    } },
  ]);
  const total = r?.total[0]?.n ?? 0;
  res.json({ items: r?.items ?? [], total, page: q.page, limit: q.limit, pages: Math.max(1, Math.ceil(total / q.limit)) });
};

export const memberDetail = async (req: Request, res: Response) => {
  const userId = oid(req, 'userId');
  const [u, m] = await Promise.all([User.findById(userId), Member.findOne({ userId })]);
  if (!u || !m || u.role !== 'MEMBER') throw new HttpError(404, 'Member not found');
  const [sponsor, sponsorUser, fr, wallets, directs, downline, orders, recent] = await Promise.all([
    m.sponsorId ? Member.findById(m.sponsorId).select('memberCode userId') : null,
    m.sponsorId ? Member.findById(m.sponsorId).then((s) => s && User.findById(s.userId).select('name')) : null,
    Franchise.findById(m.franchiseId).select('code name type'),
    Wallet.find({ userId }).select('type balancePaise').lean(),
    Member.countDocuments({ sponsorId: m._id }),
    Member.countDocuments({ upline: m._id }),
    Order.countDocuments({ buyerId: userId }),
    Order.find({ buyerId: userId }).sort({ createdAt: -1 }).limit(5).select('status totalPaise createdAt').lean(),
  ]);
  res.json({
    userId, name: u.name, email: u.email, phone: u.phone, status: u.status, createdAt: u.createdAt, kycStatus: u.kyc?.status ?? 'NOT_SUBMITTED',
    memberCode: m.memberCode, rank: m.rank, joinedAt: m.joinedAt,
    sponsor: sponsor ? { memberCode: sponsor.memberCode, name: sponsorUser?.name ?? null } : null,
    franchise: fr ? { code: fr.code, name: fr.name, type: fr.type } : null,
    wallets: { income: wallets.find((w) => w.type === 'INCOME')?.balancePaise ?? 0, shopping: wallets.find((w) => w.type === 'SHOPPING')?.balancePaise ?? 0 },
    team: { directs, downline }, orders: { count: orders, recent: recent.map((o) => ({ id: o._id.toString(), status: o.status, totalPaise: o.totalPaise, createdAt: o.createdAt })) },
  });
};

export const setMemberStatus = async (req: Request, res: Response) => {
  const userId = oid(req, 'userId');
  const b = z.object({ status: z.enum(['ACTIVE', 'SUSPENDED']), reason: z.string().trim().max(200).optional() }).parse(req.body);
  if (b.status === 'SUSPENDED' && !b.reason) throw new HttpError(400, 'Add a reason for suspending this member');
  const u = await User.findOneAndUpdate({ _id: userId, role: 'MEMBER' }, { $set: { status: b.status } }, { new: true });
  if (!u) throw new HttpError(404, 'Member not found');
  await audit(req, b.status === 'SUSPENDED' ? 'MEMBER_SUSPENDED' : 'MEMBER_REACTIVATED', 'User', u._id, b);
  res.json({ userId, status: u.status });
};

export const resetMemberPassword = async (req: Request, res: Response) => {
  const userId = oid(req, 'userId');
  const { password } = z.object({ password: z.string().min(8).max(72).regex(/[A-Za-z]/, 'Include a letter').regex(/\d/, 'Include a number') }).parse(req.body);
  const u = await User.findOneAndUpdate({ _id: userId, role: 'MEMBER' }, { $set: { passwordHash: await bcrypt.hash(password, 12) } });
  if (!u) throw new HttpError(404, 'Member not found');
  await audit(req, 'MEMBER_PASSWORD_RESET', 'User', u._id);
  res.json({ ok: true });
};
