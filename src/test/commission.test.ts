import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import mongoose, { Types } from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  Commission, CommissionPlan, Franchise, FranchiseEarning, Member, Order, Package, Product, Rank, User, Wallet, WalletEntry, Zone,
} from '../models';
import { approveDueCommissions, reconcileWallet, refundOrder } from '../services/commission.service';
import { advanceShipment, cancelOrder, payOrder, placeOrder } from '../services/order.service';

const DAY = 86_400_000;
let rs: MongoMemoryReplSet;

before(async () => {
  process.env.COOLING_OFF_DAYS = '7';
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(rs.getUri());
  await Promise.all(mongoose.modelNames().map((n) => mongoose.model(n).init())); // build unique indexes
});
after(async () => { await mongoose.disconnect(); await rs.stop(); });

interface World {
  remote: any; zonal: any;
  chain: { userId: Types.ObjectId; memberId: Types.ObjectId }[]; // [M1 (top), M2, M3]
  buyer: { userId: Types.ObjectId; memberId: Types.ObjectId };
  pkgA: any;
}
let w: World;

async function mkUser(name: string, role: 'MEMBER' | 'REMOTE_FRANCHISE' | 'ZONAL_FRANCHISE' = 'MEMBER', status = 'ACTIVE') {
  const u = await User.create({ role, status, name, email: `${name}@t.com`, phone: String(9000000000 + Math.floor(Math.random() * 99999999)), passwordHash: 'x' });
  await Wallet.create({ userId: u._id });
  return u;
}
async function mkMember(u: { _id: Types.ObjectId }, code: string, sponsor: { _id: Types.ObjectId; upline: Types.ObjectId[] } | null, franchiseId: Types.ObjectId, rank: Rank = 'ASSOCIATE') {
  return Member.create({ userId: u._id, memberCode: code, sponsorId: sponsor?._id ?? null, upline: sponsor ? [sponsor._id, ...sponsor.upline] : [], franchiseId, rank });
}
const setPlan = async (levels: { level: number; percent: number; minRank?: Rank }[], cap = 25) => {
  await CommissionPlan.deleteMany({});
  return CommissionPlan.create({ version: 1, effectiveFrom: new Date(0), active: true, maxPayoutPercentOfVolume: cap, levels });
};

beforeEach(async () => {
  await Promise.all(mongoose.modelNames().map((n) => mongoose.model(n).deleteMany({})));
  const zone = await Zone.create({ name: 'Z', states: [] });
  const zu = await mkUser('zonalowner', 'ZONAL_FRANCHISE'), ru = await mkUser('remoteowner', 'REMOTE_FRANCHISE');
  const zonal = await Franchise.create({ type: 'ZONAL', code: 'Z1', name: 'Zonal', zoneId: zone._id, ownerUserId: zu._id, address: 'x', commissionPercent: 1 });
  const remote = await Franchise.create({ type: 'REMOTE', code: 'R1', name: 'Remote', zoneId: zone._id, parentId: zonal._id, ownerUserId: ru._id, address: 'x', commissionPercent: 2 });

  const u1 = await mkUser('m1'), u2 = await mkUser('m2'), u3 = await mkUser('m3'), ub = await mkUser('buyer');
  const m1 = await mkMember(u1, 'M1', null, remote._id);
  const m2 = await mkMember(u2, 'M2', m1, remote._id);
  const m3 = await mkMember(u3, 'M3', m2, remote._id);
  const mb = await mkMember(ub, 'MB', m3, remote._id);
  const pkgA = await Package.create({ name: 'Package A', pricePaise: 55000 });
  await setPlan([{ level: 1, percent: 10 }, { level: 2, percent: 5 }, { level: 3, percent: 3 }]);
  w = {
    remote, zonal, pkgA,
    chain: [{ userId: u1._id, memberId: m1._id }, { userId: u2._id, memberId: m2._id }, { userId: u3._id, memberId: m3._id }],
    buyer: { userId: ub._id, memberId: mb._id },
  };
});

