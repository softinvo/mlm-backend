import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Commission, Franchise, FranchiseEarning, FranchiseStock, FranchiseTier, Member, Order, Package, Product, User, Wallet, WalletPaymentRequest, Zone } from '../models';
import { approveDueCommissions } from '../services/commission.service';
import { postEntry } from '../services/ledger.service';
import { moveStock } from '../services/stock.service';
import { advanceShipment } from '../services/order.service';
import { setTransport } from '../services/notify.service';
import { reviewKyc, submitKyc } from '../services/wallet.service';
import { signToken } from '../utils/jwt';
import { withTx } from '../utils/tx';

let rs: MongoMemoryReplSet;
let server: import('node:http').Server;
let base = '';
before(async () => {
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  process.env.MONGODB_URI = rs.getUri();
  process.env.JWT_SECRET = 'test-secret-test-secret-123456';
  process.env.COOLING_OFF_DAYS = '7';
  await mongoose.connect(rs.getUri());
  await Promise.all(mongoose.modelNames().map((n) => mongoose.model(n).init()));
  const { app } = await import('../app');
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});
after(async () => { server.close(); await mongoose.disconnect(); await rs.stop(); });

interface Acct { userId: string; token: string }
let admin: Acct, shop: Acct, shop2: Acct, m1: Acct, m2: Acct, sponsor: Acct;
let F1: any, F2: any, tier: any, pkgId: string, prodId: string;

