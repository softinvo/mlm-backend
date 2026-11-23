import bcrypt from 'bcryptjs';
import { Request, Response } from 'express';
import { isValidObjectId, Types } from 'mongoose';
import { z } from 'zod';
import { AuditLog, Franchise, FranchiseTier, Member, Order, User, Wallet, Zone } from '../models';
import { kycDetail, listKyc, listOrders, ORDER_TAB_KEYS, overview } from '../services/franchise.service';
import { assertCanManage, assertTierChangeAllowed, descendantsOf } from '../services/hierarchy.service';
import { adminSummary } from '../services/support.service';
import { HttpError } from '../utils/http';
import { withTx } from '../utils/tx';

export const adminOverview = async (req: Request, res: Response) => {
  const support = await adminSummary(req.auth!.userId);
  const [o, franchises, admins] = await Promise.all([overview(null), Franchise.countDocuments({ active: true }), User.countDocuments({ role: 'SUPER_ADMIN' })]);
  res.json({ ...o, counts: { ...o.counts, supportOpen: support.needsReply }, franchiseCount: franchises, adminCount: admins, adminMax: Number(process.env.ADMIN_MAX ?? 2) });
};

export const adminOrders = async (req: Request, res: Response) => {
  const q = z.object({
    page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(20),
    tab: z.enum(ORDER_TAB_KEYS as [string, ...string[]]).default('awaiting'),
  }).parse(req.query);
  res.json(await listOrders(null, q));
};

export const adminKyc = async (req: Request, res: Response) => {
  const q = z.object({ page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(20), status: z.enum(['PENDING', 'VERIFIED', 'REJECTED']).optional() }).parse(req.query);
  res.json(await listKyc(null, q));
};

export const adminKycView = async (req: Request, res: Response) => {
  const userId = req.params.userId as string;
  if (!isValidObjectId(userId)) throw new HttpError(404, 'Not found');
  const d = await kycDetail(null, userId);
  await AuditLog.create({ actorId: req.auth!.userId, action: 'KYC_VIEWED', entity: 'User', entityId: userId });
  res.json(d);
};

// ───────── Franchises ─────────

const createSchema = z.object({
  name: z.string().trim().min(2).max(80),
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9\-]{3,20}$/, 'Code: 3 to 20 letters, digits or dashes'),
  address: z.string().trim().min(3).max(200),
  gstin: z.string().trim().toUpperCase().regex(/^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9]Z[A-Z0-9]$/, 'Enter a valid GSTIN').optional().or(z.literal('')),
  tierId: z.string().length(24, 'Choose a plan'),               // the plan decides discount, limits and who it can manage
  zoneName: z.string().trim().min(2).max(60).optional(),      // top-level franchise: the zone it runs (created if new)
  states: z.array(z.string().trim()).max(40).optional(),
  parentId: z.string().length(24).optional(),                  // the franchise that manages this one (must be on a higher plan); empty = head office
  type: z.enum(['ZONAL', 'REMOTE']).optional(),                // legacy, ignored: derived from parentId
  owner: z.object({
    name: z.string().trim().min(2).max(80), email: z.string().email(),
    phone: z.string().regex(/^[6-9]\d{9}$/, 'Enter a valid 10-digit mobile number'),
    password: z.string().min(8).max(72),
  }),
});

export const createFranchise = async (req: Request, res: Response) => {
  const b = createSchema.parse(req.body);
  const tier = await FranchiseTier.findOne({ _id: b.tierId, active: true });
  if (!tier) throw new HttpError(400, 'Choose an active plan');
  let zoneId: Types.ObjectId;
  let parentId: Types.ObjectId | undefined;
  if (b.parentId) {
    const parent = await assertCanManage(b.parentId, tier._id);
    zoneId = parent.zoneId; parentId = parent._id;
  } else {
    if (!b.zoneName) throw new HttpError(400, 'Enter the zone this franchise will run');
    const z = await Zone.findOneAndUpdate({ name: b.zoneName }, { $setOnInsert: { name: b.zoneName, states: b.states ?? [] } }, { upsert: true, new: true });
    zoneId = z._id;
  }
  const type = parentId ? 'REMOTE' : 'ZONAL';
  if (await Franchise.exists({ code: b.code })) throw new HttpError(409, 'That franchise code is already in use');
  if (await User.exists({ $or: [{ email: b.owner.email.toLowerCase() }, { phone: b.owner.phone }] })) throw new HttpError(409, 'That email or mobile number is already registered');

  const result = await withTx(async (session) => {
    const [owner] = await User.create([{
      role: type === 'ZONAL' ? 'ZONAL_FRANCHISE' : 'REMOTE_FRANCHISE', status: 'ACTIVE', name: b.owner.name, email: b.owner.email, phone: b.owner.phone,
      passwordHash: await bcrypt.hash(b.owner.password, 12),
    }], { session });
    await Wallet.create([{ userId: owner._id, type: 'INCOME' }], { session });
    const [fr] = await Franchise.create([{
      type, code: b.code, name: b.name, zoneId, parentId, ownerUserId: owner._id, address: b.address, gstin: b.gstin || undefined, tierId: tier._id,
    }], { session });
    return { franchiseId: fr._id.toString(), ownerUserId: owner._id.toString() };
  });
  await AuditLog.create({ actorId: req.auth!.userId, action: 'FRANCHISE_CREATED', entity: 'Franchise', entityId: result.franchiseId, after: { code: b.code, tier: tier.name, parent: b.parentId ?? null } });
  res.status(201).json(result);
};

