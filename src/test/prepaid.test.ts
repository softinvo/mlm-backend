import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { AuditLog, Franchise, FranchiseLedgerEntry, FranchiseRecharge, FranchiseStock, StockMovement, FranchiseTier, Member, Order, Package, User, Wallet, Zone } from '../models';
import { refundOrder } from '../services/commission.service';
import { postEntry } from '../services/ledger.service';
import { moveStock } from '../services/stock.service';
import { setTransport } from '../services/notify.service';
import { signToken } from '../utils/jwt';
import { withTx } from '../utils/tx';

let rs: MongoMemoryReplSet;
let server: import('node:http').Server;
let base = '';
before(async () => {
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  process.env.MONGODB_URI = rs.getUri();
  process.env.JWT_SECRET = 'test-secret-test-secret-123456';
  process.env.RECHARGE_MIN_PAISE = '100000';
  await mongoose.connect(rs.getUri());
  await Promise.all(mongoose.modelNames().map((n) => mongoose.model(n).init()));
  const { app } = await import('../app');
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});
after(async () => { setTransport(null); server.close(); await mongoose.disconnect(); await rs.stop(); });

/** The codes "sent" to members (nothing real is ever sent in tests). */
const sent: string[] = [];
before(() => setTransport({ sms: async (_m, otp) => { sent.push(otp); }, email: async () => {} }));

interface Acct { userId: string; token: string }
let admin: Acct, shop: Acct, shop2: Acct, m1: Acct;
let F1: any, F2: any, pkgId: string;

