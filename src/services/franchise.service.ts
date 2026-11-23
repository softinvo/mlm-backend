/**
 * Franchise operations. Every function takes a `scope`:
 *   - a Scope  -> a franchise user: their own franchise and every franchise they manage (lower plans)
 *   - null     -> head office (admin): everything
 * Franchises never move money themselves; they verify, record, ship and RECOMMEND. The admin approves.
 */
import { Types } from 'mongoose';
import { Franchise, FranchiseRecharge, FundRequest, Member, Order, User, Wallet, WalletPaymentRequest, Withdrawal } from '../models';
import { decrypt } from '../utils/crypto';
import { HttpError } from '../utils/http';
import { descendantsOf } from './hierarchy.service';
import { stockSummary } from './stock.service';
import { advanceShipment, cancelOrder } from './order.service';
import { payAtCounter } from './prepaid.service';
import { markWithdrawalPaid, reviewKyc } from './wallet.service';

export interface Scope { ids: Types.ObjectId[]; ownIds: Types.ObjectId[]; franchises: { id: string; code: string; name: string; type: string }[] }
export type MaybeScope = Scope | null;

const DAY = 86_400_000;
const orderNo = (id: { toString(): string }) => '#' + id.toString().slice(-6).toUpperCase();
const paging = (q: { page: number; limit: number }) => ({ skip: (q.page - 1) * q.limit, limit: q.limit });
const pageInfo = (q: { page: number; limit: number }, total: number) => ({ total, page: q.page, limit: q.limit, pages: Math.max(1, Math.ceil(total / q.limit)) });
const inScope = (scope: MaybeScope, field = 'franchiseId') => (scope ? { [field]: { $in: scope.ids } } : {});

/** Franchises this user runs (owner or staff), plus every franchise they manage below them. Money stays with each franchise's own users. */
export async function scopeOf(userId: string): Promise<Scope> {
  const own = await Franchise.find({ $or: [{ ownerUserId: userId }, { staffUserIds: userId }], active: true });
  if (!own.length) throw new HttpError(403, 'No active franchise is assigned to your account');
  const ownIds = own.map((f) => f._id);
  const below = await descendantsOf(ownIds, { activeOnly: true }); // everyone they manage, at any depth
  const all = [...own, ...below.filter((d) => !ownIds.some((o) => o.equals(d._id)))];
  return { ids: all.map((f) => f._id), ownIds, franchises: all.map((f) => ({ id: f._id.toString(), code: f.code, name: f.name, type: f.type })) };
}

/** Looks up display info for a batch of rows so lists don't need N queries. */
async function people(userIds: Types.ObjectId[], franchiseIds: Types.ObjectId[], extraUserIds: Types.ObjectId[] = []) {
  const [users, members, franchises] = await Promise.all([
    User.find({ _id: { $in: [...userIds, ...extraUserIds] } }).select('name email phone').lean(),
    Member.find({ userId: { $in: userIds } }).select('userId memberCode').lean(),
    Franchise.find({ _id: { $in: franchiseIds } }).select('code name').lean(),
  ]);
  return {
    user: (id?: Types.ObjectId) => users.find((u) => id && u._id.equals(id)),
    code: (id?: Types.ObjectId) => members.find((m) => id && m.userId.equals(id))?.memberCode ?? null,
    franchise: (id?: Types.ObjectId | null) => { const f = franchises.find((x) => id && x._id.equals(id)); return f ? { code: f.code, name: f.name } : null; },
  };
}
const recView = (r: any, who: (id?: Types.ObjectId) => { name?: string } | undefined) =>
  r ? { decision: r.decision, note: r.note ?? null, approvedPaise: r.approvedPaise ?? null, at: r.at, by: who(r.by)?.name ?? 'Franchise' } : null;

async function memberInScope(scope: MaybeScope, userId: string) {
  const m = await Member.findOne({ userId, ...inScope(scope) });
  if (!m) throw new HttpError(404, 'Member not found');
  return m;
}

// ───────── Overview ─────────

