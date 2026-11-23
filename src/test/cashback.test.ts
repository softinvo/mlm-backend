import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import mongoose, { Types } from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Cashback, Order, User, Wallet, WalletEntry } from '../models';
import { completeDelivery, refundOrder } from '../services/commission.service';
import { cashbackDays, memberCashback, payDueCashback, saveCashbackSettings } from '../services/cashback.service';

let rs: MongoMemoryReplSet;
before(async () => {
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(rs.getUri());
  await Promise.all(mongoose.modelNames().map((n) => mongoose.model(n).init()));
});
after(async () => { await mongoose.disconnect(); await rs.stop(); });

const DAY = 86_400_000;
const T0 = new Date('2026-06-01T10:00:00Z');
const ON = { enabled: true, percentPerDay: 1, maxDays: 30, maxTotalPercent: 30, includePackages: false };
let buyer: Types.ObjectId;

beforeEach(async () => {
  await Promise.all(mongoose.modelNames().map((n) => mongoose.model(n).deleteMany({})));
  const u = await User.create({ role: 'MEMBER', status: 'ACTIVE', name: 'Buyer', email: 'b@t.com', phone: '9000000001', passwordHash: 'x' });
  await Wallet.create({ userId: u._id });
  buyer = u._id;
});

/** A paid order: one product line of ₹1,000 net, plus (optionally) a ₹500 package line. */
async function paidOrder(withPackage = false) {
  const items: object[] = [{ productId: new Types.ObjectId(), quantity: 1, unitPricePaise: 100_000, commissionableVolumePaise: 100_000 }];
  if (withPackage) items.push({ packageId: new Types.ObjectId(), quantity: 1, unitPricePaise: 50_000, commissionableVolumePaise: 50_000 });
  const total = withPackage ? 150_000 : 100_000;
  return Order.create({ buyerId: buyer, franchiseId: new Types.ObjectId(), status: 'PAID', items, subtotalPaise: total, taxPaise: 0, totalPaise: total, paidAt: T0 });
}
const income = async () => (await Wallet.findOne({ userId: buyer, type: 'INCOME' }))!.balancePaise;

describe('purchase cashback', () => {
  it('is off until the head office turns it on', async () => {
    const o = await paidOrder();
    await completeDelivery(o._id.toString(), T0);
    assert.equal(await Cashback.countDocuments({}), 0);
  });

  it('pays 1% a day for 30 days on eligible product value only (not packages), then stops at 30%', async () => {
    await saveCashbackSettings(ON);
    assert.equal(cashbackDays(ON), 30);
    const o = await paidOrder(true);
    await completeDelivery(o._id.toString(), T0);
    const c = (await Cashback.findOne({ orderId: o._id }))!;
    assert.equal(c.baseVolumePaise, 100_000, 'the package line is not eligible');
    assert.equal(c.dailyPaise, 1_000);
    assert.equal(c.daysTotal, 30);

    assert.deepEqual(await payDueCashback(new Date(T0.getTime() + DAY / 2)), { credits: 0, completed: 0 }, 'nothing before a full day');
    assert.equal((await payDueCashback(new Date(T0.getTime() + DAY))).credits, 1);
    assert.equal(await income(), 1_000);
    assert.equal((await payDueCashback(new Date(T0.getTime() + DAY))).credits, 0, 'the same day is never paid twice');
    assert.equal((await payDueCashback(new Date(T0.getTime() + 4 * DAY))).credits, 3, 'missed days are caught up');
    const [a, b] = await Promise.all([payDueCashback(new Date(T0.getTime() + 10 * DAY)), payDueCashback(new Date(T0.getTime() + 10 * DAY))]);
    assert.equal(a.credits + b.credits, 6, 'two runners at once credit each day once');

    const end = await payDueCashback(new Date(T0.getTime() + 90 * DAY));
    assert.equal(end.completed, 1);
    assert.equal(await income(), 30_000, '30% of ₹1,000, no more');
    assert.equal((await Cashback.findOne({ orderId: o._id }))!.status, 'COMPLETED');
    assert.equal(await WalletEntry.countDocuments({ type: 'CASHBACK_CREDIT' }), 30);
    assert.equal((await payDueCashback(new Date(T0.getTime() + 200 * DAY))).credits, 0, 'never for life');
  });

  it('can include packages when the head office allows it', async () => {
    await saveCashbackSettings({ ...ON, includePackages: true });
    const o = await paidOrder(true);
    await completeDelivery(o._id.toString(), T0);
    assert.equal((await Cashback.findOne({ orderId: o._id }))!.baseVolumePaise, 150_000);
  });

  it('keeps the rules it was delivered under, even if the settings change later', async () => {
    await saveCashbackSettings(ON);
    const o = await paidOrder();
    await completeDelivery(o._id.toString(), T0);
    await saveCashbackSettings({ ...ON, percentPerDay: 2 });
    await payDueCashback(new Date(T0.getTime() + 2 * DAY));
    assert.equal(await income(), 2_000, 'still 1% a day');
  });

  it('a partial refund shrinks the daily amount and takes back the part already paid', async () => {
    await saveCashbackSettings(ON);
    const o = await paidOrder();
    await completeDelivery(o._id.toString(), T0);
    await payDueCashback(new Date(T0.getTime() + 10 * DAY));
    assert.equal(await income(), 10_000);
    await refundOrder(o._id.toString(), 50_000, 'half returned', new Date(T0.getTime() + 10 * DAY));
    assert.equal(await income(), 5_000, 'half of what was paid is taken back');
    const c = (await Cashback.findOne({ orderId: o._id }))!;
    assert.equal(c.dailyPaise, 500);
    await payDueCashback(new Date(T0.getTime() + 12 * DAY));
    assert.equal(await income(), 6_000, 'two more days at the lower rate');
  });

  it('a full refund cancels the rest and takes everything back', async () => {
    await saveCashbackSettings(ON);
    const o = await paidOrder();
    await completeDelivery(o._id.toString(), T0);
    await payDueCashback(new Date(T0.getTime() + 5 * DAY));
    await refundOrder(o._id.toString(), 100_000, 'returned', new Date(T0.getTime() + 5 * DAY));
    assert.equal(await income(), 0);
    assert.equal((await Cashback.findOne({ orderId: o._id }))!.status, 'CANCELLED');
    assert.equal((await payDueCashback(new Date(T0.getTime() + 40 * DAY))).credits, 0);
    assert.equal(await income(), 0);
  });

  it('shows a member their totals and each purchase', async () => {
    await saveCashbackSettings(ON);
    const o = await paidOrder();
    await completeDelivery(o._id.toString(), T0);
    await payDueCashback(new Date(T0.getTime() + 3 * DAY));
    const m = await memberCashback(buyer.toString());
    assert.equal(m.totals.earnedPaise, 3_000);
    assert.equal(m.totals.upcomingPaise, 27_000);
    assert.equal(m.totals.active, 1);
    assert.equal(m.items[0].daysPaid, 3);
    assert.equal(m.config.days, 30);
  });

  it('limits the days when the total cap is reached first', () => {
    assert.equal(cashbackDays({ ...ON, maxTotalPercent: 10 }), 10);
    assert.equal(cashbackDays({ ...ON, maxDays: 7 }), 7);
  });
});
