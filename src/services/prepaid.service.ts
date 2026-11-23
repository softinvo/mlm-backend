/**
 * Franchise PREPAID account.
 *
 * A franchise keeps a prepaid balance with the company. For every sale it makes, the company charges the retail price
 * LESS the franchise's tier discount (e.g. 3% / 5% / 8%) from that balance; the franchise keeps the difference as its margin.
 *   - Paid at the counter: the franchise keeps the customer's money. The balance is charged the discounted cost.
 *   - Paid from the member's shopping wallet: the company holds the money, so the balance is charged the discounted
 *     cost AND credited the full retail price (net effect: it gains the discount).
 * Refunds reverse the same amounts. Franchises recharge by paying the company; the head office confirms each recharge.
 */
import { ClientSession, Types } from 'mongoose';
import { Franchise, FranchiseLedgerEntry, FranchiseRecharge, FranchiseTier, Order, PaymentMode, PrepaidType } from '../models';
import { HttpError } from '../utils/http';
import { withTx } from '../utils/tx';
import { restockOrder } from './stock.service';

const DAY = 86_400_000;
const num = (v: string | undefined, d: number) => (v !== undefined && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : d);
export const rechargeLimits = () => ({ minPaise: num(process.env.RECHARGE_MIN_PAISE, 100_000), maxPaise: num(process.env.RECHARGE_MAX_PAISE, 50_000_000), maxOpen: num(process.env.RECHARGE_MAX_OPEN, 3), maxAgeDays: 30 });
export const normalizeRef = (r: string) => r.trim().toUpperCase().replace(/[\s\-\/]/g, '');
const inr = (p: number) => `₹${(p / 100).toFixed(2)}`;

/** What the franchise pays the company for goods with this retail total, given its tier discount. */
export const wholesale = (totalPaise: number, discountPercent: number) => totalPaise - Math.round((totalPaise * discountPercent) / 100);

export async function discountFor(franchiseId: Types.ObjectId | string, session?: ClientSession) {
  const f = await Franchise.findById(franchiseId).select('tierId').session(session ?? null);
  const tier = f?.tierId ? await FranchiseTier.findById(f.tierId).select('discountPercent').session(session ?? null) : null;
  return tier?.discountPercent ?? 0;
}

export interface PostEntry { franchiseId: Types.ObjectId | string; amountPaise: number; type: PrepaidType; refType?: string; refId?: Types.ObjectId; key: string; note?: string }

/**
 * The ONLY place a franchise's prepaid balance changes. With `strict`, a debit that would take the balance below zero fails
 * (atomically, so two simultaneous sales can never overspend).
 */
export async function postFranchiseEntry(session: ClientSession, e: PostEntry, strict = false) {
  if (!Number.isInteger(e.amountPaise) || e.amountPaise === 0) throw new HttpError(400, 'Amount must be a non-zero whole number of paise');
  const filter: Record<string, unknown> = { _id: e.franchiseId };
  if (strict && e.amountPaise < 0) filter.prepaidBalancePaise = { $gte: -e.amountPaise };
  const f = await Franchise.findOneAndUpdate(filter, { $inc: { prepaidBalancePaise: e.amountPaise } }, { new: true, session });
  if (!f) throw new HttpError(strict && e.amountPaise < 0 ? 400 : 404, strict && e.amountPaise < 0 ? 'Prepaid balance is too low for this sale' : 'Franchise not found');
  await FranchiseLedgerEntry.create([{ franchiseId: f._id, type: e.type, amountPaise: e.amountPaise, balanceAfterPaise: f.prepaidBalancePaise, refType: e.refType, refId: e.refId, idempotencyKey: e.key, note: e.note }], { session });
  return f;
}

const orderNo = (id: { toString(): string }) => '#' + id.toString().slice(-6).toUpperCase();

/**
 * The franchise took the customer's money at the counter: the order is PAID straight away so it can be handed over.
 * (The stock was taken when the sale was made and the franchise already paid for it when it was supplied, so no balance moves.)
 */