export async function overview(scope: MaybeScope) {
  const f = inScope(scope);
  const kycPending = await Member.aggregate([
    { $match: f }, { $lookup: { from: User.collection.name, localField: 'userId', foreignField: '_id', as: 'u', pipeline: [{ $project: { kyc: 1 } }] } },
    { $match: { 'u.kyc.status': 'PENDING' } }, { $count: 'n' },
  ]);
  const [members, fundNew, fundRecommended, wdNew, wdRecommended, wdApproved, awaitingPay, toShip, inTransit] = await Promise.all([
    Member.countDocuments(f),
    FundRequest.countDocuments({ ...f, status: 'PENDING', recommendation: { $exists: false } }),
    FundRequest.countDocuments({ ...f, status: 'PENDING', recommendation: { $exists: true } }),
    Withdrawal.countDocuments({ ...f, status: 'REQUESTED', recommendation: { $exists: false } }),
    Withdrawal.countDocuments({ ...f, status: 'REQUESTED', recommendation: { $exists: true } }),
    Withdrawal.countDocuments({ ...f, status: 'APPROVED' }),
    Order.countDocuments({ ...f, status: 'PLACED' }),
    Order.countDocuments({ ...f, status: 'PAID', 'shipment.status': { $in: ['PENDING', 'PACKED'] } }),
    Order.countDocuments({ ...f, status: 'PAID', 'shipment.status': { $in: ['SHIPPED', 'OUT_FOR_DELIVERY'] } }),
  ]);
  const rechargesPending = await FranchiseRecharge.countDocuments({ ...f, status: 'PENDING' });
  const prepaid = scope ? (await Franchise.find({ _id: { $in: scope.ownIds } }).select('prepaidBalancePaise').lean()).reduce((n, x) => n + (x.prepaidBalancePaise ?? 0), 0) : (await Franchise.aggregate([{ $group: { _id: null, n: { $sum: '$prepaidBalancePaise' } } }]))[0]?.n ?? 0;
  const stock = await stockSummary(scope ? scope.ownIds : null); // a franchise sees its own stock, never a sub-franchise's
  const walletPending = await WalletPaymentRequest.countDocuments({ ...f, status: 'PENDING', expiresAt: { $gt: new Date() } });
  return {
    franchises: scope?.franchises ?? [],
    prepaidBalancePaise: prepaid,
    stock,
    counts: {
      members, kycPending: kycPending[0]?.n ?? 0,
      topups: { toReview: fundNew, recommended: fundRecommended },
      withdrawals: { toReview: wdNew, recommended: wdRecommended, toPay: wdApproved },
      orders: { awaitingPayment: awaitingPay, toShip, inTransit, walletRequestsPending: walletPending },
      recharges: { pending: rechargesPending },
      stockAlerts: stock.low + stock.out,
    },
  };
}

// ───────── Members and bank-detail verification ─────────

export async function listMembers(scope: MaybeScope, q: { search?: string; page: number; limit: number }) {
  const rx = q.search ? { $regex: q.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } : null;
  const pipeline: any[] = [
    { $match: inScope(scope) },
    { $lookup: { from: User.collection.name, localField: 'userId', foreignField: '_id', as: 'u', pipeline: [{ $project: { name: 1, email: 1, phone: 1, status: 1, kyc: 1 } }] } },
    { $unwind: '$u' },
    ...(rx ? [{ $match: { $or: [{ 'u.name': rx }, { memberCode: rx }, { 'u.email': rx }, { 'u.phone': rx }] } }] : []),
    { $sort: { joinedAt: -1, _id: -1 } },
    { $facet: {
      items: [{ $skip: paging(q).skip }, { $limit: q.limit }, { $project: { _id: 0, userId: { $toString: '$userId' }, memberCode: 1, rank: 1, joinedAt: 1, franchiseId: 1, name: '$u.name', email: '$u.email', phone: '$u.phone', status: '$u.status', kycStatus: { $ifNull: ['$u.kyc.status', 'NOT_SUBMITTED'] } } }],
      total: [{ $count: 'n' }],
    } },
  ];
  const [r] = await Member.aggregate(pipeline);
  const fr = await Franchise.find({ _id: { $in: (r?.items ?? []).map((i: any) => i.franchiseId) } }).select('code').lean();
  return { items: (r?.items ?? []).map((i: any) => ({ ...i, franchiseId: undefined, franchiseCode: fr.find((f) => f._id.equals(i.franchiseId))?.code ?? null })), ...pageInfo(q, r?.total[0]?.n ?? 0) };
}