const deliver = async (items: any[] = [{ packageId: String(w.pkgA._id), quantity: 1 }], when = new Date('2026-01-01T00:00:00Z'), buyer = w.buyer.userId) => {
  const o = await placeOrder({ buyerUserId: String(buyer), franchiseId: w.remote._id, items, now: when });
  const id = String(o._id);
  await payOrder(id, { gateway: 't', gatewayRef: 'pay-' + id, now: when });
  await advanceShipment(id, 'PACKED', { now: when });
  await advanceShipment(id, 'SHIPPED', { courier: 'C', trackingId: 'T1', now: when });
  await advanceShipment(id, 'DELIVERED', { now: when });
  return id;
};
const balance = async (userId: Types.ObjectId) => (await Wallet.findOne({ userId }))!.balancePaise;
const T0 = new Date('2026-01-01T00:00:00Z');

describe('commission generation', () => {
  it('pays each upline level a % of volume, all PENDING (franchises earn nothing here)', async () => {
    const id = await deliver();
    const rows = await Commission.find({ orderId: id }).sort({ level: 1 });
    assert.deepEqual(rows.map((r) => [r.level, r.amountPaise, r.status]), [[1, 5500, 'PENDING'], [2, 2750, 'PENDING'], [3, 1650, 'PENDING']]);
    assert.equal(String(rows[0].earnerId), String(w.chain[2].memberId), 'level 1 is the direct sponsor (M3)');
    assert.equal(String(rows[2].earnerId), String(w.chain[0].memberId));
    assert.equal(await FranchiseEarning.countDocuments({ orderId: id }), 0, 'franchises are prepaid: they get a discount, not a share of sales');
    const order = await Order.findById(id);
    assert.equal(order!.status, 'DELIVERED');
    assert.equal(order!.coolingOffEndsAt!.getTime(), T0.getTime() + 7 * DAY);
    assert.equal(await balance(w.chain[2].userId), 0, 'nothing is paid out before cooling-off ends');
  });

  it('is idempotent: a second delivery is rejected and creates nothing', async () => {
    const id = await deliver();
    await assert.rejects(advanceShipment(id, 'DELIVERED', { now: T0 }), /already DELIVERED/);
    assert.equal(await Commission.countDocuments({ orderId: id }), 3);
  });

  it('caps total payout at maxPayoutPercentOfVolume by scaling everything down', async () => {
    await setPlan([{ level: 1, percent: 30 }, { level: 2, percent: 20 }], 25);
    const id = await deliver();
    const sum = (await Commission.find({ orderId: id })).reduce((n, c) => n + c.amountPaise, 0)
      + (await FranchiseEarning.find({ orderId: id })).reduce((n, c) => n + c.amountPaise, 0);
    assert.ok(sum <= 13750 && sum >= 13750 - 5, `total ${sum} should be ~cap 13750`);
  });

  it('skips suspended earners and members below the level minimum rank (no compression)', async () => {
    await User.updateOne({ _id: w.chain[1].userId }, { status: 'SUSPENDED' }); // M2 = level 2
    await setPlan([{ level: 1, percent: 10, minRank: 'SILVER' }, { level: 2, percent: 5 }, { level: 3, percent: 3 }]);
    const id = await deliver(); // M3 is ASSOCIATE (< SILVER), M2 suspended -> only level 3 (M1)
    const rows = await Commission.find({ orderId: id });
    assert.deepEqual(rows.map((r) => [r.level, r.amountPaise]), [[3, 1650]]);
  });

  it('uses tax-exclusive volume and ignores non-commissionable products', async () => {
    const taxed = await Package.create({ name: 'Taxed', pricePaise: 11800, taxPercent: 18 });
    const plain = await Product.create({ sku: 'P', name: 'Gift', description: 'd', mrpPaise: 10000, taxPercent: 0, commissionable: false });
    const id = await deliver([{ packageId: String(taxed._id), quantity: 1 }, { productId: String(plain._id), quantity: 1 }]);
    const order = await Order.findById(id);
    assert.equal(order!.totalPaise, 21800);
    assert.equal(order!.taxPaise, 1800);
    const l1 = await Commission.findOne({ orderId: id, level: 1 });
    assert.equal(l1!.amountPaise, 1000, '10% of 10,000 net volume; the gift adds nothing');
  });

  it('uses the plan version in force at delivery time, not the newest one', async () => {
    await CommissionPlan.updateMany({}, { active: false });
    await CommissionPlan.create({ version: 2, effectiveFrom: new Date('2026-06-01T00:00:00Z'), active: true, maxPayoutPercentOfVolume: 25, levels: [{ level: 1, percent: 20 }] });
    const before = await deliver(undefined, new Date('2026-01-01T00:00:00Z')); // v1: 10%
    const after = await deliver(undefined, new Date('2026-07-01T00:00:00Z'));  // v2: 20%
    assert.equal((await Commission.findOne({ orderId: before, level: 1 }))!.amountPaise, 5500);
    assert.equal((await Commission.findOne({ orderId: after, level: 1 }))!.amountPaise, 11000);
    assert.equal(await Commission.countDocuments({ orderId: after }), 1, 'v2 only defines level 1');
  });

  it('pays nothing when the buyer is not a member (there is no upline)', async () => {
    const cust = await mkUser('cust');
    const id = await deliver(undefined, T0, cust._id);
    assert.equal(await Commission.countDocuments({ orderId: id }), 0);
    assert.equal(await FranchiseEarning.countDocuments({ orderId: id }), 0);
  });
});