const mkUser = async (role: any, name: string): Promise<Acct> => {
  const u = await User.create({ role, status: 'ACTIVE', name, email: `${name}@t.com`, phone: String(9600000000 + Math.floor(Math.random() * 9999999)), passwordHash: await bcrypt.hash('Passw0rd!', 4) });
  await Wallet.create({ userId: u._id, type: 'INCOME' });
  return { userId: u._id.toString(), token: signToken({ userId: u._id.toString(), role }) };
};
const call = async (who: Acct | null, method: string, path: string, body?: unknown) => {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(who ? { Authorization: `Bearer ${who.token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
const fundShopping = (userId: string, amt: number) => withTx((s) => postEntry(s, { userId, wallet: 'SHOPPING', amountPaise: amt, type: 'ADJUSTMENT', key: `f:${Math.random()}` }));
const prepaid = async (f: any) => (await Franchise.findById(f._id))!.prepaidBalancePaise;
const items = (q = 1) => [{ packageId: pkgId, quantity: q }];
const counter = (ref: string, q = 1) => ({ memberCode: 'MEM1', items: items(q), payment: { type: 'COUNTER', method: 'CASH', reference: ref } });

beforeEach(async () => {
  await Promise.all(mongoose.modelNames().map((n) => mongoose.model(n).deleteMany({})));
  admin = await mkUser('SUPER_ADMIN', 'admin'); shop = await mkUser('REMOTE_FRANCHISE', 'shop'); shop2 = await mkUser('REMOTE_FRANCHISE', 'shop2');
  const zone = await Zone.create({ name: 'Z', states: [] });
  const t5 = await FranchiseTier.create({ name: 'Standard', discountPercent: 5, maxMembers: 0, dailyWalletSalesLimitPaise: 0 });
  const t8 = await FranchiseTier.create({ name: 'Premium', discountPercent: 8 });
  F1 = await Franchise.create({ type: 'ZONAL', code: 'F1', name: 'Shop One', zoneId: zone._id, ownerUserId: shop.userId, address: 'x', tierId: t5._id, prepaidBalancePaise: 1_000_000 });
  F2 = await Franchise.create({ type: 'ZONAL', code: 'F2', name: 'Shop Two', zoneId: zone._id, ownerUserId: shop2.userId, address: 'x', tierId: t8._id, prepaidBalancePaise: 1_000_000 });
  m1 = await mkUser('MEMBER', 'm1');
  await Member.create({ userId: m1.userId, memberCode: 'MEM1', franchiseId: F1._id, upline: [] });
  pkgId = String((await Package.create({ name: 'Joining Pack', pricePaise: 100000 }))._id);
  const { CommissionPlan } = await import('../models');
  await CommissionPlan.create({ version: 1, effectiveFrom: new Date(0), active: true, maxPayoutPercentOfVolume: 30, levels: [{ level: 1, percent: 10 }] });
});

/** The shop enters the code the member was sent for this sale. */
const payByCode = async (sale: { body: { requestId: string } }) => (await call(shop, 'POST', `/franchise/payment-requests/${sale.body.requestId}/confirm`, { otp: sent.at(-1)! })).status;
const giveStock = (franchiseId: unknown, qty: number) => withTx((s) => moveStock(s, { franchiseId: franchiseId as any, itemType: 'PACKAGE', itemId: pkgId, quantity: qty, type: 'ADJUSTMENT', key: `gs:${Math.random()}` }));
const stockQty = async (f: any) => (await FranchiseStock.findOne({ franchiseId: f._id, itemType: 'PACKAGE', itemId: pkgId }))?.quantity ?? 0;

describe('selling uses the franchise’s stock, and wallet sales pay the franchise', () => {
  it('a counter sale takes stock and leaves the prepaid balance alone', async () => {
    await giveStock(F1._id, 5);
    const a = await call(shop, 'POST', '/franchise/sales', counter('RCPT-A001', 2));
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.equal(await stockQty(F1), 3);
    assert.equal(await prepaid(F1), 1_000_000);
    assert.equal((await Order.findById(a.body.orderId))!.status, 'PAID');
  });

  it('blocks a sale the franchise has no stock for, and leaves nothing behind', async () => {
    await giveStock(F1._id, 1);
    const r = await call(shop, 'POST', '/franchise/sales', counter('RCPT-D001', 2));
    assert.equal(r.status, 400);
    assert.match(r.body.error, /Not enough stock of Joining Pack: you have 1, this needs 2/);
    assert.equal(await stockQty(F1), 1);
    assert.equal(await Order.countDocuments({}), 0, 'the order was rolled back with the stock reservation');
    assert.equal((await call(shop2, 'POST', '/franchise/sales', counter('RCPT-D002', 1))).status, 400, 'another franchise’s stock is not yours');
  });

  it('can never oversell, even with simultaneous sales', async () => {
    await giveStock(F1._id, 2);
    const res = await Promise.all(Array.from({ length: 5 }, (_, i) => call(shop, 'POST', '/franchise/sales', counter(`RCPT-E00${i}`))));
    assert.equal(res.filter((r) => r.status === 201).length, 2, JSON.stringify(res.map((r) => r.status)));
    assert.equal(await stockQty(F1), 0);
    assert.equal(await StockMovement.countDocuments({ type: 'SALE' }), 2);
  });

  it('a wallet sale holds the stock, pays the franchise the full price once the code is entered, and gives the stock back if cancelled', async () => {
    await giveStock(F1._id, 5);
    await fundShopping(m1.userId, 300_000);
    const s = await call(shop, 'POST', '/franchise/sales', { memberCode: 'MEM1', items: items(2), payment: { type: 'WALLET' } }); // ₹2,000
    assert.equal(s.status, 201, JSON.stringify(s.body));
    assert.equal(await stockQty(F1), 3, 'held for this sale');
    assert.equal(await prepaid(F1), 1_000_000, 'nothing moves until the member gives the code');
    assert.equal(await payByCode(s), 200);
    assert.equal(await prepaid(F1), 1_000_000 + 200_000, 'the company passes the member’s wallet payment on to the franchise');
    assert.deepEqual((await FranchiseLedgerEntry.find({ franchiseId: F1._id }).sort({ _id: 1 })).map((e) => [e.type, e.amountPaise]), [['SALE_PROCEEDS', 200_000]]);
    assert.equal((await Wallet.findOne({ userId: m1.userId, type: 'SHOPPING' }))!.balancePaise, 100_000);

    const s2 = await call(shop, 'POST', '/franchise/sales', { memberCode: 'MEM1', items: items(1), payment: { type: 'WALLET' } });
    assert.equal(await stockQty(F1), 2);
    assert.equal((await call(shop, 'POST', `/franchise/orders/${s2.body.orderId}/cancel`, { reason: 'member did not want it' })).status, 200);
    assert.equal(await stockQty(F1), 3, 'cancelling the unpaid sale put the kit back');
  });

  it('refuses to send a wallet request when the franchise has no stock', async () => {
    await fundShopping(m1.userId, 300_000);
    const r = await call(shop, 'POST', '/franchise/sales', { memberCode: 'MEM1', items: items(1), payment: { type: 'WALLET' } });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /Not enough stock/);
  });
});

describe('refunds', () => {
  it('a full refund of a counter sale puts the stock back; a partial one does not', async () => {
    await giveStock(F1._id, 5);
    const s = await call(shop, 'POST', '/franchise/sales', counter('RCPT-F001', 2)); // ₹2,000
    assert.equal(await stockQty(F1), 3);
    await refundOrder(s.body.orderId, 100_000, 'one returned');
    assert.equal(await stockQty(F1), 3, 'partial refund: no automatic restock');
    await refundOrder(s.body.orderId, 100_000, 'second returned');
    assert.equal(await stockQty(F1), 5, 'full refund: the goods came back');
    assert.equal(await prepaid(F1), 1_000_000, 'the franchise kept the cash and refunded the customer itself, so no balance moves');
  });

  it('a wallet-paid sale refund takes the proceeds back and restocks', async () => {
    await giveStock(F1._id, 5);
    await fundShopping(m1.userId, 300_000);
    const sale = await call(shop, 'POST', '/franchise/sales', { memberCode: 'MEM1', items: items(2), payment: { type: 'WALLET' } });
    assert.equal(await payByCode(sale), 200);
    const o = (await Order.findOne({}))!;
    await refundOrder(o._id.toString(), 200_000, 'full return');
    assert.equal(await prepaid(F1), 1_000_000, 'back to where it started');
    assert.equal(await stockQty(F1), 5);
    assert.equal((await Wallet.findOne({ userId: m1.userId, type: 'SHOPPING' }))!.balancePaise, 300_000);
  });

  it('the franchise balance always equals its ledger', async () => {
    await giveStock(F1._id, 10);
    await fundShopping(m1.userId, 600_000);
    const sale = await call(shop, 'POST', '/franchise/sales', { memberCode: 'MEM1', items: items(3), payment: { type: 'WALLET' } });
    assert.equal(await payByCode(sale), 200);
    await refundOrder((await Order.findOne({}))!._id.toString(), 40_000, 'partial');
    const [sum] = await FranchiseLedgerEntry.aggregate([{ $match: { franchiseId: F1._id } }, { $group: { _id: null, n: { $sum: '$amountPaise' } } }]);
    assert.equal(await prepaid(F1), 1_000_000 + sum.n);
  });
});

describe('recharging the prepaid balance', () => {
  const recharge = (ref: string, over: object = {}) => ({ amountPaise: 500_000, mode: 'NEFT', reference: ref, paidOn: new Date().toISOString(), ...over });

  it('the franchise submits, the head office confirms against the bank statement, and the balance goes up once', async () => {
    const r = await call(shop, 'POST', '/franchise/recharges', recharge('NEFT20260001'));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(await prepaid(F1), 1_000_000, 'not credited yet');
    assert.equal((await call(shop, 'POST', `/admin/recharges/${r.body.id}/confirm`, {})).status, 403, 'a franchise cannot confirm its own recharge');
    assert.equal((await call(admin, 'GET', '/admin/recharges?status=PENDING')).body.items[0].franchise.code, 'F1');
    const results = await Promise.allSettled([call(admin, 'POST', `/admin/recharges/${r.body.id}/confirm`, { confirmedPaise: 400_000, note: 'Only 4,000 arrived' }), call(admin, 'POST', `/admin/recharges/${r.body.id}/confirm`, {})]);
    const statuses = results.map((x) => (x.status === 'fulfilled' ? x.value.status : 0)).sort();
    assert.deepEqual(statuses, [200, 409], 'two simultaneous confirmations credit once');
    // Whichever of the two simultaneous confirmations won decides the amount (₹4,000 as confirmed, or the ₹5,000 claimed). It is credited exactly once.
    const credited = (await prepaid(F1)) - 1_000_000;
    assert.ok([400_000, 500_000].includes(credited), `credited ${credited}`);
    assert.equal(await FranchiseLedgerEntry.countDocuments({ type: 'RECHARGE' }), 1);
    assert.equal((await FranchiseLedgerEntry.findOne({ type: 'RECHARGE' }))!.balanceAfterPaise, 1_000_000 + credited);
  });

  it('validates the amount, date and reference, and never reuses a bank reference', async () => {
    assert.equal((await call(shop, 'POST', '/franchise/recharges', recharge('NEFT20260002', { amountPaise: 5000 }))).status, 400, 'below the minimum');
    assert.equal((await call(shop, 'POST', '/franchise/recharges', recharge('x'))).status, 400);
    assert.equal((await call(shop, 'POST', '/franchise/recharges', recharge('NEFT20260003', { paidOn: new Date(Date.now() + 5 * 86_400_000).toISOString() }))).status, 400);
    const first = await call(shop, 'POST', '/franchise/recharges', recharge('NEFT20260004'));
    assert.equal((await call(shop2, 'POST', '/franchise/recharges', recharge('neft-2026-0004'))).status, 409, 'same reference, even by another franchise');
    assert.equal((await call(admin, 'POST', `/admin/recharges/${first.body.id}/reject`, { reason: 'Not in the statement' })).status, 200);
    assert.equal((await call(shop2, 'POST', '/franchise/recharges', recharge('NEFT20260004'))).status, 201, 'freed by the rejection');
    assert.equal(await prepaid(F1), 1_000_000);
  });

  it('a franchise sees only its own recharges, and can cancel a waiting one', async () => {
    const r = await call(shop, 'POST', '/franchise/recharges', recharge('NEFT20260005'));
    assert.equal((await call(shop2, 'GET', '/franchise/recharges')).body.total, 0);
    assert.equal((await call(shop2, 'POST', `/franchise/recharges/${r.body.id}/cancel`)).status, 404);
    assert.equal((await call(shop, 'POST', `/franchise/recharges/${r.body.id}/cancel`)).status, 200);
    assert.equal((await call(admin, 'POST', `/admin/recharges/${r.body.id}/confirm`, {})).status, 409, 'cannot confirm a cancelled one');
    assert.equal(await FranchiseRecharge.countDocuments({ status: 'CANCELLED' }), 1);
  });

  it('the head office can adjust a balance with a reason, and the statement shows the ledger', async () => {
    assert.equal((await call(admin, 'POST', `/admin/prepaid/${F1._id}/adjust`, { amountPaise: 25_000 })).status, 400, 'a reason is required');
    assert.equal((await call(shop, 'POST', `/admin/prepaid/${F1._id}/adjust`, { amountPaise: 25_000, reason: 'x y z' })).status, 403);
    const r = await call(admin, 'POST', `/admin/prepaid/${F1._id}/adjust`, { amountPaise: -25_000, reason: 'Damaged stock write-off' });
    assert.equal(r.body.balancePaise, 975_000);
    const mine = (await call(shop, 'GET', '/franchise/prepaid')).body;
    assert.equal(mine.balancePaise, 975_000);
    assert.deepEqual([mine.tier.name, mine.tier.discountPercent], ['Standard', 5]);
    assert.equal((await call(shop, 'GET', '/franchise/prepaid/entries')).body.items[0].type, 'ADJUSTMENT');
    const all = (await call(admin, 'GET', '/admin/prepaid')).body;
    assert.deepEqual(all.items.map((f: any) => [f.code, f.discountPercent, f.balancePaise]), [['F1', 5, 975_000], ['F2', 8, 1_000_000]]);
    assert.equal(all.totals.balancePaise, 1_975_000);
  });
});

describe('the first recharge must match the plan investment', () => {
  const recharge = (ref: string, amountPaise: number) => ({ amountPaise, mode: 'NEFT', reference: ref, paidOn: new Date().toISOString() });
  it('requires at least the investment first, and any amount afterwards', async () => {
    await FranchiseTier.updateOne({ _id: F1.tierId }, { investmentPaise: 10_000_000 }); // ₹1,00,000
    await Franchise.updateOne({ _id: F1._id }, { prepaidBalancePaise: 0 });
    assert.equal((await call(shop, 'GET', '/franchise/prepaid')).body.firstRechargePaise, 10_000_000);
    const low = await call(shop, 'POST', '/franchise/recharges', recharge('NEFT-FIRST-01', 5_000_000));
    assert.equal(low.status, 400);
    assert.match(low.body.error, /first recharge/i);
    const ok = await call(shop, 'POST', '/franchise/recharges', recharge('NEFT-FIRST-02', 10_000_000));
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    const part = await call(admin, 'POST', `/admin/recharges/${ok.body.id}/confirm`, { confirmedPaise: 6_000_000 });
    assert.equal(part.status, 400, 'cannot credit less than the investment as a first recharge');
    assert.equal((await call(admin, 'POST', `/admin/recharges/${ok.body.id}/confirm`, {})).status, 200);
    assert.equal((await call(shop, 'GET', '/franchise/prepaid')).body.firstRechargePaise, 0);
    assert.equal((await call(shop, 'POST', '/franchise/recharges', recharge('NEFT-FIRST-03', 200_000))).status, 201, 'later top-ups can be any amount');
  });
});

describe('profiles', () => {
  it('shows the signed-in user’s details, franchises and recent activity, and lets them edit name and mobile', async () => {
    await call(shop, 'POST', '/franchise/recharges', { amountPaise: 500_000, mode: 'UPI', reference: 'UPI-PROFILE1', paidOn: new Date().toISOString() });
    const p = (await call(shop, 'GET', '/account/profile')).body;
    assert.equal(p.user.role, 'REMOTE_FRANCHISE');
    assert.equal(p.franchises[0].code, 'F1');
    assert.equal(p.franchises[0].tier.discountPercent, 5);
    assert.equal(p.franchises[0].isOwner, true);
    assert.equal(p.activity[0].action, 'RECHARGE_SUBMITTED');
    assert.equal((await call(admin, 'GET', '/account/profile')).body.franchises.length, 0);

    assert.equal((await call(shop, 'PATCH', '/account/profile', { name: 'A', phone: '123' })).status, 400);
    const ok = await call(shop, 'PATCH', '/account/profile', { name: 'Shop Owner Renamed', phone: '9811122233' });
    assert.equal(ok.status, 200);
    assert.equal((await User.findById(shop.userId))!.name, 'Shop Owner Renamed');
    assert.equal((await call(shop2, 'PATCH', '/account/profile', { name: 'Other Owner', phone: '9811122233' })).status, 409, 'mobile numbers stay unique');
    assert.ok(await AuditLog.exists({ actorId: shop.userId, action: 'PROFILE_UPDATE' }));
  });

  it('an owner can update their franchise’s address and GSTIN, but not its name, type or discount', async () => {
    assert.equal((await call(shop, 'PATCH', `/franchise/profile/${F2._id}`, { address: 'Hijack Street 1' })).status, 404, 'not your franchise');
    assert.equal((await call(shop, 'PATCH', `/franchise/profile/${F1._id}`, { address: 'x' })).status, 400);
    assert.equal((await call(shop, 'PATCH', `/franchise/profile/${F1._id}`, { address: 'New Address 12, Pune', gstin: 'bad' })).status, 400);
    const r = await call(shop, 'PATCH', `/franchise/profile/${F1._id}`, { address: 'New Address 12, Pune', gstin: '27ABCDE1234F1Z5', name: 'Hacked Name', tierId: String(F2.tierId) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const f = (await Franchise.findById(F1._id))!;
    assert.deepEqual([f.address, f.gstin, f.name, String(f.tierId) === String(F2.tierId)], ['New Address 12, Pune', '27ABCDE1234F1Z5', 'Shop One', false]);
  });
});