export async function listKyc(scope: MaybeScope, q: { status?: string; page: number; limit: number }) {
  const [r] = await Member.aggregate([
    { $match: inScope(scope) },
    { $lookup: { from: User.collection.name, localField: 'userId', foreignField: '_id', as: 'u', pipeline: [{ $project: { name: 1, email: 1, phone: 1, kyc: 1 } }] } },
    { $unwind: '$u' },
    { $match: { 'u.kyc.status': q.status ?? { $exists: true } } },
    { $sort: { 'u.kyc.submittedAt': 1 } },
    { $facet: {
      items: [{ $skip: paging(q).skip }, { $limit: q.limit }, { $project: { _id: 0, userId: { $toString: '$userId' }, memberCode: 1, name: '$u.name', email: '$u.email', phone: '$u.phone',
        status: '$u.kyc.status', accountHolder: '$u.kyc.accountHolder', accountLast4: '$u.kyc.accountLast4', ifsc: '$u.kyc.ifsc', panMasked: '$u.kyc.panMasked', submittedAt: '$u.kyc.submittedAt', note: '$u.kyc.note' } }],
      total: [{ $count: 'n' }],
    } },
  ]);
  return { items: r?.items ?? [], ...pageInfo(q, r?.total[0]?.n ?? 0) };
}

/** The full account number is shown only to the reviewing franchise/admin, and every view is logged by the caller. */
export async function kycDetail(scope: MaybeScope, userId: string) {
  await memberInScope(scope, userId);
  const u = await User.findById(userId);
  if (!u?.kyc) throw new HttpError(404, 'No bank details submitted');
  return { userId, name: u.name, status: u.kyc.status, accountHolder: u.kyc.accountHolder, accountNumber: decrypt(u.kyc.bankAccountEnc), ifsc: u.kyc.ifsc, panMasked: u.kyc.panMasked, submittedAt: u.kyc.submittedAt, note: u.kyc.note ?? null };
}

export async function reviewMemberKyc(scope: MaybeScope, actorId: string, userId: string, status: 'VERIFIED' | 'REJECTED', note?: string) {
  if (userId === actorId) throw new HttpError(403, 'You can’t review your own details');
  await memberInScope(scope, userId);
  if (status === 'REJECTED' && !note) throw new HttpError(400, 'Tell the member why their details were rejected');
  await reviewKyc(userId, status, note, actorId);
}

// ───────── Top-ups ─────────

export async function listFunds(scope: MaybeScope, q: { status?: string; recommended?: boolean; page: number; limit: number }) {
  const filter: Record<string, unknown> = { ...inScope(scope), ...(q.status ? { status: q.status } : {}) };
  if (q.recommended !== undefined) filter.recommendation = { $exists: q.recommended };
  const [rows, total] = await Promise.all([
    FundRequest.find(filter).sort({ createdAt: 1 }).skip(paging(q).skip).limit(q.limit).lean(), FundRequest.countDocuments(filter),
  ]);
  const p = await people(rows.map((r) => r.userId), rows.map((r) => r.franchiseId!).filter(Boolean), rows.map((r) => r.recommendation?.by).filter(Boolean) as Types.ObjectId[]);
  return {
    items: rows.map((r) => ({
      id: r._id.toString(), createdAt: r.createdAt, amountPaise: r.amountPaise, approvedPaise: r.approvedPaise ?? null, mode: r.mode, reference: r.reference, paidOn: r.paidOn,
      note: r.note ?? null, status: r.status, reviewNote: r.reviewNote ?? null,
      member: { userId: r.userId.toString(), name: p.user(r.userId)?.name, memberCode: p.code(r.userId), phone: p.user(r.userId)?.phone }, franchise: p.franchise(r.franchiseId),
      recommendation: recView(r.recommendation, p.user),
    })),
    ...pageInfo(q, total),
  };
}