describe('approval and wallet credit', () => {
  it('holds commission through the cooling-off window, then credits wallets once', async () => {
    await deliver();
    assert.deepEqual(await approveDueCommissions(new Date(T0.getTime() + 6 * DAY)), { commissions: 0, franchiseEarnings: 0 });
    const done = await approveDueCommissions(new Date(T0.getTime() + 8 * DAY));
    assert.deepEqual(done, { commissions: 3, franchiseEarnings: 0 });
    assert.equal(await balance(w.chain[2].userId), 5500);
    assert.equal(await balance(w.chain[0].userId), 1650);
    // re-running must not double pay
    assert.deepEqual(await approveDueCommissions(new Date(T0.getTime() + 9 * DAY)), { commissions: 0, franchiseEarnings: 0 });
    assert.equal(await balance(w.chain[2].userId), 5500);
    for (const u of w.chain) assert.ok((await reconcileWallet(u.userId))!.ok, 'cached balance equals ledger');
  });

  it('runs safely when two approval jobs overlap', async () => {
    await deliver();
    const at = new Date(T0.getTime() + 8 * DAY);
    const [a, b] = await Promise.all([approveDueCommissions(at), approveDueCommissions(at)]);
    assert.equal(a.commissions + b.commissions, 3);
    assert.equal(await balance(w.chain[2].userId), 5500);
    assert.equal(await WalletEntry.countDocuments({ type: 'COMMISSION_CREDIT' }), 3);
  });
});

