import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Franchise, FranchiseLedgerEntry, FranchiseStock, FranchiseTier, Member, Order, Package, Product, StockMovement, Supply, User, Wallet, Zone } from '../models';
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
let admin: Acct, shop: Acct, shop2: Acct, m1: Acct;
let F1: any, F2: any, pkg: string, prod: string;

const mkUser = async (role: any, name: string): Promise<Acct> => {
  const u = await User.create({ role, status: 'ACTIVE', name, email: `${name}@t.com`, phone: String(9500000000 + Math.floor(Math.random() * 9999999)), passwordHash: await bcrypt.hash('Passw0rd!', 4) });
  await Wallet.create({ userId: u._id, type: 'INCOME' });
  return { userId: u._id.toString(), token: signToken({ userId: u._id.toString(), role }) };
};
const call = async (who: Acct | null, method: string, path: string, body?: unknown) => {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(who ? { Authorization: `Bearer ${who.token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
const qty = async (f: any, t: string, id: string) => (await FranchiseStock.findOne({ franchiseId: f._id, itemType: t, itemId: id }))?.quantity ?? 0;
const bal = async (f: any) => (await Franchise.findById(f._id))!.prepaidBalancePaise;
const supply = (franchiseId: string, lines: object[], over: object = {}) => call(admin, 'POST', '/admin/supplies', { franchiseId, lines, ...over });

beforeEach(async () => {
  await Promise.all(mongoose.modelNames().map((n) => mongoose.model(n).deleteMany({})));
  admin = await mkUser('SUPER_ADMIN', 'admin'); shop = await mkUser('REMOTE_FRANCHISE', 'shop'); shop2 = await mkUser('REMOTE_FRANCHISE', 'shop2');
  const zone = await Zone.create({ name: 'Z', states: [] });
  const t5 = await FranchiseTier.create({ name: 'Standard', rank: 2, discountPercent: 5 });
  const t8 = await FranchiseTier.create({ name: 'Premium', rank: 3, discountPercent: 8 });
  F1 = await Franchise.create({ type: 'ZONAL', code: 'F1', name: 'Shop One', zoneId: zone._id, ownerUserId: shop.userId, address: 'x', tierId: t5._id, prepaidBalancePaise: 10_000_000 });
  F2 = await Franchise.create({ type: 'ZONAL', code: 'F2', name: 'Shop Two', zoneId: zone._id, ownerUserId: shop2.userId, address: 'x', tierId: t8._id, prepaidBalancePaise: 10_000_000 });
  m1 = await mkUser('MEMBER', 'm1');
  await Member.create({ userId: m1.userId, memberCode: 'MEM1', franchiseId: F1._id, upline: [] });
  pkg = String((await Package.create({ name: 'Joining Kit', pricePaise: 100_000 }))._id);            // ₹1,000
  prod = String((await Product.create({ sku: 'RP-1', name: 'Repurchase Oil', description: 'd', mrpPaise: 20_000, taxPercent: 0, commissionable: true }))._id); // ₹200
});

describe('admin supplies products to a franchise', () => {
  it('charges retail less the plan discount from the prepaid balance and adds the stock', async () => {
    const lines = [{ itemType: 'PACKAGE', itemId: pkg, quantity: 10 }, { itemType: 'PRODUCT', itemId: prod, quantity: 50 }]; // retail 10,000 + 10,000
    const prev = await call(admin, 'POST', '/admin/supplies/preview', { franchiseId: String(F1._id), lines });
    assert.deepEqual([prev.body.discountPercent, prev.body.totalRetailPaise, prev.body.totalCostPaise], [5, 2_000_000, 1_900_000]);
    assert.equal(await bal(F1), 10_000_000, 'a preview changes nothing');

    const r = await supply(String(F1._id), lines, { note: 'Starter stock' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(await bal(F1), 10_000_000 - 1_900_000, '5% off ₹20,000');
    assert.equal(await qty(F1, 'PACKAGE', pkg), 10);
    assert.equal(await qty(F1, 'PRODUCT', prod), 50);
    assert.equal((await FranchiseLedgerEntry.findOne({ type: 'SUPPLY_COST' }))!.amountPaise, -1_900_000);

    const r2 = await supply(String(F2._id), [{ itemType: 'PACKAGE', itemId: pkg, quantity: 10 }]);
    assert.equal(r2.body.totalCostPaise, 920_000, 'Premium gets 8% off');

    const mine = (await call(shop, 'GET', '/franchise/stock')).body;
    assert.deepEqual(mine.items.map((i: any) => [i.name, i.quantity]), [['Joining Kit', 10], ['Repurchase Oil', 50]]);
    assert.equal(mine.valuePaise, 2_000_000);
    assert.equal((await call(shop, 'GET', '/franchise/supplies')).body.items[0].lines.length, 2);
    assert.equal((await call(shop2, 'GET', '/franchise/supplies')).body.total, 1, 'each franchise sees only its own supplies');
  });

  it('refuses when the balance is too low, an item is not in the catalog, or it is not the admin; repeats are safe', async () => {
    const lines = [{ itemType: 'PACKAGE', itemId: pkg, quantity: 1 }];
    assert.equal((await call(shop, 'POST', '/admin/supplies', { franchiseId: String(F1._id), lines })).status, 403);
    await Franchise.updateOne({ _id: F1._id }, { prepaidBalancePaise: 50_000 });
    const low = await supply(String(F1._id), lines);
    assert.equal(low.status, 400); assert.match(low.body.error, /recharge first/);
    assert.equal(await qty(F1, 'PACKAGE', pkg), 0);
    assert.equal(await Supply.countDocuments({}), 0);
    await Franchise.updateOne({ _id: F1._id }, { prepaidBalancePaise: 10_000_000 });
    await Package.updateOne({ _id: pkg }, { active: false });
    assert.equal((await supply(String(F1._id), lines)).status, 400, 'inactive items cannot be supplied');
    await Package.updateOne({ _id: pkg }, { active: true });
    assert.equal((await supply(String(F1._id), [{ ...lines[0], quantity: 1 }, lines[0]])).status, 400, 'duplicate lines');

    const key = 'supply-key-0001';
    const [a, b] = await Promise.all([supply(String(F1._id), lines, { clientKey: key }), supply(String(F1._id), lines, { clientKey: key })]);
    assert.deepEqual([a.status, b.status].sort(), [200, 201]);
    assert.equal(await qty(F1, 'PACKAGE', pkg), 1, 'a double-click supplies once');
    assert.equal(await bal(F1), 10_000_000 - 95_000);
  });

  it('shows stock on the overview: a franchise sees its own, the admin sees everyone', async () => {
    await supply(String(F1._id), [{ itemType: 'PACKAGE', itemId: pkg, quantity: 3 }, { itemType: 'PRODUCT', itemId: prod, quantity: 40 }]); // kit is low (3), oil is plentiful
    const mine = (await call(shop, 'GET', '/franchise/overview')).body;
    assert.deepEqual(mine.stock, { units: 43, valuePaise: 3 * 100_000 + 40 * 20_000, low: 1, out: 0, alerts: [{ itemType: 'PACKAGE', name: 'Joining Kit', quantity: 3 }] });
    assert.equal(mine.counts.stockAlerts, 1, 'drives the sidebar badge');
    const empty = (await call(shop2, 'GET', '/franchise/overview')).body;
    assert.deepEqual(empty.stock.alerts.map((a: any) => [a.name, a.quantity]), [['Joining Kit', 0], ['Repurchase Oil', 0]], 'out of stock items are listed too');
    assert.equal(empty.counts.stockAlerts, 2);
    await supply(String(F1._id), [{ itemType: 'PACKAGE', itemId: pkg, quantity: 20 }]);
    assert.equal((await call(shop, 'GET', '/franchise/overview')).body.counts.stockAlerts, 0, 'the alert clears once restocked');
    const all = (await call(admin, 'GET', '/admin/overview')).body.stock;
    assert.deepEqual([all.units, all.valuePaise, all.out], [63, 3_100_000, 1], 'after the restock, every item of F1 is stocked; F2 holds nothing, which is counted separately');
  });

  it('can never be sold twice: stock moves are logged and add up', async () => {
    await supply(String(F1._id), [{ itemType: 'PACKAGE', itemId: pkg, quantity: 3 }]);
    const sale = (ref: string) => call(shop, 'POST', '/franchise/sales', { memberCode: 'MEM1', items: [{ packageId: pkg, quantity: 1 }], payment: { type: 'COUNTER', method: 'CASH', reference: ref } });
    assert.equal((await sale('RCPT-S001')).status, 201);
    assert.equal((await sale('RCPT-S002')).status, 201);
    const cat = (await call(shop, 'GET', '/franchise/catalog')).body;
    assert.equal(cat.packages[0].available, 1, 'the sell screen shows what is left');
    assert.equal(cat.products[0].available, 0);
    const rows = await StockMovement.find({ franchiseId: F1._id }).sort({ _id: 1 });
    assert.deepEqual(rows.map((r) => [r.type, r.quantity, r.balanceAfter]), [['SUPPLY', 3, 3], ['SALE', -1, 2], ['SALE', -1, 1]]);
    assert.equal((await Order.find({ status: 'PAID' })).length, 2);
  });

  it('lets the admin correct stock with a reason, never below zero, and see every franchise', async () => {
    await supply(String(F1._id), [{ itemType: 'PACKAGE', itemId: pkg, quantity: 4 }]);
    const adj = (quantity: number, reason = 'Damaged in transit') => call(admin, 'POST', `/admin/stock/${F1._id}/adjust`, { itemType: 'PACKAGE', itemId: pkg, quantity, reason });
    assert.equal((await adj(-1, 'x')).status, 400, 'a reason is required');
    assert.equal((await adj(-5)).status, 400, 'cannot go below zero');
    assert.equal((await adj(-1)).body.quantity, 3);
    assert.equal((await call(shop, 'POST', `/admin/stock/${F1._id}/adjust`, { itemType: 'PACKAGE', itemId: pkg, quantity: 1, reason: 'cheating' })).status, 403);
    const ov = (await call(admin, 'GET', '/admin/stock')).body.items;
    assert.deepEqual(ov.map((f: any) => [f.code, f.units, f.valuePaise]), [['F1', 3, 300_000], ['F2', 0, 0]]);
    const one = (await call(admin, 'GET', `/admin/stock/${F1._id}`)).body;
    assert.equal(one.stock.items.find((i: any) => i.name === 'Joining Kit').quantity, 3);
    assert.equal(one.stock.items.find((i: any) => i.name === 'Repurchase Oil').quantity, 0, 'catalog items it holds none of are listed too');
    assert.equal(one.movements.items[0].type, 'ADJUSTMENT');
  });

  it('a franchise cannot see or use another franchise’s stock', async () => {
    await supply(String(F2._id), [{ itemType: 'PACKAGE', itemId: pkg, quantity: 5 }]);
    assert.equal((await call(shop, 'GET', `/franchise/stock?franchiseId=${F2._id}`)).status, 404);
    assert.equal((await call(shop, 'GET', '/franchise/stock')).body.totalUnits, 0);
  });
});

describe('a franchise supplies the franchises it manages', () => {
  let std: Acct, mini: Acct, S: any, M: any;
  beforeEach(async () => {
    // F2 is Premium (8%). Under it: a Standard franchise (5%) and a Mini franchise (3%).
    const mini3 = await FranchiseTier.create({ name: 'Mini', rank: 1, discountPercent: 3 });
    const std5 = await FranchiseTier.findOne({ name: 'Standard' });
    std = await mkUser('REMOTE_FRANCHISE', 'std'); mini = await mkUser('REMOTE_FRANCHISE', 'mini');
    const zone = await Zone.findOne({});
    S = await Franchise.create({ type: 'REMOTE', code: 'S1', name: 'Std Shop', zoneId: zone!._id, parentId: F2._id, ownerUserId: std.userId, address: 'x', tierId: std5!._id, prepaidBalancePaise: 5_000_000 });
    M = await Franchise.create({ type: 'REMOTE', code: 'M1', name: 'Mini Shop', zoneId: zone!._id, parentId: S._id, ownerUserId: mini.userId, address: 'x', tierId: mini3._id, prepaidBalancePaise: 5_000_000 });
    await supply(String(F2._id), [{ itemType: 'PACKAGE', itemId: pkg, quantity: 20 }]); // Premium's own stock
  });
  const give = (who: Acct, franchiseId: string, quantity: number, extra: object = {}) =>
    call(who, 'POST', '/franchise/supplies', { franchiseId, lines: [{ itemType: 'PACKAGE', itemId: pkg, quantity }], ...extra });

  it('moves stock down the chain and pays the supplier what the receiver is charged', async () => {
    const parentBefore = await bal(F2);
    const net = (await call(shop2, 'GET', '/franchise/network')).body.franchises.map((f: any) => [f.code, f.plan, f.discountPercent]).sort();
    assert.deepEqual(net, [['M1', 'Mini', 3], ['S1', 'Standard', 5]], 'Premium can supply Standard and Mini, at any depth');

    const prev = await call(shop2, 'POST', '/franchise/supplies/preview', { franchiseId: String(S._id), lines: [{ itemType: 'PACKAGE', itemId: pkg, quantity: 10 }] });
    assert.deepEqual([prev.body.totalRetailPaise, prev.body.totalCostPaise], [1_000_000, 950_000], 'the Standard franchise is charged at its own 5% discount');
    const r = await give(shop2, String(S._id), 10, { note: 'Monthly stock' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(await qty(F2, 'PACKAGE', pkg), 10, 'it left the supplier’s stock');
    assert.equal(await qty(S, 'PACKAGE', pkg), 10);
    assert.equal(await bal(S), 5_000_000 - 950_000);
    assert.equal(await bal(F2), parentBefore + 950_000, 'the supplier is paid what the receiver was charged');
    assert.deepEqual((await StockMovement.find({ franchiseId: F2._id, type: 'TRANSFER_OUT' })).map((m) => m.quantity), [-10]);

    assert.equal((await give(shop2, String(M._id), 5)).status, 201, 'Premium can also supply a Mini directly');
    assert.equal(await bal(M), 5_000_000 - 485_000, 'the Mini is charged at its own 3% discount');
    assert.equal((await give(std, String(M._id), 4)).status, 201, 'Standard supplies the Mini it manages');
    assert.equal(await qty(S, 'PACKAGE', pkg), 6);
    assert.equal(await qty(M, 'PACKAGE', pkg), 9);

    const sent = (await call(shop2, 'GET', '/franchise/supplies')).body.items;
    assert.deepEqual(sent.map((x: any) => [x.direction, x.franchise.code]).sort(), [['IN', 'F2'], ['OUT', 'M1'], ['OUT', 'S1']]);
    assert.equal((await call(std, 'GET', '/franchise/supplies')).body.items.length, 2, 'the receiver sees what it was sent and what it sent on');
  });

  it('only lets a franchise supply those below it, from stock it actually has, and only if the receiver can pay', async () => {
    assert.equal((await give(mini, String(S._id), 1)).status, 403, 'a Mini manages nobody');
    assert.equal((await give(std, String(F2._id), 1)).status, 403, 'never upwards');
    assert.equal((await give(shop, String(S._id), 1)).status, 403, 'an unrelated franchise');
    assert.equal((await call(mini, 'GET', '/franchise/network')).body.franchises.length, 0);

    const none = await give(std, String(M._id), 1);
    assert.equal(none.status, 400); assert.match(none.body.error, /Not enough stock/);
    assert.equal(await qty(M, 'PACKAGE', pkg), 0);

    const tooMany = await give(shop2, String(S._id), 25);
    assert.equal(tooMany.status, 400, 'more than the supplier holds');
    assert.equal(await qty(F2, 'PACKAGE', pkg), 20, 'nothing moved');

    await Franchise.updateOne({ _id: S._id }, { prepaidBalancePaise: 1000 });
    const poor = await give(shop2, String(S._id), 5);
    assert.equal(poor.status, 400); assert.match(poor.body.error, /does not cover/);
    assert.doesNotMatch(poor.body.error, /1000|10\.00/, 'a parent is not shown a sub-franchise’s balance');
    assert.equal(await qty(F2, 'PACKAGE', pkg), 20);
  });

  it('is safe against double clicks and cannot oversupply with simultaneous requests', async () => {
    const key = 'franchise-supply-1';
    const [a, b] = await Promise.all([give(shop2, String(S._id), 5, { clientKey: key }), give(shop2, String(S._id), 5, { clientKey: key })]);
    assert.deepEqual([a.status, b.status].sort(), [200, 201]);
    assert.equal(await qty(S, 'PACKAGE', pkg), 5);
    const res = await Promise.all(Array.from({ length: 5 }, () => give(shop2, String(S._id), 8)));
    assert.equal(res.filter((r) => r.status === 201).length, 1, 'only one of the five 8-unit supplies fits in the remaining 15');
    assert.equal(await qty(F2, 'PACKAGE', pkg), 20 - 5 - 8);
    const parent = await bal(F2);
    const [sum] = await FranchiseLedgerEntry.aggregate([{ $match: { franchiseId: F2._id } }, { $group: { _id: null, n: { $sum: '$amountPaise' } } }]);
    assert.equal(parent, 10_000_000 + sum.n, 'ledger matches the balance');
  });

  it('the new owner can then sell what they were supplied', async () => {
    await give(shop2, String(S._id), 3);
    await Member.create({ userId: (await mkUser('MEMBER', 'm2')).userId, memberCode: 'MEM2', franchiseId: S._id, upline: [] });
    const sale = await call(std, 'POST', '/franchise/sales', { memberCode: 'MEM2', items: [{ packageId: pkg, quantity: 1 }], payment: { type: 'COUNTER', method: 'CASH', reference: 'RCPT-CHAIN-1' } });
    assert.equal(sale.status, 201, JSON.stringify(sale.body));
    assert.equal(await qty(S, 'PACKAGE', pkg), 2);
  });
});
