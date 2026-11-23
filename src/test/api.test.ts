import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Franchise, Member, Order, Package, ShippingAddress, User, Wallet, Zone } from '../models';
import { postEntry } from '../services/ledger.service';
import { signToken } from '../utils/jwt';
import { withTx } from '../utils/tx';

let rs: MongoMemoryReplSet;
let server: import('node:http').Server;
let base = '';

before(async () => {
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  process.env.MONGODB_URI = rs.getUri();
  process.env.JWT_SECRET = 'test-secret-test-secret-123456';
  await mongoose.connect(rs.getUri());
  await Promise.all(mongoose.modelNames().map((n) => mongoose.model(n).init()));
  const { app } = await import('../app'); // imported after env is set
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});
after(async () => { server.close(); await mongoose.disconnect(); await rs.stop(); });

interface Who { userId: string; token: string; addressId: string }
let me: Who, other: Who, pkgId: string;

async function mkMember(name: string, franchiseId: unknown): Promise<Who> {
  const u = await User.create({ role: 'MEMBER', status: 'ACTIVE', name, email: `${name}@t.com`, phone: String(9000000000 + Math.floor(Math.random() * 99999999)), passwordHash: 'x' });
  await Wallet.create({ userId: u._id, type: 'INCOME' });
  await Member.create({ userId: u._id, memberCode: name.toUpperCase(), franchiseId, upline: [] });
  const a = await ShippingAddress.create({ userId: u._id, fullName: name, phone: '9876543210', line1: '1 Main Road', city: 'Pune', state: 'Maharashtra', pincode: '411001', isDefault: true });
  return { userId: u._id.toString(), token: signToken({ userId: u._id.toString(), role: 'MEMBER' }), addressId: a._id.toString() };
}

beforeEach(async () => {
  await Promise.all(mongoose.modelNames().map((n) => mongoose.model(n).deleteMany({})));
  const zone = await Zone.create({ name: 'Z', states: [] });
  const owner = await User.create({ role: 'REMOTE_FRANCHISE', status: 'ACTIVE', name: 'o', email: 'o@t.com', phone: '9000000002', passwordHash: 'x' });
  const fr = await Franchise.create({ type: 'ZONAL', code: 'Z1', name: 'F', zoneId: zone._id, ownerUserId: owner._id, address: 'x', commissionPercent: 0 });
  pkgId = String((await Package.create({ name: 'Package A', description: 'Sample', pricePaise: 55000 }))._id);
  me = await mkMember('me', fr._id);
  other = await mkMember('other', fr._id);
});

