/**
 * Commission engine.
 *
 * Rules (the compliance-relevant part):
 *  - Commission is earned only on DELIVERED orders, calculated on commissionable volume (net of tax).
 *  - It is held PENDING through a cooling-off window, then APPROVED and credited to the wallet.
 *  - Refunds claw commission back proportionally (PENDING: just reduced; APPROVED: wallet debited).
 *  - Total payout per order (members + franchises) is capped at plan.maxPayoutPercentOfVolume.
 *  - Nothing is paid for enrollment or joining; there is no commission without a retail order.
 */
import { ClientSession, Types } from 'mongoose';
import {
  Commission, CommissionPlan, Franchise, FranchiseEarning, FranchiseTier, Member, Order, Rank, Ranks, User, Wallet, WalletEntry,
} from '../models';
import { HttpError } from '../utils/http';
import { postEntry } from './ledger.service';
import { reverseForRefund } from './prepaid.service';
import { adjustCashbackForRefund, createCashbackForOrder } from './cashback.service';
import { withTx } from '../utils/tx';

const DAY = 86_400_000;
const coolingOffDays = () => Number(process.env.COOLING_OFF_DAYS ?? 7);
const rankAtLeast = (have: Rank, need: Rank) => Ranks.indexOf(have) >= Ranks.indexOf(need);

interface Payout { kind: 'JOINING' | 'REPURCHASE'; earnerId: Types.ObjectId; level: number; amount: number }

/** Called inside the delivery transaction. Creates PENDING commissions for one order. */
export async function generateCommissions(orderId: Types.ObjectId, now: Date, session: ClientSession) {
  const order = await Order.findById(orderId).session(session);
  if (!order) throw new HttpError(404, 'Order not found');
  const items = order.items;
  const volOf = (pick: (i: (typeof items)[number]) => boolean) => items.filter(pick).reduce((n, i) => n + (i.commissionableVolumePaise ?? 0), 0);
  const volume = volOf(() => true);
  if (volume <= 0) return { volume, payouts: 0 };

  // The plan in force when the order was delivered: newest version whose effectiveFrom has passed.
  // (Older versions stay usable for back-dated orders; `active` only marks the current head version.)
  const plan = await CommissionPlan.findOne({ effectiveFrom: { $lte: now } }).sort({ effectiveFrom: -1, version: -1 }).session(session);
  if (!plan) return { volume, payouts: 0 };

  // Joining packages and repurchases are paid from their own level tables once a repurchase table is set (the plan's
  // "repurchase royalty"); with none, one table covers every purchase, as before. Volume is net of tax and shipping.
  const split = (plan.repurchaseLevels ?? []).length > 0;
  const streams: { kind: Payout['kind']; levels: typeof plan.levels; vol: number }[] = split
    ? [{ kind: 'JOINING', levels: plan.levels, vol: volOf((i) => !!i.packageId) }, { kind: 'REPURCHASE', levels: plan.repurchaseLevels, vol: volOf((i) => !i.packageId) }]
    : [{ kind: 'JOINING', levels: plan.levels, vol: volume }];

  const memberPayouts: Payout[] = [];
  const buyer = await Member.findOne({ userId: order.buyerId }).session(session);
  if (buyer && buyer.upline.length) {
    const upline = await Member.find({ _id: { $in: buyer.upline } }).session(session);
    const users = await User.find({ _id: { $in: upline.map((m) => m.userId) }, status: 'ACTIVE' }).select('_id').session(session);
    const activeUsers = new Set(users.map((u) => u._id.toString()));
    const byId = new Map(upline.map((m) => [m._id.toString(), m]));

    for (const st of streams) {
      if (st.vol <= 0) continue;
      for (const lvl of [...st.levels].sort((a, b) => a.level - b.level)) {
        const earnerId = buyer.upline[lvl.level - 1]; // nearest first: index 0 = direct sponsor
        if (!earnerId) continue;
        const earner = byId.get(earnerId.toString());
        // Inactive/suspended earners and members below the level's minimum rank are skipped (no compression).
        if (!earner || !activeUsers.has(earner.userId.toString()) || !rankAtLeast(earner.rank, lvl.minRank ?? 'ASSOCIATE')) continue;
        const amount = Math.floor((st.vol * lvl.percent) / 100);
        if (amount > 0) memberPayouts.push({ kind: st.kind, earnerId: earner._id, level: lvl.level, amount });
      }
    }
  }

  // Franchises are prepaid: their benefit is the tier discount on what they buy, not a share of sales.
  // The payout cap below therefore covers member commission only.
  const cap = Math.floor((volume * plan.maxPayoutPercentOfVolume) / 100);
  const total = memberPayouts.reduce((n, p) => n + p.amount, 0);
  const scale = total > cap && total > 0 ? cap / total : 1;
  const scaled = <T extends { amount: number }>(p: T) => ({ ...p, amount: Math.floor(p.amount * scale) });

  const memberRows = memberPayouts.map(scaled).filter((p) => p.amount > 0);

  if (memberRows.length) {
    await Commission.insertMany(
      memberRows.map((p) => ({ orderId: order._id, earnerId: p.earnerId, planId: plan._id, level: p.level, kind: p.kind, amountPaise: p.amount, status: 'PENDING', createdAt: now })),
      { session },
    );
  }
  return { volume, payouts: memberRows.length };
}