describe('refunds', () => {
  it('reduces PENDING commission proportionally on a partial refund', async () => {
    const id = await deliver();
    await refundOrder(id, 27500, 'half returned', new Date(T0.getTime() + DAY)); // 50%
    const l1 = await Commission.findOne({ orderId: id, level: 1 });
    assert.equal(l1!.reversedPaise, 2750);
    assert.equal(l1!.status, 'PENDING');
    await approveDueCommissions(new Date(T0.getTime() + 8 * DAY));
    assert.equal(await balance(w.chain[2].userId), 2750, 'only the effective half is credited');
    assert.equal((await Order.findById(id))!.status, 'PARTIALLY_REFUNDED');
  });

  it('claws back APPROVED commission from the wallet on a full refund', async () => {
    const id = await deliver();
    await approveDueCommissions(new Date(T0.getTime() + 8 * DAY));
    assert.equal(await balance(w.chain[2].userId), 5500);
    await refundOrder(id, 55000, 'returned', new Date(T0.getTime() + 9 * DAY));
    assert.equal(await balance(w.chain[2].userId), 0);
    assert.equal(await balance(w.chain[0].userId), 0);
    const rows = await Commission.find({ orderId: id });
    assert.ok(rows.every((r) => r.status === 'REVERSED' && r.reversedPaise === r.amountPaise));
    assert.equal((await Order.findById(id))!.status, 'REFUNDED');
    for (const u of w.chain) assert.ok((await reconcileWallet(u.userId))!.ok);
  });

  it('handles two partial refunds that add up to the whole', async () => {
    const id = await deliver();
    await approveDueCommissions(new Date(T0.getTime() + 8 * DAY));
    await refundOrder(id, 20000, 'a', new Date(T0.getTime() + 9 * DAY));
    await refundOrder(id, 35000, 'b', new Date(T0.getTime() + 10 * DAY));
    assert.equal(await balance(w.chain[2].userId), 0);
    assert.equal(await balance(w.chain[1].userId), 0);
    assert.equal((await Commission.findOne({ orderId: id, level: 1 }))!.status, 'REVERSED');
  });

  it('rejects over-refunds', async () => {
    const id = await deliver();
    await assert.rejects(refundOrder(id, 55001, 'too much'), /exceeds/);
    await assert.rejects(refundOrder(id, 0, 'zero'), /positive/);
  });
});

