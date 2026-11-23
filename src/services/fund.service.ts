import { Types } from 'mongoose';
import { FundRequest, Member, PaymentMode, User } from '../models';
import { HttpError } from '../utils/http';
import { withTx } from '../utils/tx';
import { postEntry } from './ledger.service';

const num = (v: string | undefined, d: number) => (v !== undefined && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : d);
export const fundConfig = () => ({
  minPaise: num(process.env.FUND_MIN_PAISE, 10_000),         // ₹100
  maxPaise: num(process.env.FUND_MAX_PAISE, 5_000_000),      // ₹50,000
  maxOpen: num(process.env.FUND_MAX_OPEN, 3),
  maxAgeDays: 30,
});

/** The company account members pay into. Comes from env so it is never hard-coded; null when not configured. */
export function paymentInstructions() {
  const e = process.env;
  if (!e.PAYMENT_ACCOUNT_NUMBER && !e.PAYMENT_UPI_ID) return null;
  return {
    accountName: e.PAYMENT_ACCOUNT_NAME ?? null, accountNumber: e.PAYMENT_ACCOUNT_NUMBER ?? null,
    ifsc: e.PAYMENT_IFSC ?? null, bank: e.PAYMENT_BANK ?? null, upiId: e.PAYMENT_UPI_ID ?? null,
  };
}

export const normalizeRef = (r: string) => r.trim().toUpperCase().replace(/[\s\-\/]/g, '');
const DAY = 86_400_000;

export interface SubmitInput { amountPaise: number; mode: PaymentMode; reference: string; paidOn: Date; note?: string }

export async function submitFundRequest(userId: string, i: SubmitInput) {
  const cfg = fundConfig();
  const user = await User.findById(userId).select('status');
  if (!user || user.status !== 'ACTIVE') throw new HttpError(403, 'Your account cannot submit requests right now');
  if (!Number.isInteger(i.amountPaise) || i.amountPaise < cfg.minPaise) throw new HttpError(400, `Minimum top-up is ₹${cfg.minPaise / 100}`);
  if (i.amountPaise > cfg.maxPaise) throw new HttpError(400, `Maximum per request is ₹${cfg.maxPaise / 100}`);
  const now = Date.now();
  if (i.paidOn.getTime() > now + DAY) throw new HttpError(400, 'Payment date cannot be in the future');
  if (i.paidOn.getTime() < now - cfg.maxAgeDays * DAY) throw new HttpError(400, `Payment must be from the last ${cfg.maxAgeDays} days`);
  if ((await FundRequest.countDocuments({ userId, status: 'PENDING' })) >= cfg.maxOpen) {
    throw new HttpError(400, `You already have ${cfg.maxOpen} requests waiting. Wait for them to be reviewed or cancel one.`);
  }
  const refKey = normalizeRef(i.reference);
  try {
    const member = await Member.findOne({ userId }).select('franchiseId');
    return await FundRequest.create({ userId, franchiseId: member?.franchiseId, amountPaise: i.amountPaise, mode: i.mode, reference: i.reference.trim(), refKey, paidOn: i.paidOn, note: i.note });
  } catch (e: any) {
    if (e?.code === 11000) throw new HttpError(409, 'This payment reference has already been submitted');
    throw e;
  }
}

export async function cancelFundRequest(userId: string, id: string) {
  const r = await FundRequest.findOneAndUpdate(
    { _id: id, userId, status: 'PENDING' },
    { $set: { status: 'CANCELLED', holdsRef: false } },
    { new: true },
  );
  if (!r) {
    const exists = await FundRequest.exists({ _id: id, userId });
    throw new HttpError(exists ? 409 : 404, exists ? 'Only requests that are still waiting can be cancelled' : 'Request not found');
  }
  return r;
}