const mkUser = async (role: any, name: string): Promise<Acct> => {
  const u = await User.create({ role, status: 'ACTIVE', name, email: `${name}@t.com`, phone: String(9500000000 + Math.floor(Math.random() * 9999999)), passwordHash: await bcrypt.hash('Passw0rd!', 4) });
  await Wallet.create({ userId: u._id, type: 'INCOME' });
  return { userId: u._id.toString(), token: signToken({ userId: u._id.toString(), role }) };
};
const call = async (who: Acct | null, method: string, path: string, body?: unknown) => {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(who ? { Authorization: `Bearer ${who.token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
const giveStock = (franchiseId: unknown, itemType: 'PACKAGE' | 'PRODUCT', itemId: string, quantity: number) =>
  withTx((s) => moveStock(s, { franchiseId: franchiseId as any, itemType, itemId, quantity, type: 'ADJUSTMENT', key: `gs:${Math.random()}` }));
const stockQty = async (franchiseId: unknown, itemType: string, itemId: string) => (await FranchiseStock.findOne({ franchiseId: franchiseId as any, itemType, itemId }))?.quantity ?? 0;
const fundShopping = (userId: string, amt: number) => withTx((s) => postEntry(s, { userId, wallet: 'SHOPPING', amountPaise: amt, type: 'ADJUSTMENT', key: `f:${Math.random()}` }));
const shopBal = async (u: string) => (await Wallet.findOne({ userId: u, type: 'SHOPPING' }))?.balancePaise ?? 0;

beforeEach(async () => {
  await Promise.all(mongoose.modelNames().map((n) => mongoose.model(n).deleteMany({})));
  delete process.env.PAYMENT_REQUEST_MINUTES;
  admin = await mkUser('SUPER_ADMIN', 'admin'); shop = await mkUser('REMOTE_FRANCHISE', 'shop'); shop2 = await mkUser('REMOTE_FRANCHISE', 'shop2');
  const zone = await Zone.create({ name: 'Z', states: [] });
  tier = await FranchiseTier.create({ name: 'Standard', discountPercent: 5, maxMembers: 0, dailyWalletSalesLimitPaise: 0 });
  F1 = await Franchise.create({ type: 'REMOTE', code: 'F1', name: 'Shop One', zoneId: zone._id, ownerUserId: shop.userId, address: 'x', tierId: tier._id, prepaidBalancePaise: 10_000_000, parentId: (await Franchise.create({ type: 'ZONAL', code: 'ZZ', name: 'Zonal', zoneId: zone._id, ownerUserId: (await mkUser('ZONAL_FRANCHISE', 'zonal')).userId, address: 'x' }))._id });
  F2 = await Franchise.create({ type: 'REMOTE', code: 'F2', name: 'Shop Two', zoneId: zone._id, ownerUserId: shop2.userId, address: 'x', tierId: tier._id, prepaidBalancePaise: 10_000_000, parentId: F1.parentId });
  sponsor = await mkUser('MEMBER', 'sponsor');
  const sp = await Member.create({ userId: sponsor.userId, memberCode: 'SPN1', franchiseId: F1._id, upline: [] });
  m1 = await mkUser('MEMBER', 'm1'); m2 = await mkUser('MEMBER', 'm2');
  await Member.create({ userId: m1.userId, memberCode: 'MEM1', franchiseId: F1._id, sponsorId: sp._id, upline: [sp._id] });
  await Member.create({ userId: m2.userId, memberCode: 'MEM2', franchiseId: F2._id, upline: [] });
  pkgId = String((await Package.create({ name: 'Joining Pack', description: 'starter', pricePaise: 55000 }))._id);
  prodId = String((await Product.create({ sku: 'RP-1', name: 'Repurchase Item', description: 'd', mrpPaise: 20000, taxPercent: 0, commissionable: true }))._id);
  for (const f of [F1, F2]) { await giveStock(f._id, 'PACKAGE', pkgId, 100); await giveStock(f._id, 'PRODUCT', prodId, 100); }
  const { CommissionPlan } = await import('../models');
  await CommissionPlan.create({ version: 1, effectiveFrom: new Date(0), active: true, maxPayoutPercentOfVolume: 30, levels: [{ level: 1, percent: 10 }] });
});

describe('admin: tiers', () => {
  it('creates and edits size tiers; only the admin can', async () => {
    assert.equal((await call(shop, 'POST', '/admin/tiers', { name: 'X', discountPercent: 1 })).status, 403);
    const c = await call(admin, 'POST', '/admin/tiers', { name: 'Mini', discountPercent: 3, maxMembers: 50, dailyWalletSalesLimitPaise: 500000, description: 'Small counter' });
    assert.equal(c.status, 201);
    assert.equal((await call(admin, 'POST', '/admin/tiers', { name: 'Mini', discountPercent: 2 })).status, 409);
    assert.equal((await call(admin, 'PATCH', `/admin/tiers/${c.body.id}`, { discountPercent: 4, active: false })).status, 200);
    const list = (await call(admin, 'GET', '/admin/tiers')).body.items;
    assert.deepEqual(list.map((t: any) => [t.name, t.discountPercent, t.franchises]), [['Mini', 4, 0], ['Standard', 5, 2]]);
  });

  it('a counter sale takes the kit off the franchise’s shelf, not money off its balance; member commission is unaffected', async () => {
    const sale = await call(shop, 'POST', '/franchise/sales', { memberCode: 'MEM1', items: [{ packageId: pkgId, quantity: 1 }], payment: { type: 'COUNTER', method: 'CASH', reference: 'RCPT1001' } });
    assert.equal(sale.status, 201, JSON.stringify(sale.body));
    const o = await Order.findById(sale.body.orderId);
    assert.equal(o!.status, 'PAID', 'paid at once');
    assert.equal(await stockQty(F1._id, 'PACKAGE', pkgId), 99, 'one kit left the franchise’s stock');
    assert.equal((await Franchise.findById(F1._id))!.prepaidBalancePaise, 10_000_000, 'the franchise paid when the stock was supplied, not per sale');
    await advanceShipment(sale.body.orderId, 'DELIVERED');
    assert.equal((await Commission.findOne({ level: 1 }))!.amountPaise, 5500, 'member commission still works');
    assert.equal(await FranchiseEarning.countDocuments({}), 0, 'franchises no longer earn a share of sales');
    void approveDueCommissions;
  });

  it('stops a franchise onboarding members past its tier capacity', async () => {
    await FranchiseTier.updateOne({ _id: tier._id }, { maxMembers: 1 }); // F1 already has 2 members (sponsor + m1)
    const r = await call(null, 'POST', '/auth/register', { name: 'New Person', email: 'new@t.com', phone: '9812345678', password: 'Passw0rd!', sponsorCode: 'SPN1', franchiseCode: 'F1' });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /not accepting new members/);
    await FranchiseTier.updateOne({ _id: tier._id }, { maxMembers: 0 });
    assert.equal((await call(null, 'POST', '/auth/register', { name: 'New Person', email: 'new@t.com', phone: '9812345678', password: 'Passw0rd!', sponsorCode: 'SPN1', franchiseCode: 'F1' })).status, 201);
  });
});

describe('admin: catalog', () => {
  it('manages joining packages and repurchase products; franchises and members see them', async () => {
    assert.equal((await call(shop, 'POST', '/admin/packages', { name: 'P', pricePaise: 100 })).status, 403);
    const p = await call(admin, 'POST', '/admin/packages', { name: 'Premium Joining', description: 'big', pricePaise: 105000 });
    assert.equal(p.status, 201);
    const pr = await call(admin, 'POST', '/admin/products', { sku: 'rp-2', name: 'Refill', description: 'x', pricePaise: 30000, taxPercent: 18, commissionable: false });
    assert.equal(pr.status, 201);
    assert.equal((await call(admin, 'POST', '/admin/products', { sku: 'RP-2', name: 'Refill 2', description: 'x', pricePaise: 1 })).status, 409);
    const cat = (await call(admin, 'GET', '/admin/catalog')).body;
    assert.deepEqual(cat.products.map((x: any) => [x.sku, x.kind, x.pricePaise]).sort(), [['RP-1', 'REPURCHASE', 20000], ['RP-2', 'REPURCHASE', 30000]]);
    assert.ok(cat.packages.every((x: any) => x.kind === 'JOINING'));

    await call(admin, 'PATCH', `/admin/packages/${p.body.id}`, { active: false });
    const fc = (await call(shop, 'GET', '/franchise/catalog')).body;
    assert.ok(!fc.packages.some((x: any) => x.name === 'Premium Joining'), 'inactive items are hidden from franchises');
    assert.equal((await call(m1, 'GET', '/member/catalog')).body.products.length, 2);
  });

  it('a price change never alters orders that were already bought', async () => {
    const sale = await call(shop, 'POST', '/franchise/sales', { memberCode: 'MEM1', items: [{ packageId: pkgId, quantity: 2 }], payment: { type: 'COUNTER', method: 'UPI', reference: 'UPI-9001' } });
    await call(admin, 'PATCH', `/admin/packages/${pkgId}`, { pricePaise: 99999 });
    assert.equal((await Order.findById(sale.body.orderId))!.totalPaise, 110000);
    const again = await call(shop, 'POST', '/franchise/sales', { memberCode: 'MEM1', items: [{ packageId: pkgId, quantity: 1 }], payment: { type: 'COUNTER', method: 'UPI', reference: 'UPI-9002' } });
    assert.equal(again.body.totalPaise, 99999);
  });
});

describe('admin: members', () => {
  it('lists, searches and opens members across all franchises', async () => {
    const all = (await call(admin, 'GET', '/admin/members')).body;
    assert.equal(all.total, 3);
    assert.deepEqual((await call(admin, 'GET', '/admin/members?search=mem2')).body.items.map((m: any) => m.franchiseCode), ['F2']);
    assert.equal((await call(admin, 'GET', `/admin/members?franchiseId=${F1._id}`)).body.total, 2);
    assert.equal((await call(shop, 'GET', '/admin/members')).status, 403);
    await fundShopping(m1.userId, 12300);
    const d = (await call(admin, 'GET', `/admin/members/${m1.userId}`)).body;
    assert.equal(d.memberCode, 'MEM1'); assert.equal(d.sponsor.memberCode, 'SPN1'); assert.equal(d.franchise.code, 'F1'); assert.equal(d.wallets.shopping, 12300);
    assert.equal((await call(admin, 'GET', `/admin/members/${shop.userId}`)).status, 404, 'staff are not members');
  });

  it('suspending a member locks them out at once; reactivating restores access', async () => {
    assert.equal((await call(m1, 'GET', '/member/wallet')).status, 200);
    assert.equal((await call(admin, 'PATCH', `/admin/members/${m1.userId}/status`, { status: 'SUSPENDED' })).status, 400, 'a reason is required');
    assert.equal((await call(admin, 'PATCH', `/admin/members/${m1.userId}/status`, { status: 'SUSPENDED', reason: 'Fraud review' })).status, 200);
    const blocked = await call(m1, 'GET', '/member/wallet');
    assert.equal(blocked.status, 403);
    assert.match(blocked.body.error, /suspended/);
    assert.equal((await call(null, 'POST', '/auth/login', { email: 'm1@t.com', password: 'Passw0rd!' })).status, 403);
    assert.equal((await call(shop, 'POST', '/franchise/sales', { memberCode: 'MEM1', items: [{ packageId: pkgId, quantity: 1 }], payment: { type: 'WALLET' } })).status, 404, 'cannot sell to a suspended member');
    await call(admin, 'PATCH', `/admin/members/${m1.userId}/status`, { status: 'ACTIVE' });
    assert.equal((await call(m1, 'GET', '/member/wallet')).status, 200);
  });

  it('resets a password', async () => {
    assert.equal((await call(admin, 'POST', `/admin/members/${m1.userId}/reset-password`, { password: 'short' })).status, 400);
    assert.equal((await call(admin, 'POST', `/admin/members/${m1.userId}/reset-password`, { password: 'Fresh#Pass99' })).status, 200);
    assert.equal((await call(null, 'POST', '/auth/login', { email: 'm1@t.com', password: 'Fresh#Pass99' })).status, 200);
  });
});

describe('franchise sells at the counter', () => {
  const counter = (over: object = {}) => ({ memberCode: 'MEM1', items: [{ packageId: pkgId, quantity: 1 }, { productId: prodId, quantity: 2 }], payment: { type: 'COUNTER', method: 'CASH', reference: 'RCPT2001' }, ...over });

  it('looks a member up and sells a joining package plus repurchase items', async () => {
    assert.deepEqual((await call(shop, 'GET', '/franchise/members/lookup?code=mem1')).body.memberCode, 'MEM1');
    assert.equal((await call(shop, 'GET', '/franchise/members/lookup?code=NOPE')).status, 404);
    assert.equal((await call(m1, 'GET', '/franchise/members/lookup?code=M1')).status, 403, 'members cannot use franchise tools');

    const s = await call(shop, 'POST', '/franchise/sales', counter());
    assert.equal(s.status, 201, JSON.stringify(s.body));
    assert.equal(s.body.totalPaise, 55000 + 40000);
    const o = await Order.findById(s.body.orderId);
    assert.equal(o!.status, 'PAID', 'paid at once from the prepaid balance');
    assert.equal(o!.franchiseId.toString(), F1._id.toString());
    assert.equal(o!.items.length, 2);
    assert.equal((await call(shop, 'POST', `/franchise/orders/${o!._id}/shipment`, { status: 'DELIVERED' })).status, 200, 'handed over at the counter');
  });

  it('rejects bad items, a franchise that is not yours, inactive franchises, and repeats safely', async () => {
    assert.equal((await call(shop, 'POST', '/franchise/sales', counter({ items: [] }))).status, 400);
    assert.equal((await call(shop, 'POST', '/franchise/sales', counter({ items: [{ packageId: pkgId, productId: prodId, quantity: 1 }] }))).status, 400);
    assert.equal((await call(shop, 'POST', '/franchise/sales', counter({ franchiseId: String(F2._id) }))).status, 404, 'cannot sell as another franchise');
    const key = 'sale-key-123456';
    const rs = await Promise.all(Array.from({ length: 4 }, () => call(shop, 'POST', '/franchise/sales', counter({ clientKey: key, payment: { type: 'COUNTER', method: 'CASH', reference: 'RCPT3001' } }))));
    assert.ok(rs.every((r) => [200, 201].includes(r.status)), JSON.stringify(rs.map((r) => r.body)));
    assert.equal(new Set(rs.map((r) => r.body.orderId)).size, 1);
    assert.equal(await Order.countDocuments({}), 1);
    await Franchise.updateOne({ _id: F1._id }, { active: false });
    assert.equal((await call(shop, 'POST', '/franchise/sales', counter())).status, 403);
  });

  it('a failed sale leaves no order behind', async () => {
    await call(shop, 'POST', '/franchise/sales', counter());
    const dupRef = await call(shop, 'POST', '/franchise/sales', counter());
    assert.equal(dupRef.status, 409, 'the same receipt cannot back two sales');
    const all = await Order.find({});
    assert.equal(all.filter((o) => o.status === 'PLACED').length, 0, 'the failed attempt was cancelled, not left open');
    assert.deepEqual(all.map((o) => o.status).sort(), ['CANCELLED', 'PAID']);
    assert.equal(await stockQty(F1._id, 'PACKAGE', pkgId), 100 - 1 - 0, 'only the successful sale used stock; the failed one was put back');
  });
});

describe('franchise sells with the member’s shopping wallet', () => {
  const wallet = (over: object = {}) => ({ memberCode: 'MEM1', items: [{ packageId: pkgId, quantity: 1 }], payment: { type: 'WALLET' }, ...over });
  // The member is sent a code for each bill; "sent" records them in order (nothing real is sent in tests).
  const sent: string[] = [];
  before(() => setTransport({ sms: async (_m, otp) => { sent.push(otp); }, email: async () => {} }));
  after(() => setTransport(null));
  beforeEach(() => { sent.length = 0; });
  const confirm = (who: Acct, reqId: string, otp: string) => call(who, 'POST', `/franchise/payment-requests/${reqId}/confirm`, { otp });
  const requests = async (who: Acct, status = 'PENDING') => (await call(who, 'GET', `/franchise/payment-requests?status=${status}`)).body;

  it('bills the member, who unlocks it with a code; only then does money move', async () => {
    await fundShopping(m1.userId, 80000);
    const s = await call(shop, 'POST', '/franchise/sales', wallet());
    assert.equal(s.status, 201, JSON.stringify(s.body));
    assert.equal(await shopBal(m1.userId), 80000, 'nothing is taken yet');
    assert.equal((await Order.findById(s.body.orderId))!.status, 'PLACED');
    assert.equal(sent.length, 1, 'the member got a code');

    const p = await requests(shop);
    assert.equal(p.items.length, 1);
    assert.equal(p.items[0].amountPaise, 55000); assert.equal(p.items[0].items[0].name, 'Joining Pack');
    assert.equal((await requests(shop2)).items.length, 0, 'other franchises never see it');
    assert.equal((await call(m1, 'GET', '/member/payment-requests')).status, 404, 'members no longer have a payment-requests screen or API');
    assert.equal((await call(m1, 'POST', `/member/payment-requests/${p.items[0].id}/approve`)).status, 404, 'and cannot approve a bill themselves');

    assert.equal((await confirm(shop2, p.items[0].id, sent[0])).status, 404, 'another franchise cannot use the code');
    assert.equal((await confirm(shop, p.items[0].id, sent[0] === '000000' ? '111111' : '000000')).status, 400, 'a wrong code takes nothing');
    assert.equal(await shopBal(m1.userId), 80000);
    assert.equal((await confirm(shop, p.items[0].id, sent[0])).status, 200);
    assert.equal(await shopBal(m1.userId), 25000);
    assert.equal((await Order.findById(s.body.orderId))!.status, 'PAID');
    assert.equal((await confirm(shop, p.items[0].id, sent[0])).status, 409, 'cannot be charged twice');
    assert.equal(await shopBal(m1.userId), 25000);
    assert.equal((await call(shop, 'GET', '/franchise/orders?tab=toship')).body.total, 1);
  });

  it('a cancelled bill takes no money and the order can be cancelled', async () => {
    await fundShopping(m1.userId, 80000);
    const a = await call(shop, 'POST', '/franchise/sales', wallet());
    const codeA = sent.at(-1)!;
    assert.equal((await call(shop, 'POST', `/franchise/payment-requests/${a.body.requestId}/cancel`)).status, 200);
    assert.equal((await confirm(shop, a.body.requestId, codeA)).status, 409, 'a cancelled bill cannot be paid');
    const b = await call(shop, 'POST', '/franchise/sales', wallet());
    assert.equal((await call(shop2, 'POST', `/franchise/payment-requests/${b.body.requestId}/cancel`)).status, 404, 'another franchise cannot touch it');
    assert.equal((await call(shop, 'POST', `/franchise/payment-requests/${b.body.requestId}/cancel`)).status, 200);
    assert.equal(await shopBal(m1.userId), 80000);
    const c = await call(shop, 'POST', '/franchise/sales', wallet());
    assert.equal((await call(shop, 'POST', `/franchise/orders/${c.body.orderId}/cancel`, { reason: 'changed mind' })).status, 200);
    assert.equal((await requests(shop)).items.length, 0, 'cancelling the order withdraws its bill');
  });

  it('a bill expires after 5 minutes and cannot be paid late', async () => {
    await fundShopping(m1.userId, 80000);
    assert.equal(process.env.PAYMENT_REQUEST_MINUTES, undefined, 'the default window is used');
    const s = await call(shop, 'POST', '/franchise/sales', wallet());
    assert.equal(s.body.otp.expiresInMinutes, 5, 'the code unlocks the bill for 5 minutes');
    const r = (await WalletPaymentRequest.findById(s.body.requestId))!;
    assert.ok(Math.abs(r.expiresAt.getTime() - Date.now() - 5 * 60_000) < 15_000);
    await WalletPaymentRequest.updateOne({ _id: r._id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    await mongoose.connection.collection('otps').updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    assert.equal((await confirm(shop, s.body.requestId, sent[0])).status, 409);
    assert.equal((await requests(shop, 'EXPIRED')).items.length, 1);
    assert.equal(await shopBal(m1.userId), 80000);
  });

  it('refuses a sale the wallet cannot cover, leaving nothing behind', async () => {
    await fundShopping(m1.userId, 1000);
    const r = await call(shop, 'POST', '/franchise/sales', wallet());
    assert.equal(r.status, 400);
    assert.match(r.body.error, /too low/);
    assert.equal(await WalletPaymentRequest.countDocuments({}), 0);
    assert.deepEqual((await Order.find({})).map((o) => o.status), ['CANCELLED']);
    assert.equal(sent.length, 0, 'no code is sent for a sale that cannot be paid');
  });

  it('enforces the tier’s daily wallet-sales limit, even with simultaneous confirmations', async () => {
    await FranchiseTier.updateOne({ _id: tier._id }, { dailyWalletSalesLimitPaise: 120000 }); // two ₹550 sales fit, a third does not
    await fundShopping(m1.userId, 500000);
    const sales = [await call(shop, 'POST', '/franchise/sales', wallet()), await call(shop, 'POST', '/franchise/sales', wallet()), await call(shop, 'POST', '/franchise/sales', wallet())];
    assert.ok(sales.every((s) => s.status === 201));
    const res = await Promise.all(sales.map((s, i) => confirm(shop, s.body.requestId, sent[i])));
    assert.equal(res.filter((r) => r.status === 200).length, 2, JSON.stringify(res.map((r) => r.status)));
    assert.ok(res.some((r) => r.status === 400 && /daily wallet sales limit/.test(r.body.error)));
    assert.equal(await shopBal(m1.userId), 500000 - 110000);
    const next = await call(shop, 'POST', '/franchise/sales', wallet());
    assert.equal(next.status, 400, 'new bills are refused once the limit is used up');
  });
});

describe('one-time codes (SMS / email)', () => {
  const sent: { via: 'SMS' | 'EMAIL'; to: string; code: string }[] = [];
  const lastCode = (to?: string) => [...sent].reverse().find((s) => !to || s.to === to)!.code;
  const otherCode = (code: string) => (code === '000000' ? '111111' : '000000');
  before(() => setTransport({
    sms: async (mobile, otp) => { sent.push({ via: 'SMS', to: mobile, code: otp }); },
    email: async (to, _subject, html) => { sent.push({ via: 'EMAIL', to: to.address, code: /(\d{6})<\/p>/.exec(html)![1] }); },
  }));
  after(() => setTransport(null));
  beforeEach(() => { sent.length = 0; });

  it('forgot password: a code by SMS or email lets the person set a new password, once', async () => {
    const phone = (await User.findById(m1.userId))!.phone;
    const r = await call(null, 'POST', '/auth/forgot-password', { identifier: phone, channel: 'SMS' });
    assert.equal(r.status, 200);
    assert.equal(sent.length, 1);
    assert.deepEqual([sent[0].via, sent[0].to], ['SMS', `91${phone}`]);
    const code = lastCode();
    const reset = (otp: string, password = 'Brand#New77') => call(null, 'POST', '/auth/forgot-password/reset', { identifier: phone, otp, password });
    assert.equal((await reset(otherCode(code))).status, 400, 'a wrong code is refused');
    assert.equal((await reset(code, 'weak')).status, 400, 'and so is a weak password');
    assert.equal((await reset(code)).status, 200);
    assert.equal((await call(null, 'POST', '/auth/login', { email: 'm1@t.com', password: 'Brand#New77' })).status, 200, 'the new password works');
    assert.equal((await call(null, 'POST', '/auth/login', { email: 'm1@t.com', password: 'Passw0rd!' })).status, 401, 'the old one does not');
    assert.equal((await reset(code, 'Another#Pass8')).status, 400, 'a code works only once');
  });

  it('forgot password by email, and it never reveals whether an account exists', async () => {
    const known = await call(null, 'POST', '/auth/forgot-password', { identifier: 'M1@t.com', channel: 'EMAIL' });
    assert.deepEqual([sent[0].via, sent[0].to], ['EMAIL', 'm1@t.com']);
    const unknown = await call(null, 'POST', '/auth/forgot-password', { identifier: 'nobody@t.com', channel: 'EMAIL' });
    assert.equal(sent.length, 1, 'nothing is sent to an unknown address');
    assert.deepEqual(unknown.body, known.body, 'the answer is identical');
    assert.equal(unknown.status, 200);
  });

  it('a code stops working after five wrong tries', async () => {
    await call(null, 'POST', '/auth/forgot-password', { identifier: 'm1@t.com', channel: 'EMAIL' });
    const code = lastCode();
    for (let i = 0; i < 5; i++) assert.equal((await call(null, 'POST', '/auth/forgot-password/reset', { identifier: 'm1@t.com', otp: otherCode(code), password: 'Brand#New77' })).status, 400);
    const late = await call(null, 'POST', '/auth/forgot-password/reset', { identifier: 'm1@t.com', otp: code, password: 'Brand#New77' });
    assert.equal(late.status, 429, 'even the right code is refused now');
  });

  it('in development every code is 123456 and nothing is sent', async () => {
    const env = { n: process.env.NODE_ENV, t: process.env.NODE_TEST_CONTEXT };
    process.env.NODE_ENV = 'development'; delete process.env.NODE_TEST_CONTEXT;
    try {
      const phone = (await User.findById(m1.userId))!.phone;
      assert.equal((await call(null, 'POST', '/auth/forgot-password', { identifier: phone, channel: 'SMS' })).status, 200);
      assert.equal(sent.length, 0, 'no SMS or email went out');
      assert.equal((await call(null, 'POST', '/auth/forgot-password/reset', { identifier: phone, otp: '123456', password: 'Dev#Pass2026' })).status, 200);
      assert.equal((await call(null, 'POST', '/auth/login', { email: 'm1@t.com', password: 'Dev#Pass2026' })).status, 200);
      process.env.NODE_ENV = 'production';
      await mongoose.connection.collection('otps').updateMany({}, { $set: { createdAt: new Date(Date.now() - 60_000) } });
      await call(null, 'POST', '/auth/forgot-password', { identifier: phone, channel: 'SMS' });
      assert.equal(sent.length, 1, 'outside development a real (here: fake-transport) message is sent');
    } finally { process.env.NODE_ENV = env.n; if (env.t !== undefined) process.env.NODE_TEST_CONTEXT = env.t; }
  });

  it('a member chooses where their codes go', async () => {
    assert.equal((await call(m1, 'PUT', '/member/otp-channel', { channel: 'PIGEON' })).status, 400);
    assert.equal((await call(m1, 'PUT', '/member/otp-channel', { channel: 'EMAIL' })).status, 200);
    await fundShopping(m1.userId, 80_000);
    const s = await call(shop, 'POST', '/franchise/sales', { memberCode: 'MEM1', items: [{ packageId: pkgId, quantity: 1 }], payment: { type: 'WALLET' } });
    assert.equal(s.status, 201, JSON.stringify(s.body));
    assert.deepEqual([sent.at(-1)!.via, sent.at(-1)!.to], ['EMAIL', 'm1@t.com'], 'their choice is used for the shop payment code');
    assert.equal((await call(m1, 'GET', '/member/profile')).body.otpChannel, 'EMAIL');
    await User.updateOne({ _id: m1.userId }, { $set: { otpChannel: 'SMS' } });
  });

  it('a withdrawal needs a code sent to the member, and a code works once', async () => {
    await submitKyc(m1.userId, { accountHolder: 'M One', accountNumber: '123456789012', ifsc: 'HDFC0001234', pan: 'ABCDE1234F' });
    await reviewKyc(m1.userId, 'VERIFIED', undefined, m1.userId);
    await withTx((s) => postEntry(s, { userId: m1.userId, wallet: 'INCOME', amountPaise: 90_000, type: 'ADJUSTMENT', key: `wd-fund:${Math.random()}` }));
    assert.equal((await call(m1, 'POST', '/member/withdrawals', { amountPaise: 20_000 })).status, 400, 'no code, no withdrawal');
    const o = await call(m1, 'POST', '/member/withdrawals/otp', { channel: 'EMAIL' });
    assert.equal(o.status, 200, JSON.stringify(o.body));
    assert.equal(o.body.channel, 'EMAIL');
    assert.match(o.body.sentTo, /@t\.com$/);
    const code = lastCode();
    assert.equal((await call(m1, 'POST', '/member/withdrawals', { amountPaise: 20_000, otp: otherCode(code) })).status, 400);
    assert.equal((await call(m1, 'POST', '/member/withdrawals', { amountPaise: 20_000, otp: code })).status, 201);
    assert.equal((await call(m1, 'POST', '/member/withdrawals', { amountPaise: 20_000, otp: code })).status, 400, 'the same code cannot be reused');
    assert.equal((await call(null, 'POST', '/member/withdrawals/otp', {})).status, 401);
  });

  it('a shopping-wallet sale sends the member a code; the shop types it in to complete the sale', async () => {
    await fundShopping(m1.userId, 80_000);
    await User.updateOne({ _id: m1.userId }, { $set: { otpChannel: 'SMS' } });
    const s = await call(shop, 'POST', '/franchise/sales', { memberCode: 'MEM1', items: [{ packageId: pkgId, quantity: 1 }], payment: { type: 'WALLET' } });
    assert.equal(s.status, 201, JSON.stringify(s.body));
    assert.equal(sent.length, 1, 'the member got a code');
    assert.equal(sent[0].via, 'SMS');
    assert.ok(s.body.requestId && s.body.otp.sentTo.startsWith('XXXXXX'), 'the shop sees where it went, not the code');
    assert.equal(JSON.stringify(s.body).includes(sent[0].code), false, 'the code is never shown to the shop');
    const code = sent[0].code;
    const confirm = (who: Acct, otp: string) => call(who, 'POST', `/franchise/payment-requests/${s.body.requestId}/confirm`, { otp });
    assert.equal((await confirm(shop, otherCode(code))).status, 400, 'a wrong code takes no money');
    assert.equal(await shopBal(m1.userId), 80_000);
    assert.equal((await confirm(shop2, code)).status, 404, 'another shop cannot use it');
    assert.equal((await confirm(m1, code)).status, 403, 'and neither can the member route');
    assert.equal((await confirm(shop, code)).status, 200);
    assert.equal(await shopBal(m1.userId), 25_000, 'the payment went through');
    assert.equal((await Order.findById(s.body.orderId))!.status, 'PAID');
    assert.equal((await confirm(shop, code)).status, 409, 'it cannot be paid twice');
  });

  it('the shop can ask for the code again, by email if the member prefers', async () => {
    await fundShopping(m1.userId, 80_000);
    const s = await call(shop, 'POST', '/franchise/sales', { memberCode: 'MEM1', items: [{ packageId: pkgId, quantity: 1 }], payment: { type: 'WALLET' } });
    assert.equal(s.status, 201);
    const first = lastCode();
    // the 30 second pause between codes protects the member from being flooded
    assert.equal((await call(shop, 'POST', `/franchise/payment-requests/${s.body.requestId}/resend-otp`, { channel: 'EMAIL' })).status, 429);
    await mongoose.connection.collection('otps').updateMany({}, { $set: { createdAt: new Date(Date.now() - 60_000) } }); // createdAt is immutable in the model
    const r = await call(shop, 'POST', `/franchise/payment-requests/${s.body.requestId}/resend-otp`, { channel: 'EMAIL' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(sent.at(-1)!.via, 'EMAIL');
    assert.equal((await call(shop, 'POST', `/franchise/payment-requests/${s.body.requestId}/confirm`, { otp: first })).status, 400, 'the older code stops working');
    assert.equal((await call(shop, 'POST', `/franchise/payment-requests/${s.body.requestId}/confirm`, { otp: sent.at(-1)!.code })).status, 200);
  });

  it('if the code cannot be delivered the sale is not left half-made', async () => {
    setTransport({ sms: async () => { throw new Error('gateway down'); }, email: async () => { throw new Error('down'); } });
    await fundShopping(m1.userId, 80_000);
    const before = await stockQty(F1._id, 'PACKAGE', pkgId);
    const s = await call(shop, 'POST', '/franchise/sales', { memberCode: 'MEM1', items: [{ packageId: pkgId, quantity: 1 }], payment: { type: 'WALLET' } });
    assert.equal(s.status, 500);
    assert.equal(await stockQty(F1._id, 'PACKAGE', pkgId), before, 'the stock was put back');
    assert.equal(await WalletPaymentRequest.countDocuments({ status: 'PENDING' }), 0);
    assert.equal(await shopBal(m1.userId), 80_000);
    setTransport({
      sms: async (mobile, otp) => { sent.push({ via: 'SMS', to: mobile, code: otp }); },
      email: async (to, _s, html) => { sent.push({ via: 'EMAIL', to: to.address, code: /(\d{6})<\/p>/.exec(html)![1] }); },
    });
  });
});
