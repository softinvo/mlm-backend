import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Franchise, FranchiseTier, Member, Order, Package, Product, User, Wallet, Zone } from '../models';
import { refundOrder } from '../services/commission.service';
import { placeOrder } from '../services/order.service';
import { payOrder } from '../services/order.service';
import { signToken } from '../utils/jwt';

let rs: MongoMemoryReplSet;
let server: import('node:http').Server;
let base = '';
before(async () => {
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  process.env.MONGODB_URI = rs.getUri();
  process.env.JWT_SECRET = 'test-secret-test-secret-123456';
  await mongoose.connect(rs.getUri());
  await Promise.all(mongoose.modelNames().map((n) => mongoose.model(n).init()));
  const { app } = await import('../app');
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});
after(async () => { server.close(); await mongoose.disconnect(); await rs.stop(); });

interface Acct { userId: string; token: string }
let m1: Acct, m2: Acct, F: any, pkg: string, prod: string;
const mkUser = async (role: any, name: string): Promise<Acct> => {
  const u = await User.create({ role, status: 'ACTIVE', name, email: `${name}@t.com`, phone: String(9800000000 + Math.floor(Math.random() * 9999999)), passwordHash: await bcrypt.hash('Passw0rd!', 4) });
  await Wallet.create({ userId: u._id, type: 'INCOME' });
  return { userId: u._id.toString(), token: signToken({ userId: u._id.toString(), role }) };
};
const call = async (who: Acct, path: string) => {
  const r = await fetch(base + path, { headers: { Authorization: `Bearer ${who.token}` } });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
const buy = async (who: Acct, items: object[], pay?: { gateway: string; ref: string }) => {
  const o = await placeOrder({ buyerUserId: who.userId, franchiseId: F._id, items: items as any });
  if (pay) await payOrder(o._id.toString(), { gateway: pay.gateway, gatewayRef: pay.ref });
  return o._id.toString();
};

beforeEach(async () => {
  await Promise.all(mongoose.modelNames().map((n) => mongoose.model(n).deleteMany({})));
  const owner = await mkUser('REMOTE_FRANCHISE', 'owner'); m1 = await mkUser('MEMBER', 'm1'); m2 = await mkUser('MEMBER', 'm2');
  const zone = await Zone.create({ name: 'Z', states: [] });
  const tier = await FranchiseTier.create({ name: 'Std', discountPercent: 5 });
  F = await Franchise.create({ type: 'ZONAL', code: 'F1', name: 'Pune Point', zoneId: zone._id, ownerUserId: owner.userId, address: 'x', tierId: tier._id });
  await Member.create({ userId: m1.userId, memberCode: 'MEM1', franchiseId: F._id, upline: [] });
  pkg = String((await Package.create({ name: 'Joining Kit', pricePaise: 100_000, imageUrl: 'https://files.example.com/package/k.png' }))._id);
  prod = String((await Product.create({ sku: 'RP-1', name: 'Repurchase Oil', description: 'd', mrpPaise: 20_000, taxPercent: 0, commissionable: true }))._id);
});

describe('member purchase history', () => {
  it('tracks delivery inside the purchase, from packed to delivered', async () => {
    const id = await buy(m1, [{ productId: prod, quantity: 1 }], { gateway: 'COUNTER_UPI', ref: 'FC-9' });
    const { advanceShipment } = await import('../services/order.service');
    await advanceShipment(id, 'PACKED');
    await advanceShipment(id, 'SHIPPED', { courier: 'Delhivery', trackingId: 'DL123' } as any);
    let p = (await call(m1, '/member/purchases?status=shipping')).body.items[0];
    assert.deepEqual([p.shipment.status, p.shipment.courier, p.shipment.trackingId], ['SHIPPED', 'Delhivery', 'DL123']);
    assert.deepEqual(p.shipment.events.map((e: any) => e.status), ['PENDING', 'PACKED', 'SHIPPED']);
    await advanceShipment(id, 'OUT_FOR_DELIVERY');
    await advanceShipment(id, 'DELIVERED');
    assert.equal((await call(m1, '/member/purchases?status=shipping')).body.total, 0, 'delivered orders leave the on-the-way list');
    p = (await call(m1, '/member/purchases?status=delivered')).body.items[0];
    assert.equal(p.shipment.status, 'DELIVERED');
  });

  it('lists what the member bought with prices, shop and payment, and totals only what was paid', async () => {
    await buy(m1, [{ packageId: pkg, quantity: 1 }], { gateway: 'SHOPPING_WALLET', ref: 'W-1' });                  // ₹1,000 paid
    await buy(m1, [{ productId: prod, quantity: 3 }], { gateway: 'COUNTER_CASH', ref: 'FC-1' });                  // ₹600 paid
    await buy(m1, [{ productId: prod, quantity: 1 }]);                                                            // ₹200 not paid yet
    const cancelled = await buy(m1, [{ productId: prod, quantity: 2 }]);
    await Order.updateOne({ _id: cancelled }, { status: 'CANCELLED' });
    await buy(m2, [{ productId: prod, quantity: 9 }], { gateway: 'manual', ref: 'X-1' });                         // someone else's

    const r = (await call(m1, '/member/purchases')).body;
    assert.equal(r.total, 4, 'only my own orders');
    assert.deepEqual(r.summary, { spentPaise: 160_000, refundedPaise: 0, orders: 2, units: 4, lastPurchaseAt: r.summary.lastPurchaseAt });
    const cash = r.items.find((o: any) => o.paymentMethod === 'Cash at the shop');
    assert.deepEqual([cash.shop.name, cash.totalPaise, cash.items[0].name, cash.items[0].quantity, cash.items[0].unitPricePaise, cash.items[0].linePaise, cash.items[0].kind], ['Pune Point', 60_000, 'Repurchase Oil', 3, 20_000, 60_000, 'REPURCHASE']);
    const kit = r.items.find((o: any) => o.paymentMethod === 'Shopping wallet');
    assert.deepEqual([kit.items[0].kind, kit.items[0].imageUrl], ['JOINING', 'https://files.example.com/package/k.png']);

    const ids = (q: string) => call(m1, `/member/purchases?${q}`).then((x) => x.body.items.map((o: any) => o.status));
    assert.deepEqual((await ids('status=awaiting')), ['PLACED']);
    assert.deepEqual((await ids('status=cancelled')), ['CANCELLED']);
    assert.equal((await call(m1, '/member/purchases?status=paid')).body.total, 2);
    assert.equal((await call(m1, '/member/purchases?status=shipping')).body.total, 2, 'paid and not yet delivered');
    assert.equal((await call(m1, '/member/purchases?status=delivered')).body.total, 0);
    assert.equal(cash.shipment.status, 'PENDING', 'delivery progress comes with each purchase');
    assert.equal(cash.shipment.events[0].note, 'Order placed');
    assert.equal((await call(m1, '/member/purchases?type=joining')).body.total, 1);
    assert.equal((await call(m1, '/member/purchases?type=repurchase')).body.total, 3);
    assert.equal((await call(m1, '/member/purchases?status=bogus')).status, 400);
    assert.equal((await call(m1, '/member/purchases?limit=2&page=2')).body.items.length, 2);
    assert.equal((await call(m2, '/member/purchases')).body.total, 1);
  });

  it('shows refunds and counts them against what was spent', async () => {
    const id = await buy(m1, [{ productId: prod, quantity: 5 }], { gateway: 'SHOPPING_WALLET', ref: 'W-2' }); // ₹1,000
    await refundOrder(id, 30_000, 'one damaged');
    const r = (await call(m1, '/member/purchases?status=refunded')).body;
    assert.equal(r.items[0].status, 'PARTIALLY_REFUNDED');
    assert.equal(r.items[0].refundedPaise, 30_000);
    assert.deepEqual([r.summary.spentPaise, r.summary.refundedPaise], [70_000, 30_000]);
  });
});