/** Marks the order delivered and creates its commissions atomically. No-op if already delivered. */
export async function completeDelivery(orderId: string, now: Date, event: { note?: string } = {}) {
  return withTx(async (session) => {
    const order = await Order.findOneAndUpdate(
      { _id: orderId, status: 'PAID', 'shipment.status': { $ne: 'DELIVERED' } },
      {
        $set: {
          status: 'DELIVERED', deliveredAt: now, coolingOffEndsAt: new Date(now.getTime() + coolingOffDays() * DAY),
          'shipment.status': 'DELIVERED',
        },
        $push: { 'shipment.events': { status: 'DELIVERED', at: now, note: event.note ?? 'Delivered' } },
      },
      { new: true, session },
    );
    if (!order) return null; // already delivered, or not in a deliverable state
    await generateCommissions(order._id, now, session);
    await createCashbackForOrder(order._id, now, session);
    return order;
  });
}

async function creditWallet(userId: Types.ObjectId, amount: number, entry: {
  type: 'COMMISSION_CREDIT' | 'FRANCHISE_CREDIT' | 'COMMISSION_REVERSAL'; refType: string; refId: Types.ObjectId; key: string; note: string;
}, session: ClientSession) {
  // Clawbacks (negative) are allowed to take the balance below zero; they are recovered from future earnings.
  await postEntry(session, { userId, wallet: 'INCOME', amountPaise: amount, type: entry.type, refType: entry.refType, refId: entry.refId, key: entry.key, note: entry.note });
}

/** Approves one PENDING commission and credits the earner's wallet. Returns false if it was already handled. */
export async function approveCommission(id: Types.ObjectId, now: Date) {
  return withTx(async (session) => {
    const c = await Commission.findOneAndUpdate({ _id: id, status: 'PENDING' }, { $set: { status: 'APPROVED', approvedAt: now } }, { new: true, session });
    if (!c) return false;
    const effective = c.amountPaise - (c.reversedPaise ?? 0);
    if (effective <= 0) { await Commission.updateOne({ _id: c._id }, { $set: { status: 'REVERSED', reversedAt: now } }, { session }); return false; }
    const member = await Member.findById(c.earnerId).session(session);
    if (!member) throw new HttpError(500, 'Earner not found');
    await creditWallet(member.userId, effective, { type: 'COMMISSION_CREDIT', refType: 'Commission', refId: c._id, key: `credit:${c._id}`, note: `Level ${c.level} commission` }, session);
    return true;
  });
}

export async function approveFranchiseEarning(id: Types.ObjectId, now: Date) {
  return withTx(async (session) => {
    const e = await FranchiseEarning.findOneAndUpdate({ _id: id, status: 'PENDING' }, { $set: { status: 'APPROVED', approvedAt: now } }, { new: true, session });
    if (!e) return false;
    const effective = e.amountPaise - (e.reversedPaise ?? 0);
    if (effective <= 0) { await FranchiseEarning.updateOne({ _id: e._id }, { $set: { status: 'REVERSED', reversedAt: now } }, { session }); return false; }
    const franchise = await Franchise.findById(e.franchiseId).session(session);
    if (!franchise) throw new HttpError(500, 'Franchise not found');
    await creditWallet(franchise.ownerUserId, effective, { type: 'FRANCHISE_CREDIT', refType: 'FranchiseEarning', refId: e._id, key: `credit:${e._id}`, note: `Franchise share (${franchise.code})` }, session);
    return true;
  });
}

/** Approves everything whose order's cooling-off window has ended. Safe to run repeatedly / concurrently. */
export async function approveDueCommissions(now = new Date(), batch = 200) {
  const result = { commissions: 0, franchiseEarnings: 0 };
  const due = (model: typeof Commission | typeof FranchiseEarning) =>
    (model as typeof Commission).aggregate([
      { $match: { status: 'PENDING' } },
      { $lookup: { from: Order.collection.name, localField: 'orderId', foreignField: '_id', as: 'o', pipeline: [{ $project: { coolingOffEndsAt: 1 } }] } },
      { $match: { 'o.coolingOffEndsAt': { $lte: now } } },
      { $limit: batch },
      { $project: { _id: 1 } },
    ]);

  for (let guard = 0; guard < 1000; guard++) {
    const rows: { _id: Types.ObjectId }[] = await due(Commission);
    if (!rows.length) break;
    for (const r of rows) if (await approveCommission(r._id, now)) result.commissions++;
  }
  for (let guard = 0; guard < 1000; guard++) {
    const rows: { _id: Types.ObjectId }[] = await due(FranchiseEarning);
    if (!rows.length) break;
    for (const r of rows) if (await approveFranchiseEarning(r._id, now)) result.franchiseEarnings++;
  }
  return result;
}