export async function recommendFund(scope: MaybeScope, actorId: string, id: string, i: { decision: 'APPROVE' | 'REJECT'; note?: string; approvedPaise?: number }) {
  const r = await FundRequest.findOne({ _id: id, status: 'PENDING', ...inScope(scope) });
  if (!r) throw new HttpError(404, 'Request not found or already reviewed');
  if (i.decision === 'REJECT' && !i.note) throw new HttpError(400, 'Add a note explaining why');
  const approvedPaise = i.decision === 'APPROVE' ? i.approvedPaise ?? r.amountPaise : undefined;
  if (approvedPaise !== undefined && (approvedPaise < 1 || approvedPaise > r.amountPaise)) throw new HttpError(400, 'Amount must be between ₹0.01 and the amount requested');
  r.recommendation = { by: new Types.ObjectId(actorId), franchiseId: r.franchiseId, decision: i.decision, note: i.note, approvedPaise, at: new Date() } as any;
  await r.save();
  return r;
}

// ───────── Withdrawals ─────────

export async function listWithdrawals(scope: MaybeScope, q: { status?: string; recommended?: boolean; page: number; limit: number }, revealBank: (status: string) => boolean) {
  const filter: Record<string, unknown> = { ...inScope(scope), ...(q.status ? { status: q.status } : {}) };
  if (q.recommended !== undefined) filter.recommendation = { $exists: q.recommended };
  const [rows, total] = await Promise.all([
    Withdrawal.find(filter).sort({ createdAt: 1 }).skip(paging(q).skip).limit(q.limit).lean(), Withdrawal.countDocuments(filter),
  ]);
  const wallets = await Wallet.find({ _id: { $in: rows.map((r) => r.walletId) } }).select('userId').lean();
  const uid = (walletId: Types.ObjectId) => wallets.find((w) => w._id.equals(walletId))?.userId;
  const p = await people(wallets.map((w) => w.userId), rows.map((r) => r.franchiseId!).filter(Boolean), rows.map((r) => r.recommendation?.by).filter(Boolean) as Types.ObjectId[]);
  return {
    items: rows.map((w) => {
      const u = uid(w.walletId) as Types.ObjectId | undefined;
      return {
        id: w._id.toString(), createdAt: w.createdAt, amountPaise: w.amountPaise, feePaise: w.feePaise, tdsPaise: w.tdsPaise, netPaise: w.netPaise, status: w.status,
        payoutRef: w.payoutRef ?? null, rejectReason: w.rejectReason ?? null,
        member: { userId: u?.toString(), name: p.user(u)?.name, memberCode: p.code(u) }, franchise: p.franchise(w.franchiseId),
        recommendation: recView(w.recommendation, p.user),
        bank: w.bank && revealBank(w.status) ? { accountHolder: w.bank.accountHolder, ifsc: w.bank.ifsc, accountNumber: w.bank.accountEnc ? decrypt(w.bank.accountEnc) : null } : w.bank ? { accountHolder: w.bank.accountHolder, ifsc: w.bank.ifsc, accountNumber: null, last4: w.bank.accountLast4 } : null,
      };
    }),
    ...pageInfo(q, total),
  };
}

export async function recommendWithdrawal(scope: MaybeScope, actorId: string, id: string, i: { decision: 'APPROVE' | 'REJECT'; note?: string }) {
  const w = await Withdrawal.findOne({ _id: id, status: 'REQUESTED', ...inScope(scope) });
  if (!w) throw new HttpError(404, 'Withdrawal not found or already reviewed');
  if (i.decision === 'REJECT' && !i.note) throw new HttpError(400, 'Add a note explaining why');
  w.recommendation = { by: new Types.ObjectId(actorId), franchiseId: w.franchiseId, decision: i.decision, note: i.note, at: new Date() } as any;
  await w.save();
  return w;
}

/** Only after the admin has approved it. */
export async function payWithdrawal(scope: MaybeScope, id: string, payoutRef: string) {
  if (!(await Withdrawal.exists({ _id: id, ...inScope(scope) }))) throw new HttpError(404, 'Withdrawal not found');
  return markWithdrawalPaid(id, payoutRef);
}