/** Head office: the bank statement matched. Credits the SHOPPING wallet exactly once. */
export async function approveFundRequest(id: string, adminId: string, opts: { approvedPaise?: number; note?: string } = {}) {
  return withTx(async (session) => {
    const req = await FundRequest.findById(id).session(session);
    if (!req) throw new HttpError(404, 'Request not found');
    const amount = opts.approvedPaise ?? req.amountPaise;
    if (!Number.isInteger(amount) || amount < 1 || amount > req.amountPaise) throw new HttpError(400, 'Approved amount must be between ₹0.01 and the requested amount');
    const claimed = await FundRequest.findOneAndUpdate(
      { _id: id, status: 'PENDING' },
      { $set: { status: 'APPROVED', approvedPaise: amount, reviewedBy: adminId, reviewedAt: new Date(), reviewNote: opts.note } },
      { new: true, session },
    );
    if (!claimed) throw new HttpError(409, 'This request has already been reviewed');
    await postEntry(session, {
      userId: claimed.userId, wallet: 'SHOPPING', amountPaise: amount, type: 'DEPOSIT', refType: 'FundRequest', refId: claimed._id,
      key: `deposit:${claimed._id}`, note: `Top-up ${claimed.mode.replace('_', ' ')} ref ${claimed.reference}`,
    });
    return claimed;
  });
}

export async function rejectFundRequest(id: string, adminId: string, reason: string) {
  const r = await FundRequest.findOneAndUpdate(
    { _id: id, status: 'PENDING' },
    { $set: { status: 'REJECTED', holdsRef: false, reviewedBy: adminId, reviewedAt: new Date(), reviewNote: reason } },
    { new: true },
  );
  if (!r) throw new HttpError(409, 'This request has already been reviewed');
  return r;
}

const row = (r: any) => ({
  id: r._id.toString(), createdAt: r.createdAt, amountPaise: r.amountPaise, approvedPaise: r.approvedPaise ?? null, mode: r.mode, reference: r.reference,
  paidOn: r.paidOn, note: r.note ?? null, status: r.status, reviewNote: r.reviewNote ?? null, reviewedAt: r.reviewedAt ?? null,
});

export async function listMemberFundRequests(userId: string, q: { status?: string; page: number; limit: number }) {
  const me = new Types.ObjectId(userId);
  const filter: Record<string, unknown> = { userId: me, ...(q.status ? { status: q.status } : {}) };
  const [rows, total, sums] = await Promise.all([
    FundRequest.find(filter).sort({ createdAt: -1, _id: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(),
    FundRequest.countDocuments(filter),
    FundRequest.aggregate([{ $match: { userId: me } }, { $group: { _id: '$status', n: { $sum: 1 }, requested: { $sum: '$amountPaise' }, credited: { $sum: { $ifNull: ['$approvedPaise', 0] } } } }]),
  ]);
  const by = (s: string) => sums.find((x) => x._id === s);
  return {
    items: rows.map(row), total, page: q.page, limit: q.limit, pages: Math.max(1, Math.ceil(total / q.limit)),
    summary: { creditedPaise: by('APPROVED')?.credited ?? 0, pendingPaise: by('PENDING')?.requested ?? 0, pendingCount: by('PENDING')?.n ?? 0 },
  };
}

export async function listAdminFundRequests(q: { status?: string; page: number; limit: number }) {
  const filter: Record<string, unknown> = q.status ? { status: q.status } : {};
  const [rows, total] = await Promise.all([
    FundRequest.find(filter).sort({ createdAt: 1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(),
    FundRequest.countDocuments(filter),
  ]);
  const users = await User.find({ _id: { $in: rows.map((r) => r.userId) } }).select('name email phone').lean();
  return {
    items: rows.map((r) => { const u = users.find((x) => x._id.equals(r.userId)); return { ...row(r), userId: r.userId.toString(), name: u?.name, email: u?.email, phone: u?.phone }; }),
    total, page: q.page, limit: q.limit, pages: Math.max(1, Math.ceil(total / q.limit)),
  };
}