export async function payAtCounter(orderId: string, input: { method: 'CASH' | 'UPI' | 'BANK_TRANSFER'; reference: string; note?: string }, now = new Date()) {
  try {
    return await withTx(async (session) => {
      const o = await Order.findOne({ _id: orderId, status: 'PLACED' }).session(session);
      if (!o) throw new HttpError(404, 'Order not found or no longer awaiting payment');
      const discount = await discountFor(o.franchiseId, session);
      const paid = await Order.findOneAndUpdate(
        { _id: o._id, status: 'PLACED' },
        {
          $set: { status: 'PAID', paidAt: now, franchiseCollected: true, franchiseDiscountPercent: discount },
          $push: { payments: { gateway: `COUNTER_${input.method}`, gatewayRef: `FC-${normalizeRef(input.reference)}`, amountPaise: o.totalPaise, status: 'SUCCESS', createdAt: now } },
        },
        { new: true, session },
      );
      if (!paid) throw new HttpError(409, 'Order was updated by someone else, please retry');
      return paid;
    });
  } catch (e: any) {
    if (e?.code === 11000) throw new HttpError(409, 'This receipt / reference number has already been used for another order');
    throw e;
  }
}

/** A franchise sale was paid from the member's shopping wallet: the company holds that money, so it passes the full price on to the franchise. */
export async function applyWalletSale(session: ClientSession, order: InstanceType<typeof Order>) {
  const discount = await discountFor(order.franchiseId, session);
  await postFranchiseEntry(session, { franchiseId: order.franchiseId, amountPaise: order.totalPaise, type: 'SALE_PROCEEDS', refType: 'Order', refId: order._id, key: `proceeds:${order._id}`, note: `Wallet payment for order ${orderNo(order._id)}` });
  order.franchiseDiscountPercent = discount;
}

/** Called by refundOrder, inside its transaction, after the order's refunded total was updated. */
export async function reverseForRefund(session: ClientSession, order: InstanceType<typeof Order>, refundId: Types.ObjectId, refundPaise: number) {
  if (!order.soldByFranchise) return;
  // A wallet-paid sale: the company refunds the member's wallet, so it takes that money back from the franchise.
  if (!order.franchiseCollected) {
    await postFranchiseEntry(session, { franchiseId: order.franchiseId, amountPaise: -refundPaise, type: 'PROCEEDS_RETURNED', refType: 'Order', refId: order._id, key: `procret:${refundId}`, note: `Refund on order ${orderNo(order._id)}` });
  }
  // A full refund means the goods come back to the franchise.
  if (order.refundedPaise >= order.totalPaise) await restockOrder(session, order, `Order ${orderNo(order._id)} refunded`);
}

/**
 * A franchise's FIRST recharge must match its plan's investment (e.g. Mini ₹25,000, Standard ₹1,00,000, Premium ₹5,00,000).
 * Returns the required amount, or 0 once the franchise has been funded before (or its plan has no investment).
 */
export async function firstRechargeRequired(franchiseId: Types.ObjectId | string, session?: ClientSession) {
  const f = await Franchise.findById(franchiseId).select('tierId').session(session ?? null);
  const tier = f?.tierId ? await FranchiseTier.findById(f.tierId).select('investmentPaise').session(session ?? null) : null;
  const need = tier?.investmentPaise ?? 0;
  if (!need) return 0;
  const funded = await FranchiseLedgerEntry.exists({ franchiseId, type: 'RECHARGE' }).session(session ?? null);
  return funded ? 0 : need;
}

// ───────── Statement ─────────

export async function statement(franchiseId: Types.ObjectId) {
  const f = await Franchise.findById(franchiseId).select('code name type tierId prepaidBalancePaise');
  if (!f) throw new HttpError(404, 'Franchise not found');
  const tier = f.tierId ? await FranchiseTier.findById(f.tierId).select('name discountPercent investmentPaise maxMembers dailyWalletSalesLimitPaise') : null;
  const pending = await FranchiseRecharge.aggregate([{ $match: { franchiseId, status: 'PENDING' } }, { $group: { _id: null, n: { $sum: '$amountPaise' }, c: { $sum: 1 } } }]);
  return {
    franchise: { id: f._id.toString(), code: f.code, name: f.name, type: f.type },
    balancePaise: f.prepaidBalancePaise,
    tier: tier ? { name: tier.name, discountPercent: tier.discountPercent, investmentPaise: tier.investmentPaise ?? 0, maxMembers: tier.maxMembers, dailyWalletSalesLimitPaise: tier.dailyWalletSalesLimitPaise } : null,
    firstRechargePaise: await firstRechargeRequired(franchiseId),
    pendingRechargePaise: pending[0]?.n ?? 0, pendingRechargeCount: pending[0]?.c ?? 0, limits: rechargeLimits(),
  };
}