const call = async (who: Who | null, method: string, path: string, body?: unknown) => {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(who ? { Authorization: `Bearer ${who.token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
const fundShopping = (userId: string, amount: number) =>
  withTx((s) => postEntry(s, { userId, wallet: 'SHOPPING', amountPaise: amount, type: 'ADJUSTMENT', key: `f:${Math.random()}` }));
const order = (extra: object = {}) => ({ items: [{ packageId: pkgId, quantity: 2 }], addressId: me.addressId, ...extra });

describe('shop API', () => {
  it('lists the catalog for signed-in members only', async () => {
    assert.equal((await call(null, 'GET', '/member/catalog')).status, 401);
    const r = await call(me, 'GET', '/member/catalog');
    assert.deepEqual(r.body.packages.map((p: any) => [p.name, p.pricePaise, p.description]), [['Package A', 55000, 'Sample']]);
  });

  it('requires a delivery address you own and valid items', async () => {
    assert.equal((await call(me, 'POST', '/member/orders', { items: [{ packageId: pkgId, quantity: 1 }] })).status, 400);
    assert.equal((await call(me, 'POST', '/member/orders', order({ addressId: other.addressId }))).status, 400, "someone else's address");
    assert.equal((await call(me, 'POST', '/member/orders', order({ items: [] }))).status, 400);
    assert.equal((await call(me, 'POST', '/member/orders', order({ items: [{ packageId: pkgId, quantity: 0 }] }))).status, 400);
    assert.equal(await Order.countDocuments({}), 0);
  });

  it('reserves an unpaid order, using server-side prices and a copy of the address', async () => {
    const r = await call(me, 'POST', '/member/orders', order());
    assert.equal(r.status, 201);
    assert.equal(r.body.totalPaise, 110000);
    assert.equal(r.body.paymentStatus, 'AWAITING_PAYMENT');
    assert.equal(r.body.items[0].name, 'Package A');
    assert.equal(r.body.address.pincode, '411001');
    await ShippingAddress.deleteMany({});
    assert.equal((await call(me, 'GET', `/member/orders/${r.body.id}`)).body.address.line1, '1 Main Road', 'order keeps its own address copy');
    const hist = await call(me, 'GET', '/member/shipping-history');
    assert.equal(hist.body.items[0].awaitingPayment, true);
  });

  it('is retry-safe: the same clientKey never creates a second order, even when requests race', async () => {
    const key = 'checkout-1234567890';
    const results = await Promise.all(Array.from({ length: 5 }, () => call(me, 'POST', '/member/orders', order({ clientKey: key }))));
    assert.ok(results.every((r) => [200, 201].includes(r.status)), JSON.stringify(results.map((r) => r.status)));
    assert.equal(new Set(results.map((r) => r.body.id)).size, 1);
    assert.equal(await Order.countDocuments({}), 1);
    assert.equal((await call(me, 'POST', '/member/orders', order({ clientKey: key }))).status, 200);
  });

  it('pays at checkout from the shopping wallet, and a failed payment leaves no open order', async () => {
    const poor = await call(me, 'POST', '/member/orders', order({ payWith: 'SHOPPING_WALLET' }));
    assert.equal(poor.status, 400);
    assert.match(poor.body.error, /Insufficient/);
    assert.deepEqual((await Order.find({})).map((o) => o.status), ['CANCELLED'], 'no dangling PLACED order');

    await fundShopping(me.userId, 150000);
    const ok = await call(me, 'POST', '/member/orders', order({ payWith: 'SHOPPING_WALLET' }));
    assert.equal(ok.status, 201);
    assert.equal(ok.body.paymentStatus, 'PAID');
    assert.equal(ok.body.paidWith, 'SHOPPING_WALLET');
    assert.equal((await Wallet.findOne({ userId: me.userId, type: 'SHOPPING' }))!.balancePaise, 40000);
  });

  it('lets you pay a reserved order later, once, and not cancel it afterwards', async () => {
    const o = (await call(me, 'POST', '/member/orders', order())).body;
    assert.equal((await call(me, 'POST', `/member/orders/${o.id}/pay`, { payWith: 'SHOPPING_WALLET' })).status, 400, 'no funds yet');
    await fundShopping(me.userId, 110000);
    const paid = await call(me, 'POST', `/member/orders/${o.id}/pay`, { payWith: 'SHOPPING_WALLET' });
    assert.equal(paid.status, 200);
    assert.equal(paid.body.paymentStatus, 'PAID');
    assert.equal((await call(me, 'POST', `/member/orders/${o.id}/pay`, { payWith: 'SHOPPING_WALLET' })).status, 404, 'cannot be charged twice');
    assert.equal((await Wallet.findOne({ userId: me.userId, type: 'SHOPPING' }))!.balancePaise, 0);
    assert.equal((await call(me, 'POST', `/member/orders/${o.id}/cancel`)).status, 409);
  });

  it('cancels unpaid orders', async () => {
    const o = (await call(me, 'POST', '/member/orders', order())).body;
    const c = await call(me, 'POST', `/member/orders/${o.id}/cancel`);
    assert.equal(c.status, 200);
    assert.equal(c.body.paymentStatus, 'CANCELLED');
  });

  it("never exposes or lets you touch another member's order", async () => {
    const o = (await call(me, 'POST', '/member/orders', order())).body;
    assert.equal((await call(other, 'GET', `/member/orders/${o.id}`)).status, 404);
    assert.equal((await call(other, 'POST', `/member/orders/${o.id}/cancel`)).status, 404);
    assert.equal((await call(other, 'POST', `/member/orders/${o.id}/pay`, { payWith: 'SHOPPING_WALLET' })).status, 404);
    assert.equal((await call(me, 'GET', '/member/orders/not-an-id')).status, 404);
  });
});