// ───────── Orders ─────────

const ORDER_TABS: Record<string, Record<string, unknown>> = {
  awaiting: { status: 'PLACED' },
  toship: { status: 'PAID', 'shipment.status': { $in: ['PENDING', 'PACKED'] } },
  transit: { status: 'PAID', 'shipment.status': { $in: ['SHIPPED', 'OUT_FOR_DELIVERY'] } },
  done: { status: { $in: ['DELIVERED', 'PARTIALLY_REFUNDED', 'REFUNDED'] } },
};
export const ORDER_TAB_KEYS = Object.keys(ORDER_TABS);

export async function listOrders(scope: MaybeScope, q: { tab: string; page: number; limit: number }) {
  const filter = { ...inScope(scope), ...ORDER_TABS[q.tab] };
  const [rows, total] = await Promise.all([
    Order.find(filter).sort({ createdAt: q.tab === 'done' ? -1 : 1 }).skip(paging(q).skip).limit(q.limit)
      .populate('items.packageId', 'name imageUrl').populate('items.productId', 'name imageUrl').lean(),
    Order.countDocuments(filter),
  ]);
  const p = await people(rows.map((o) => o.buyerId), rows.map((o) => o.franchiseId));
  const reqs = await WalletPaymentRequest.find({ orderId: { $in: rows.map((o) => o._id) } }).sort({ createdAt: -1 }).lean();
  return {
    items: rows.map((o: any) => ({
      id: o._id.toString(), orderNo: orderNo(o._id), placedAt: o.createdAt, status: o.status, shipmentStatus: o.shipment?.status ?? 'PENDING', totalPaise: o.totalPaise,
      items: o.items.map((i: any) => ({ name: i.packageId?.name ?? i.productId?.name ?? 'Item', imageUrl: i.packageId?.imageUrl || i.productId?.imageUrl || '', quantity: i.quantity })),
      buyer: { name: p.user(o.buyerId)?.name, memberCode: p.code(o.buyerId), phone: p.user(o.buyerId)?.phone }, franchise: p.franchise(o.franchiseId),
      walletRequest: (() => { const r = reqs.find((x) => x.orderId.equals(o._id)); return r ? { id: r._id.toString(), status: r.status === 'PENDING' && r.expiresAt <= new Date() ? 'EXPIRED' : r.status, expiresAt: r.expiresAt } : null; })(),
      address: o.shippingAddress ?? null, courier: o.shipment?.courier ?? null, trackingId: o.shipment?.trackingId ?? null,
      franchiseCostPaise: o.franchiseCostPaise ?? null, soldByFranchise: !!o.soldByFranchise,
    })),
    ...pageInfo(q, total),
  };
}

/**
 * The franchise took the customer's money at the counter. The order is PAID straight away so it can be handed over.
 * (No head-office confirmation is needed: the goods are the franchise's own stock, already paid for when supplied.)
 */
export async function collectPayment(scope: MaybeScope, id: string, i: { method: 'CASH' | 'UPI' | 'BANK_TRANSFER'; reference: string; note?: string }) {
  const o = await Order.findOne({ _id: id, status: 'PLACED', ...inScope(scope) });
  if (!o) throw new HttpError(404, 'Order not found or no longer awaiting payment');
  return payAtCounter(o._id.toString(), i);
}

export async function shipOrder(scope: MaybeScope, id: string, status: Parameters<typeof advanceShipment>[1], extra: Parameters<typeof advanceShipment>[2]) {
  if (!(await Order.exists({ _id: id, ...inScope(scope) }))) throw new HttpError(404, 'Order not found');
  return advanceShipment(id, status, extra);
}

export async function cancelUnpaid(scope: MaybeScope, id: string, reason: string) {
  const o = await Order.findOne({ _id: id, ...inScope(scope) });
  if (!o) throw new HttpError(404, 'Order not found');
  if (o.status !== 'PLACED') throw new HttpError(409, 'Only unpaid orders can be cancelled here. Paid orders need a refund from the head office.');
  return cancelOrder(id, reason);
}


void DAY;