export async function listEntries(franchiseId: Types.ObjectId, q: { page: number; limit: number; type?: string }) {
  const filter: Record<string, unknown> = { franchiseId, ...(q.type ? { type: q.type } : {}) };
  const [rows, total] = await Promise.all([
    FranchiseLedgerEntry.find(filter).sort({ createdAt: -1, _id: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(), FranchiseLedgerEntry.countDocuments(filter),
  ]);
  return {
    items: rows.map((e) => ({ id: e._id.toString(), type: e.type, amountPaise: e.amountPaise, balanceAfterPaise: e.balanceAfterPaise, note: e.note ?? null, createdAt: e.createdAt })),
    total, page: q.page, limit: q.limit, pages: Math.max(1, Math.ceil(total / q.limit)),
  };
}

// ───────── Recharges (the franchise pays the company) ─────────

export async function createRecharge(franchiseId: Types.ObjectId, actorId: string, i: { amountPaise: number; mode: PaymentMode; reference: string; paidOn: Date; note?: string }) {
  const cfg = rechargeLimits();
  if (!Number.isInteger(i.amountPaise) || i.amountPaise < cfg.minPaise) throw new HttpError(400, `Minimum recharge is ${inr(cfg.minPaise)}`);
  if (i.amountPaise > cfg.maxPaise) throw new HttpError(400, `Maximum per recharge is ${inr(cfg.maxPaise)}`);
  const first = await firstRechargeRequired(franchiseId);
  if (first && i.amountPaise < first) throw new HttpError(400, `Your first recharge must be at least your plan’s investment of ${inr(first)}`);
  const now = Date.now();
  if (i.paidOn.getTime() > now + DAY) throw new HttpError(400, 'Payment date cannot be in the future');
  if (i.paidOn.getTime() < now - cfg.maxAgeDays * DAY) throw new HttpError(400, `Payment must be from the last ${cfg.maxAgeDays} days`);
  if ((await FranchiseRecharge.countDocuments({ franchiseId, status: 'PENDING' })) >= cfg.maxOpen) throw new HttpError(400, `You already have ${cfg.maxOpen} recharges waiting for confirmation`);
  try {
    return await FranchiseRecharge.create({ franchiseId, requestedBy: actorId, amountPaise: i.amountPaise, mode: i.mode, reference: i.reference.trim(), refKey: normalizeRef(i.reference), paidOn: i.paidOn, note: i.note });
  } catch (e: any) {
    if (e?.code === 11000) throw new HttpError(409, 'This payment reference has already been submitted');
    throw e;
  }
}

export async function cancelRecharge(franchiseIds: Types.ObjectId[], id: string) {
  const r = await FranchiseRecharge.findOneAndUpdate({ _id: id, franchiseId: { $in: franchiseIds }, status: 'PENDING' }, { $set: { status: 'CANCELLED', holdsRef: false } }, { new: true });
  if (!r) throw new HttpError(404, 'Recharge not found or no longer pending');
  return r;
}

export async function listRecharges(franchiseIds: Types.ObjectId[] | null, q: { status?: string; page: number; limit: number }) {
  const filter: Record<string, unknown> = { ...(franchiseIds ? { franchiseId: { $in: franchiseIds } } : {}), ...(q.status ? { status: q.status } : {}) };
  const [rows, total] = await Promise.all([
    FranchiseRecharge.find(filter).sort({ createdAt: q.status === 'PENDING' ? 1 : -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(), FranchiseRecharge.countDocuments(filter),
  ]);
  const frs = await Franchise.find({ _id: { $in: rows.map((r) => r.franchiseId) } }).select('code name').lean();
  return {
    items: rows.map((r) => ({
      id: r._id.toString(), createdAt: r.createdAt, amountPaise: r.amountPaise, confirmedPaise: r.confirmedPaise ?? null, mode: r.mode, reference: r.reference, paidOn: r.paidOn,
      note: r.note ?? null, status: r.status, reviewNote: r.reviewNote ?? null, franchise: (() => { const f = frs.find((x) => x._id.equals(r.franchiseId)); return f ? { code: f.code, name: f.name } : null; })(),
    })),
    total, page: q.page, limit: q.limit, pages: Math.max(1, Math.ceil(total / q.limit)),
  };
}

/** Head office: the bank statement matched. Credits the franchise's prepaid balance, exactly once. */
export async function confirmRecharge(adminId: string, id: string, opts: { confirmedPaise?: number; note?: string } = {}) {
  return withTx(async (session) => {
    const r = await FranchiseRecharge.findById(id).session(session);
    if (!r) throw new HttpError(404, 'Recharge not found');
    const amount = opts.confirmedPaise ?? r.amountPaise;
    if (!Number.isInteger(amount) || amount < 1 || amount > r.amountPaise) throw new HttpError(400, 'Confirmed amount must be between ₹0.01 and the amount submitted');
    const first = await firstRechargeRequired(r.franchiseId, session);
    if (first && amount < first) throw new HttpError(400, `This is the franchise’s first recharge: its plan needs at least ${inr(first)}. Reject it, or ask for the balance to be sent.`);
    const claimed = await FranchiseRecharge.findOneAndUpdate({ _id: id, status: 'PENDING' }, { $set: { status: 'CONFIRMED', confirmedPaise: amount, reviewedBy: adminId, reviewedAt: new Date(), reviewNote: opts.note } }, { new: true, session });
    if (!claimed) throw new HttpError(409, 'This recharge has already been reviewed');
    await postFranchiseEntry(session, { franchiseId: claimed.franchiseId, amountPaise: amount, type: 'RECHARGE', refType: 'FranchiseRecharge', refId: claimed._id, key: `recharge:${claimed._id}`, note: `Recharge ${claimed.mode} ref ${claimed.reference}` });
    return claimed;
  });
}

export async function rejectRecharge(adminId: string, id: string, reason: string) {
  const r = await FranchiseRecharge.findOneAndUpdate({ _id: id, status: 'PENDING' }, { $set: { status: 'REJECTED', holdsRef: false, reviewedBy: adminId, reviewedAt: new Date(), reviewNote: reason } }, { new: true });
  if (!r) throw new HttpError(409, 'This recharge has already been reviewed');
  return r;
}

/** Head office correction (positive adds funds, negative removes them). A reason is always recorded. */
export async function adjustBalance(franchiseId: string, i: { amountPaise: number; reason: string }) {
  return withTx(async (session) => {
    const f = await postFranchiseEntry(session, { franchiseId, amountPaise: i.amountPaise, type: 'ADJUSTMENT', refType: 'Adjustment', key: `adj:${new Types.ObjectId()}`, note: i.reason });
    return f.prepaidBalancePaise;
  });
}

export async function adminOverview() {
  const [frs, tiers, pending] = await Promise.all([
    Franchise.find().sort({ code: 1 }).select('code name type tierId prepaidBalancePaise active').lean(),
    FranchiseTier.find().select('name discountPercent').lean(),
    FranchiseRecharge.aggregate([{ $match: { status: 'PENDING' } }, { $group: { _id: '$franchiseId', n: { $sum: '$amountPaise' }, c: { $sum: 1 } } }]),
  ]);
  const rows = frs.map((f) => {
    const t = tiers.find((x) => f.tierId && x._id.equals(f.tierId));
    const p = pending.find((x) => f._id.equals(x._id));
    return { id: f._id.toString(), code: f.code, name: f.name, type: f.type, active: f.active, tier: t?.name ?? null, discountPercent: t?.discountPercent ?? 0, balancePaise: f.prepaidBalancePaise, pendingRechargePaise: p?.n ?? 0, pendingRechargeCount: p?.c ?? 0 };
  });
  return { items: rows, totals: { balancePaise: rows.reduce((n, r) => n + r.balancePaise, 0), pendingRecharges: rows.reduce((n, r) => n + r.pendingRechargeCount, 0) } };
}
