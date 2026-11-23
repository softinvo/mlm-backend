import { Request, Response } from 'express';
import { isValidObjectId } from 'mongoose';
import { z } from 'zod';
import { AuditLog, Franchise, FranchiseTier, Member, User } from '../models';
import { HttpError } from '../utils/http';

/** Who am I? Lets any panel (member / franchise / admin) greet the user and show their franchise. */
export const whoAmI = async (req: Request, res: Response) => {
  const u = await User.findById(req.auth!.userId).select('name email role');
  if (!u) throw new HttpError(404, 'User not found');
  const franchises = u.role.endsWith('FRANCHISE')
    ? await Franchise.find({ $or: [{ ownerUserId: u._id }, { staffUserIds: u._id }] }).select('code name type').lean()
    : [];
  res.json({ userId: u._id.toString(), name: u.name, email: u.email, role: u.role, franchises: franchises.map((f) => ({ id: f._id.toString(), code: f.code, name: f.name, type: f.type })) });
};

/** The signed-in user's own profile (franchise owners also get their franchises; everyone gets their recent activity). */
export const getProfile = async (req: Request, res: Response) => {
  const u = await User.findById(req.auth!.userId).select('name email phone role createdAt');
  if (!u) throw new HttpError(404, 'User not found');

  let franchises: unknown[] = [];
  if (u.role.endsWith('FRANCHISE')) {
    const own = await Franchise.find({ $or: [{ ownerUserId: u._id }, { staffUserIds: u._id }] }).lean();
    const tiers = await FranchiseTier.find({ _id: { $in: own.map((f) => f.tierId).filter(Boolean) } }).lean();
    const parents = await Franchise.find({ _id: { $in: own.map((f) => f.parentId).filter(Boolean) } }).select('code name').lean();
    const counts = await Member.aggregate([{ $match: { franchiseId: { $in: own.map((f) => f._id) } } }, { $group: { _id: '$franchiseId', n: { $sum: 1 } } }]);
    const kids = await Franchise.find({ parentId: { $in: own.map((f) => f._id) } }).select('code name active parentId tierId').lean();
    const kidTiers = await FranchiseTier.find({ _id: { $in: kids.map((k) => k.tierId).filter(Boolean) } }).select('name').lean();
    franchises = own.map((f) => {
      const t = tiers.find((x) => f.tierId && x._id.equals(f.tierId));
      const p = parents.find((x) => f.parentId && x._id.equals(f.parentId));
      return {
        id: f._id.toString(), code: f.code, name: f.name, type: f.type, active: f.active, address: f.address, gstin: f.gstin ?? '', isOwner: f.ownerUserId.equals(u._id),
        parent: p ? { code: p.code, name: p.name } : null, manages: kids.filter((k) => k.parentId && f._id.equals(k.parentId)).map((k) => ({ code: k.code, name: k.name, active: k.active, plan: kidTiers.find((t) => k.tierId && t._id.equals(k.tierId))?.name ?? null })), members: counts.find((c) => f._id.equals(c._id))?.n ?? 0, prepaidBalancePaise: f.prepaidBalancePaise ?? 0,
        tier: t ? { name: t.name, rank: t.rank ?? 1, discountPercent: t.discountPercent, investmentPaise: t.investmentPaise ?? 0, maxMembers: t.maxMembers, dailyWalletSalesLimitPaise: t.dailyWalletSalesLimitPaise } : null,
      };
    });
  }
  const activity = await AuditLog.find({ actorId: u._id }).sort({ createdAt: -1 }).limit(40).select('action entity createdAt').lean();
  res.json({
    user: { name: u.name, email: u.email, phone: u.phone, role: u.role, createdAt: u.createdAt },
    franchises,
    activity: activity.map((a) => ({ id: a._id.toString(), action: a.action, entity: a.entity, at: a.createdAt })),
  });
};

const profileSchema = z.object({
  name: z.string().trim().min(2, 'Name is too short').max(80),
  phone: z.string().regex(/^[6-9]\d{9}$/, 'Enter a valid 10-digit Indian mobile number'),
});

export const updateProfile = async (req: Request, res: Response) => {
  const b = profileSchema.parse(req.body);
  const u = await User.findById(req.auth!.userId);
  if (!u) throw new HttpError(404, 'User not found');
  const before = { name: u.name, phone: u.phone };
  u.name = b.name;
  u.phone = b.phone;
  try {
    await u.save();
  } catch (e: any) {
    if (e?.code === 11000) throw new HttpError(409, 'This mobile number is already registered');
    throw e;
  }
  await AuditLog.create({ actorId: u._id, action: 'PROFILE_UPDATE', entity: 'User', entityId: u._id, before, after: b });
  res.json({ name: u.name, phone: u.phone });
};

const franchiseInfoSchema = z.object({
  address: z.string().trim().min(3, 'Enter the address').max(200),
  gstin: z.string().trim().toUpperCase().regex(/^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9]Z[A-Z0-9]$/, 'Enter a valid GSTIN').optional().or(z.literal('')),
});

/** A franchise owner can keep their franchise's address and GSTIN up to date. Name, code, tier and status stay with the head office. */
export const updateFranchiseInfo = async (req: Request, res: Response) => {
  const id = req.params.id as string;
  if (!isValidObjectId(id)) throw new HttpError(404, 'Franchise not found');
  const b = franchiseInfoSchema.parse(req.body);
  const f = await Franchise.findOneAndUpdate({ _id: id, ownerUserId: req.auth!.userId }, { $set: { address: b.address, gstin: b.gstin || undefined } }, { new: true });
  if (!f) throw new HttpError(404, 'Franchise not found');
  await AuditLog.create({ actorId: req.auth!.userId, action: 'FRANCHISE_INFO_UPDATED', entity: 'Franchise', entityId: f._id, after: b });
  res.json({ id: f._id.toString(), address: f.address, gstin: f.gstin ?? '' });
};
