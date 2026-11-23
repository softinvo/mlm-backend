/**
 * Purchase cashback.
 *
 * Rules (set by the head office, off by default):
 *  - Only delivered orders qualify, and only the net product value of eligible lines (packages / joining kits are excluded unless allowed).
 *  - The buyer gets `percentPerDay` of that value each day for at most `maxDays` days and at most `maxTotalPercent` of it in all.
 *  - Credits go to the buyer's income wallet, so the normal withdrawal rules apply. Nothing is paid for life, and nothing depends on a repurchase.
 *  - A refund cancels what is left and takes back the part already paid that the refund covers.
 */
import { ClientSession, Types } from 'mongoose';
import { Cashback, CashbackSettings, Order } from '../models';
import { postEntry } from './ledger.service';
import { withTx } from '../utils/tx';

const DAY = 86_400_000;

export interface CashbackConfig { enabled: boolean; percentPerDay: number; maxDays: number; maxTotalPercent: number; includePackages: boolean }

export async function getCashbackSettings(session?: ClientSession): Promise<CashbackConfig> {
  const d = await CashbackSettings.findOne({ key: 'cashback' }).session(session ?? null).lean();
  return { enabled: d?.enabled ?? false, percentPerDay: d?.percentPerDay ?? 1, maxDays: d?.maxDays ?? 30, maxTotalPercent: d?.maxTotalPercent ?? 30, includePackages: d?.includePackages ?? false };
}

export async function saveCashbackSettings(c: CashbackConfig) {
  await CashbackSettings.findOneAndUpdate({ key: 'cashback' }, { $set: c }, { upsert: true, new: true });
  return getCashbackSettings();
}

/** How many daily credits one purchase gets: limited by both the day cap and the total-percent cap. */
export const cashbackDays = (c: CashbackConfig) => Math.max(0, Math.min(c.maxDays, Math.floor((c.maxTotalPercent / c.percentPerDay) + 1e-9)));

/** Called inside the delivery transaction. No-op when cashback is off or the order has nothing eligible. */
export async function createCashbackForOrder(orderId: Types.ObjectId, now: Date, session: ClientSession) {
  const cfg = await getCashbackSettings(session);
  if (!cfg.enabled) return null;
  const order = await Order.findById(orderId).session(session);
  if (!order) return null;
  const base = order.items.filter((i) => cfg.includePackages || !i.packageId).reduce((n, i) => n + (i.commissionableVolumePaise ?? 0), 0);
  const days = cashbackDays(cfg);
  const daily = Math.floor((base * cfg.percentPerDay) / 100);
  if (base <= 0 || days <= 0 || daily <= 0) return null;
  const [row] = await Cashback.create([{ orderId: order._id, userId: order.buyerId, baseVolumePaise: base, percentPerDay: cfg.percentPerDay, dailyPaise: daily, daysTotal: days, startedAt: now }], { session });
  return row;
}

/** Credits every daily instalment that has come due. Safe to run repeatedly and from several servers at once. */
export async function payDueCashback(now = new Date(), batch = 200) {
  const result = { credits: 0, completed: 0 };
  for (let guard = 0; guard < 1000; guard++) {
    const rows = await Cashback.find({ status: 'ACTIVE', startedAt: { $lte: new Date(now.getTime() - DAY) } }).sort({ startedAt: 1 }).limit(batch).select('_id').lean();
    if (!rows.length) break;
    let progressed = false;
    for (const r of rows) {
      const out = await withTx(async (session) => {
        const c = await Cashback.findOne({ _id: r._id, status: 'ACTIVE' }).session(session);
        if (!c) return null;
        const reached = Math.min(c.daysTotal, Math.floor((now.getTime() - c.startedAt.getTime()) / DAY));
        const due = reached - c.daysPaid;
        if (due <= 0) return null;
        // claim the days first: a concurrent runner loses this race and does nothing
        const done = reached >= c.daysTotal;
        const claimed = await Cashback.findOneAndUpdate(
          { _id: c._id, status: 'ACTIVE', daysPaid: c.daysPaid },
          { $set: { daysPaid: reached, ...(done ? { status: 'COMPLETED' } : {}) }, $inc: { paidPaise: due * c.dailyPaise } },
          { new: true, session },
        );
        if (!claimed) return null;
        for (let day = c.daysPaid + 1; day <= reached; day++) {
          await postEntry(session, { userId: c.userId, wallet: 'INCOME', amountPaise: c.dailyPaise, type: 'CASHBACK_CREDIT', refType: 'Cashback', refId: c._id, key: `cashback:${c._id}:${day}`, note: `Cashback day ${day} of ${c.daysTotal}` });
        }
        return { days: due, done };
      });
      if (out) { result.credits += out.days; if (out.done) result.completed++; progressed = true; }
    }
    if (!progressed || rows.length < batch) break;
  }
  return result;
}

/** Called from a refund: shrink what is still to come and take back the part already paid that the refund covers. */
export async function adjustCashbackForRefund(orderId: Types.ObjectId, refundId: Types.ObjectId, remainingRatio: number, session: ClientSession) {
  const c = await Cashback.findOne({ orderId }).session(session);
  if (!c || c.status === 'CANCELLED') return;
  const newDailyPaise = Math.floor((Math.floor(c.baseVolumePaise * Math.max(0, remainingRatio)) * c.percentPerDay) / 100);
  const shouldHavePaid = newDailyPaise * c.daysPaid;
  const takeBack = Math.max(0, c.paidPaise - shouldHavePaid);
  if (takeBack > 0) {
    await postEntry(session, { userId: c.userId, wallet: 'INCOME', amountPaise: -takeBack, type: 'CASHBACK_REVERSAL', refType: 'Cashback', refId: c._id, key: `cashbackrev:${c._id}:${refundId}`, note: `Refund clawback (order ${orderId})` });
  }
  const gone = remainingRatio <= 0 || newDailyPaise <= 0;
  await Cashback.updateOne({ _id: c._id }, { $set: { dailyPaise: newDailyPaise, paidPaise: c.paidPaise - takeBack, ...(gone ? { status: 'CANCELLED' } : {}) } }, { session });
}

/** A member's cashback: totals and each purchase's progress. */
export async function memberCashback(userId: string) {
  const [cfg, rows] = await Promise.all([getCashbackSettings(), Cashback.find({ userId }).sort({ startedAt: -1 }).limit(100).lean()]);
  const items = rows.map((c) => {
    const left = c.status === 'ACTIVE' ? c.daysTotal - c.daysPaid : 0;
    return {
      id: c._id.toString(), orderId: c.orderId.toString(), baseVolumePaise: c.baseVolumePaise, percentPerDay: c.percentPerDay, dailyPaise: c.dailyPaise,
      daysTotal: c.daysTotal, daysPaid: c.daysPaid, paidPaise: c.paidPaise, remainingPaise: left * c.dailyPaise, status: c.status, startedAt: c.startedAt,
      nextCreditAt: c.status === 'ACTIVE' ? new Date(c.startedAt.getTime() + (c.daysPaid + 1) * DAY) : null,
    };
  });
  return {
    config: { ...cfg, days: cashbackDays(cfg) },
    totals: { earnedPaise: items.reduce((n, i) => n + i.paidPaise, 0), upcomingPaise: items.reduce((n, i) => n + i.remainingPaise, 0), active: items.filter((i) => i.status === 'ACTIVE').length },
    items,
  };
}