describe('order lifecycle', () => {
  it('validates items and prices from the catalog', async () => {
    const bad = (items: any[]) => placeOrder({ buyerUserId: String(w.buyer.userId), franchiseId: w.remote._id, items });
    await assert.rejects(bad([]), /at least one/);
    await assert.rejects(bad([{ packageId: String(w.pkgA._id), quantity: 0 }]), /Quantity/);
    await assert.rejects(bad([{ quantity: 1 }]), /packageId or productId/);
    await Package.updateOne({ _id: w.pkgA._id }, { active: false });
    await assert.rejects(bad([{ packageId: String(w.pkgA._id), quantity: 1 }]), /not available/);
  });

  it('payment is idempotent per gatewayRef and checks the amount', async () => {
    const o = await placeOrder({ buyerUserId: String(w.buyer.userId), franchiseId: w.remote._id, items: [{ packageId: String(w.pkgA._id), quantity: 2 }] });
    assert.equal(o.totalPaise, 110000);
    await assert.rejects(payOrder(String(o._id), { gateway: 'g', gatewayRef: 'r1', amountPaise: 1 }), /does not match/);
    await payOrder(String(o._id), { gateway: 'g', gatewayRef: 'r1' });
    await payOrder(String(o._id), { gateway: 'g', gatewayRef: 'r1' }); // retry
    assert.equal((await Order.findById(o._id))!.payments.length, 1);
    await assert.rejects(payOrder(String(o._id), { gateway: 'g', gatewayRef: 'r2' }), /already PAID/);
  });

  it('enforces shipment order and requires courier details', async () => {
    const o = await placeOrder({ buyerUserId: String(w.buyer.userId), franchiseId: w.remote._id, items: [{ packageId: String(w.pkgA._id), quantity: 1 }] });
    const id = String(o._id);
    await assert.rejects(advanceShipment(id, 'PACKED'), /Only paid/);
    await payOrder(id, { gateway: 'g', gatewayRef: 'r' });
    await assert.rejects(advanceShipment(id, 'SHIPPED'), /courier and trackingId/);
    await advanceShipment(id, 'SHIPPED', { courier: 'C', trackingId: 'T' });
    await assert.rejects(advanceShipment(id, 'PACKED'), /already SHIPPED/);
  });

  it('cancelling a paid, unshipped order refunds it and never creates commission', async () => {
    const o = await placeOrder({ buyerUserId: String(w.buyer.userId), franchiseId: w.remote._id, items: [{ packageId: String(w.pkgA._id), quantity: 1 }] });
    await payOrder(String(o._id), { gateway: 'g', gatewayRef: 'r' });
    const c = await cancelOrder(String(o._id), 'changed mind');
    assert.equal(c.status, 'REFUNDED');
    assert.equal(c.shipment!.status, 'CANCELLED');
    assert.equal(await Commission.countDocuments({}), 0);
    const shipped = await deliver();
    await assert.rejects(cancelOrder(shipped, 'late'), /not shipped/);
  });
  describe('repurchase royalty (its own 10-level table on product purchases)', () => {
    const ROYALTY = [4, 1, 1, 1, 1, 1, 0.5, 0.5, 0.5, 0.5].map((percent, i) => ({ level: i + 1, percent }));
    const withRoyalty = async () => {
      const plan = await CommissionPlan.findOne({ active: true });
      await CommissionPlan.updateOne({ _id: plan!._id }, { $set: { maxPayoutPercentOfVolume: 50, repurchaseLevels: ROYALTY } });
    };
    const product = () => Product.create({ sku: 'RP-X', name: 'Repurchase item', description: 'd', mrpPaise: 220_000, taxPercent: 0, commissionable: true, active: true });

    it('pays the royalty table on product purchases and the joining table only on packages', async () => {
      await withRoyalty();
      const p = await product();
      const id = await deliver([{ productId: String(p._id), quantity: 1 }]);
      const rows = await Commission.find({ orderId: id }).sort({ level: 1 });
      // chain above the buyer: M3 (L1), M2 (L2), M1 (L3). ₹2,200 net: L1 4% = ₹88, L2 1% = ₹22, L3 1% = ₹22
      assert.deepEqual(rows.map((r) => [r.level, r.kind, r.amountPaise]), [[1, 'REPURCHASE', 8_800], [2, 'REPURCHASE', 2_200], [3, 'REPURCHASE', 2_200]]);
      const pkg = await deliver([{ packageId: String(w.pkgA._id), quantity: 1 }]);
      const joining = await Commission.find({ orderId: pkg });
      assert.ok(joining.every((r) => r.kind === 'JOINING'), 'a package pays the joining table, not the royalty');
      assert.equal(joining.find((r) => r.level === 1)!.amountPaise, 5_500, 'level 1 of the plan table: 10% of ₹550');
    });

    it('a mixed order pays each part from its own table', async () => {
      await withRoyalty();
      const p = await product();
      const id = await deliver([{ packageId: String(w.pkgA._id), quantity: 1 }, { productId: String(p._id), quantity: 1 }]);
      const l1 = (await Commission.find({ orderId: id, level: 1 })).map((r) => [r.kind, r.amountPaise]).sort();
      assert.deepEqual(l1, [['JOINING', 5_500], ['REPURCHASE', 8_800]]);
    });

    it('without a repurchase table the one level table covers every purchase, as before', async () => {
      const p = await product();
      const id = await deliver([{ productId: String(p._id), quantity: 1 }]);
      assert.equal((await Commission.findOne({ orderId: id, level: 1 }))!.amountPaise, 22_000, '10% of ₹2,200');
    });

    it('a refund claws the royalty back in proportion', async () => {
      await withRoyalty();
      const p = await product();
      const id = await deliver([{ productId: String(p._id), quantity: 1 }]);
      await approveDueCommissions(new Date(T0.getTime() + 8 * DAY));
      await refundOrder(id, 110_000, 'half returned', new Date(T0.getTime() + 9 * DAY));
      const l1 = (await Commission.findOne({ orderId: id, level: 1 }))!;
      assert.equal(l1.reversedPaise, 4_400, 'half of ₹88');
    });
  });
});