/**
 * Records a (partial) refund and claws commission back in proportion.
 * PENDING commission is simply reduced; APPROVED commission is debited from the earner's wallet
 * (which can leave a negative balance that is recovered from future earnings).
 */
export async function refundOrder(orderId: string, amountPaise: number, reason: string, now = new Date()) {
  if (!Number.isInteger(amountPaise) || amountPaise <= 0) throw new HttpError(400, 'Refund amount must be a positive whole number of paise');
  return withTx(async (session) => {
    const order = await Order.findById(orderId).session(session);
    if (!order) throw new HttpError(404, 'Order not found');
    if (!['PAID', 'DELIVERED', 'PARTIALLY_REFUNDED'].includes(order.status)) throw new HttpError(409, `Cannot refund an order that is ${order.status}`);
    const remaining = order.totalPaise - order.refundedPaise;
    if (amountPaise > remaining) throw new HttpError(400, `Refund exceeds the refundable amount (${remaining} paise)`);

    order.refunds.push({ amountPaise, reason, createdAt: now });
    const refundId = order.refunds[order.refunds.length - 1]._id as Types.ObjectId;
    order.refundedPaise += amountPaise;
    order.status = order.refundedPaise >= order.totalPaise ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
    if (order.status === 'REFUNDED' && order.shipment && order.shipment.status !== 'DELIVERED') {
      order.shipment.status = 'CANCELLED';
      order.shipment.events.push({ status: 'CANCELLED', at: now, note: 'Order refunded' });
    }
    await order.save({ session });
    await reverseForRefund(session, order, refundId, amountPaise); // a franchise sale gives back its cost (and any wallet proceeds)

    // Orders paid from the shopping wallet are refunded to it (other payments are refunded through the gateway).
    if (order.payments.some((p) => p.gateway === 'SHOPPING_WALLET')) {
      await postEntry(session, { userId: order.buyerId, wallet: 'SHOPPING', amountPaise, type: 'SHOPPING_REFUND', refType: 'Order', refId: order._id, key: `shoprefund:${refundId}`, note: `Refund for order #${order._id.toString().slice(-6).toUpperCase()}` });
    }

    const remainingRatio = (order.totalPaise - order.refundedPaise) / order.totalPaise;
    const reverse = async (doc: { _id: Types.ObjectId; amountPaise: number; reversedPaise?: number; status: string }, model: typeof Commission | typeof FranchiseEarning, owner: () => Promise<Types.ObjectId>, label: string) => {
      const already = doc.reversedPaise ?? 0;
      const target = doc.amountPaise - Math.floor(doc.amountPaise * remainingRatio); // cumulative amount that should be reversed
      const delta = target - already;
      if (delta <= 0) return;
      const fully = target >= doc.amountPaise;
      await (model as typeof Commission).updateOne(
        { _id: doc._id },
        { $set: { reversedPaise: target, ...(fully ? { status: 'REVERSED', reversedAt: now } : {}) } },
        { session },
      );
      if (doc.status === 'APPROVED') {
        await creditWallet(await owner(), -delta, {
          type: 'COMMISSION_REVERSAL', refType: label, refId: doc._id, key: `reversal:${doc._id}:${refundId}`, note: `Refund clawback (order ${order._id})`,
        }, session);
      }
    };

    for (const c of await Commission.find({ orderId: order._id, status: { $in: ['PENDING', 'APPROVED'] } }).session(session)) {
      await reverse(c, Commission, async () => (await Member.findById(c.earnerId).session(session))!.userId, 'Commission');
    }
    await adjustCashbackForRefund(order._id, refundId, remainingRatio, session);
    for (const e of await FranchiseEarning.find({ orderId: order._id, status: { $in: ['PENDING', 'APPROVED'] } }).session(session)) {
      await reverse(e, FranchiseEarning, async () => (await Franchise.findById(e.franchiseId).session(session))!.ownerUserId, 'FranchiseEarning');
    }
    return order;
  });
}

/** Debug/ops helper: recompute a wallet's balance from its ledger. */
export async function reconcileWallet(userId: string | Types.ObjectId, type: 'INCOME' | 'SHOPPING' = 'INCOME') {
  const wallet = await Wallet.findOne({ userId, type });
  if (!wallet) return null;
  const [sum] = await WalletEntry.aggregate([{ $match: { walletId: wallet._id } }, { $group: { _id: null, total: { $sum: '$amountPaise' } } }]);
  const ledger = sum?.total ?? 0;
  return { cached: wallet.balancePaise, ledger, ok: wallet.balancePaise === ledger };
}
