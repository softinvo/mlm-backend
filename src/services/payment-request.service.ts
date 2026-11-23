/**
 * Paying a franchise from the shopping wallet. The franchise bills the member; the MEMBER unlocks it by reading out a one-time code (valid 5 minutes).
 * Until the right code is entered, no money moves, and a franchise can never take money without it.
 */
import { ClientSession, Types } from 'mongoose';
import { Franchise, FranchiseTier, Order, User, Wallet, WalletPaymentRequest } from '../models';
import { HttpError } from '../utils/http';
import { withTx } from '../utils/tx';
import type { MaybeScope } from './franchise.service';
import { payOrderWithShoppingWallet } from './wallet.service';
import { issueOtp, verifyOtp } from './otp.service';
import type { Channel } from './notify.service';

/** A bill paid from the shopping wallet is unlocked by a one-time code that works for this long. */
const ttlMinutes = () => Number(process.env.PAYMENT_REQUEST_MINUTES ?? 5);
const DAY = 86_400_000;
const orderNo = (id: { toString(): string }) => '#' + id.toString().slice(-6).toUpperCase();

async function dailyLimit(franchiseId: Types.ObjectId, session?: ClientSession) {
  const f = await Franchise.findById(franchiseId).select('tierId').session(session ?? null);
  const tier = f?.tierId ? await FranchiseTier.findById(f.tierId).select('dailyWalletSalesLimitPaise').session(session ?? null) : null;
  return tier?.dailyWalletSalesLimitPaise ?? 0;
}
async function soldToday(franchiseId: Types.ObjectId, now: Date, session?: ClientSession) {
  const [r] = await WalletPaymentRequest.aggregate([
    { $match: { franchiseId, status: 'APPROVED', decidedAt: { $gte: new Date(now.getTime() - DAY) } } },
    { $group: { _id: null, n: { $sum: '$amountPaise' } } },
  ]).session(session ?? null);
  return r?.n ?? 0;
}

/** Called by the franchise when it starts a wallet sale. Early checks here are friendly; the member's approval is the real gate. */
export async function createWalletRequest(i: { orderId: Types.ObjectId; memberUserId: Types.ObjectId; franchiseId: Types.ObjectId; requestedBy: string; amountPaise: number; now?: Date }) {
  const now = i.now ?? new Date();
  const wallet = await Wallet.findOne({ userId: i.memberUserId, type: 'SHOPPING' }).select('balancePaise');
  if ((wallet?.balancePaise ?? 0) < i.amountPaise) throw new HttpError(400, 'The member’s shopping wallet balance is too low for this sale');
  const limit = await dailyLimit(i.franchiseId);
  if (limit > 0 && (await soldToday(i.franchiseId, now)) + i.amountPaise > limit) throw new HttpError(400, 'This sale would exceed your franchise’s daily wallet sales limit');
  return WalletPaymentRequest.create({
    orderId: i.orderId, memberUserId: i.memberUserId, franchiseId: i.franchiseId, requestedBy: i.requestedBy, amountPaise: i.amountPaise,
    expiresAt: new Date(now.getTime() + ttlMinutes() * 60_000),
  });
}

/** Marks overdue pending requests EXPIRED (lazy; runs whenever requests are read or decided). */
export async function sweepExpired(filter: Record<string, unknown> = {}, now = new Date()) {
  await WalletPaymentRequest.updateMany({ ...filter, status: 'PENDING', expiresAt: { $lte: now } }, { $set: { status: 'EXPIRED', decidedAt: now } });
}

async function describe(rows: any[]) {
  const orders: any[] = await Order.find({ _id: { $in: rows.map((r) => r.orderId) } }).populate('items.packageId', 'name imageUrl').populate('items.productId', 'name imageUrl').lean();
  const frs = await Franchise.find({ _id: { $in: rows.map((r) => r.franchiseId) } }).select('code name').lean();
  const users = await User.find({ _id: { $in: rows.map((r) => r.memberUserId) } }).select('name').lean();
  return rows.map((r) => {
    const o = orders.find((x) => x._id.equals(r.orderId));
    const f = frs.find((x) => x._id.equals(r.franchiseId));
    return {
      id: r._id.toString(), orderNo: orderNo(r.orderId), orderId: r.orderId.toString(), amountPaise: r.amountPaise, status: r.status,
      createdAt: r.createdAt, expiresAt: r.expiresAt, decidedAt: r.decidedAt ?? null,
      franchise: f ? { code: f.code, name: f.name } : null, member: { name: users.find((u) => u._id.equals(r.memberUserId))?.name },
      items: (o?.items ?? []).map((i: any) => ({ name: i.packageId?.name ?? i.productId?.name ?? 'Item', imageUrl: i.packageId?.imageUrl || i.productId?.imageUrl || '', quantity: i.quantity })),
    };
  });
}