export const listFranchises = async (_req: Request, res: Response) => {
  const [frs, counts, tiers] = await Promise.all([
    Franchise.find().sort({ code: 1 }).lean(),
    Member.aggregate([{ $group: { _id: '$franchiseId', n: { $sum: 1 } } }]),
    FranchiseTier.find().lean(),
  ]);
  const owners = await User.find({ _id: { $in: frs.map((f) => f.ownerUserId) } }).select('name email phone').lean();
  const tierOf = (id?: Types.ObjectId | null) => (id ? tiers.find((x) => x._id.equals(id)) : undefined);
  // Order as a tree: each franchise directly under the one that manages it.
  const byParent = new Map<string, typeof frs>();
  for (const f of frs) { const k = f.parentId ? String(f.parentId) : ''; byParent.set(k, [...(byParent.get(k) ?? []), f]); }
  const ordered: { f: (typeof frs)[number]; depth: number }[] = [];
  const walk = (parent: string, depth: number) => { for (const f of byParent.get(parent) ?? []) { ordered.push({ f, depth }); walk(String(f._id), depth + 1); } };
  walk('', 0);
  for (const f of frs) if (!ordered.some((o) => o.f._id.equals(f._id))) ordered.push({ f, depth: 0 }); // orphans (parent missing)
  res.json({
    items: ordered.map(({ f, depth }) => {
      const o = owners.find((u) => u._id.equals(f.ownerUserId));
      const t = tierOf(f.tierId);
      const p = f.parentId ? frs.find((x) => x._id.equals(f.parentId!)) : undefined;
      return {
        id: f._id.toString(), type: f.type, code: f.code, name: f.name, active: f.active, address: f.address, depth,
        tier: t ? { id: t._id.toString(), name: t.name, rank: t.rank ?? 1 } : null,
        discountPercent: t?.discountPercent ?? 0, prepaidBalancePaise: f.prepaidBalancePaise ?? 0,
        parent: p ? { id: p._id.toString(), code: p.code, name: p.name } : null, manages: (byParent.get(String(f._id)) ?? []).length,
        members: counts.find((c) => f._id.equals(c._id))?.n ?? 0,
        owner: o ? { name: o.name, email: o.email, phone: o.phone } : null,
      };
    }),
  });
};

export const updateFranchise = async (req: Request, res: Response) => {
  const id = req.params.id as string;
  if (!isValidObjectId(id)) throw new HttpError(404, 'Franchise not found');
  const b = z.object({
    active: z.boolean().optional(), tierId: z.string().length(24).optional(), name: z.string().trim().min(2).max(80).optional(), address: z.string().trim().min(3).max(200).optional(),
    parentId: z.string().length(24).nullable().optional(),   // move under another franchise, or null to make it report to the head office
  }).parse(req.body);
  const f = await Franchise.findById(id);
  if (!f) throw new HttpError(404, 'Franchise not found');
  if (b.tierId && !(await FranchiseTier.exists({ _id: b.tierId, active: true }))) throw new HttpError(400, 'Choose an active plan');

  const set: Record<string, unknown> = {};
  for (const k of ['active', 'name', 'address'] as const) if (b[k] !== undefined) set[k] = b[k];
  const newTier = b.tierId ?? f.tierId?.toString();
  if (b.tierId && b.tierId !== f.tierId?.toString()) { await assertTierChangeAllowed({ _id: f._id, parentId: b.parentId === undefined ? f.parentId : b.parentId ? new Types.ObjectId(b.parentId) : null }, b.tierId); set.tierId = b.tierId; }
  let newZone: Types.ObjectId | undefined;
  if (b.parentId !== undefined) {
    if (b.parentId === null) { set.parentId = null; set.type = 'ZONAL'; }
    else {
      const parent = await assertCanManage(b.parentId, newTier, f._id);
      set.parentId = parent._id; set.type = 'REMOTE'; newZone = parent.zoneId; set.zoneId = parent.zoneId;
    }
  }
  const updated = await Franchise.findByIdAndUpdate(id, { $set: set }, { new: true });
  if (!updated) throw new HttpError(404, 'Franchise not found');
  if (set.type) await User.updateOne({ _id: updated.ownerUserId }, { $set: { role: set.type === 'ZONAL' ? 'ZONAL_FRANCHISE' : 'REMOTE_FRANCHISE' } });
  if (newZone) { const below = await descendantsOf([updated._id]); if (below.length) await Franchise.updateMany({ _id: { $in: below.map((d) => d._id) } }, { $set: { zoneId: newZone } }); }
  await AuditLog.create({ actorId: req.auth!.userId, action: 'FRANCHISE_UPDATED', entity: 'Franchise', entityId: updated._id, before: { parentId: f.parentId, tierId: f.tierId }, after: b });
  res.json({ id: updated._id.toString(), active: updated.active, tierId: updated.tierId?.toString() ?? null, parentId: updated.parentId?.toString() ?? null });
};

void Order;