export async function listForFranchise(scope: MaybeScope, q: { status?: string; page: number; limit: number }) {
  const base = scope ? { franchiseId: { $in: scope.ids } } : {};
  await sweepExpired(base);
  const filter: Record<string, unknown> = { ...base, ...(q.status ? { status: q.status } : {}) };
  const [rows, total] = await Promise.all([
    WalletPaymentRequest.find(filter).sort({ createdAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(), WalletPaymentRequest.countDocuments(filter),
  ]);
  return { items: await describe(rows), total, page: q.page, limit: q.limit, pages: Math.max(1, Math.ceil(total / q.limit)) };
}

async function load(userId: string, id: string, now: Date) {
  const r = await WalletPaymentRequest.findOne({ _id: id, memberUserId: userId });
  if (!r) throw new HttpError(404, 'Payment request not found');
  if (r.status === 'PENDING' && r.expiresAt <= now) {
    r.status = 'EXPIRED'; r.decidedAt = now; await r.save();
  }
  if (r.status !== 'PENDING') throw new HttpError(409, r.status === 'EXPIRED' ? 'This request has expired. Ask the shop to send a new one.' : `This request is already ${r.status.toLowerCase()}`);
  return r;
}

/** The code was right: the request, the wallet debit and the order payment all happen together or not at all. */
async function approvePaymentRequest(userId: string, id: string, now = new Date()) {
  const r = await load(userId, id, now);
  return withTx(async (session) => {
    const claimed = await WalletPaymentRequest.findOneAndUpdate(
      { _id: r._id, memberUserId: userId, status: 'PENDING', expiresAt: { $gt: now } },
      { $set: { status: 'APPROVED', decidedAt: now } }, { new: true, session },
    );
    if (!claimed) throw new HttpError(409, 'This request was just updated. Please refresh.');
    const limit = await dailyLimit(claimed.franchiseId, session);
    if (limit > 0) {
      // Touch the franchise so simultaneous approvals for the same shop run one after another.
      await Franchise.updateOne({ _id: claimed.franchiseId }, { $inc: { walletSalesSeq: 1 } }, { session });
      if ((await soldToday(claimed.franchiseId, now, session)) > limit) throw new HttpError(400, 'This shop has reached its daily wallet sales limit. Try again tomorrow, or pay another way.');
    }
    await payOrderWithShoppingWallet(claimed.orderId.toString(), userId, now, session);
    return claimed;
  });
}

export async function cancelRequestByFranchise(scope: MaybeScope, id: string) {
  const r = await WalletPaymentRequest.findOneAndUpdate(
    { _id: id, status: 'PENDING', ...(scope ? { franchiseId: { $in: scope.ids } } : {}) },
    { $set: { status: 'CANCELLED', decidedAt: new Date() } }, { new: true },
  );
  if (!r) throw new HttpError(404, 'Request not found or no longer pending');
  return r;
}

/** Sends the member a code for this wallet payment. The member reads it out to the shop, which types it in to confirm. */
export async function sendRequestOtp(requestId: string, channel?: Channel) {
  const r = await WalletPaymentRequest.findById(requestId);
  if (!r || r.status !== 'PENDING' || r.expiresAt <= new Date()) throw new HttpError(409, 'This payment request is no longer waiting. Start the sale again.');
  return issueOtp({ userId: r.memberUserId.toString(), purpose: 'WALLET_SALE', ref: r._id.toString(), channel });
}

/** The shop types in the code the member gave them. A right code completes the payment exactly as the member approving it would. */
export async function confirmWithOtp(scope: MaybeScope, requestId: string, code: string, now = new Date()) {
  const r = await WalletPaymentRequest.findOne({ _id: requestId, ...(scope ? { franchiseId: { $in: scope.ids } } : {}) });
  if (!r) throw new HttpError(404, 'Payment request not found');
  if (r.status === 'PENDING' && r.expiresAt <= now) { r.status = 'EXPIRED'; r.decidedAt = now; await r.save(); }
  if (r.status !== 'PENDING') throw new HttpError(409, r.status === 'EXPIRED' ? 'This request has expired. Start the sale again.' : `This request is already ${r.status.toLowerCase()}`);
  await verifyOtp({ userId: r.memberUserId.toString(), purpose: 'WALLET_SALE', ref: r._id.toString(), code, now });
  return approvePaymentRequest(r.memberUserId.toString(), requestId, now);
}
