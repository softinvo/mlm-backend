import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { CommissionPlan, ContactMessage, FranchiseTier, Package, Product, User, Wallet } from '../models';
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

const call = async (token: string | null, method: string, path: string, body?: unknown) => {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
let adminToken = '', memberToken = '';
beforeEach(async () => {
  await Promise.all(mongoose.modelNames().map((n) => mongoose.model(n).deleteMany({})));
  const mk = async (role: any, name: string) => { const u = await User.create({ role, status: 'ACTIVE', name, email: `${name}@t.com`, phone: String(9200000000 + Math.floor(Math.random() * 9999999)), passwordHash: await bcrypt.hash('Passw0rd!', 4) }); await Wallet.create({ userId: u._id, type: 'INCOME' }); return signToken({ userId: u._id.toString(), role }); };
  adminToken = await mk('SUPER_ADMIN', 'admin'); memberToken = await mk('MEMBER', 'mem');
});

describe('public website API', () => {
  it('admin can save cashback settings and rank requirements, and members can read their pages', async () => {
    const cb = await call(adminToken, 'PUT', '/admin/cashback', { enabled: true, percentPerDay: 1, maxDays: 30, maxTotalPercent: 30, includePackages: false });
    assert.equal(cb.status, 200, JSON.stringify(cb.body));
    assert.equal(cb.body.days, 30);
    assert.equal((await call(adminToken, 'PUT', '/admin/cashback', { enabled: true, percentPerDay: 5, maxDays: 30, maxTotalPercent: 1, includePackages: false })).status, 400, 'daily rate above the total limit');
    assert.equal((await call(memberToken, 'PUT', '/admin/cashback', { enabled: true, percentPerDay: 1, maxDays: 30, maxTotalPercent: 30, includePackages: false })).status, 403, 'members cannot');
    const rk = await call(adminToken, 'PUT', '/admin/rank-criteria', { ranks: [{ rank: 'SILVER', minTeamVolumePaise: 500000, minActiveDirects: 2 }] });
    assert.equal(rk.status, 200, JSON.stringify(rk.body));
    assert.equal((await call(adminToken, 'GET', '/admin/rank-criteria')).body.length, 1);
  });

  it('the public catalog shows the live cashback rule only while it is switched on', async () => {
    assert.equal((await call(null, 'GET', '/public/catalog')).body.cashback, null, 'off by default, so the website advertises nothing');
    await call(adminToken, 'PUT', '/admin/cashback', { enabled: true, percentPerDay: 1, maxDays: 30, maxTotalPercent: 30, includePackages: false });
    assert.deepEqual((await call(null, 'GET', '/public/catalog')).body.cashback, { percentPerDay: 1, days: 30, totalPercent: 30, includesPackages: false });
    await call(adminToken, 'PUT', '/admin/cashback', { enabled: true, percentPerDay: 2, maxDays: 10, maxTotalPercent: 30, includePackages: true });
    assert.deepEqual((await call(null, 'GET', '/public/catalog')).body.cashback, { percentPerDay: 2, days: 10, totalPercent: 20, includesPackages: true }, 'the days and total follow the rules');
    await call(adminToken, 'PUT', '/admin/cashback', { enabled: false, percentPerDay: 2, maxDays: 10, maxTotalPercent: 30, includePackages: true });
    assert.equal((await call(null, 'GET', '/public/catalog')).body.cashback, null, 'switching it off hides it again');
    assert.ok((await call(null, 'GET', '/public/site')).body.pages.opportunity.some((b: any) => b.type === 'cashback'), 'the Opportunity page has the card');
  });

  it('accepts the 8-level plan from plan.md (40 / 1x5 / 0.5x2) and rejects a cap below its 46% total', async () => {
    const levels = [40, 1, 1, 1, 1, 1, 0.5, 0.5].map((percent, i) => ({ level: i + 1, percent }));
    const low = await call(adminToken, 'POST', '/admin/commission-plans', { maxPayoutPercentOfVolume: 45, levels });
    assert.equal(low.status, 400, 'levels add up to 46%, above a 45% cap');
    const ok = await call(adminToken, 'POST', '/admin/commission-plans', { maxPayoutPercentOfVolume: 50, levels });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    const pub = (await call(null, 'GET', '/public/catalog')).body;
    assert.deepEqual(pub.plan.levels.map((l: any) => l.percent), [40, 1, 1, 1, 1, 1, 0.5, 0.5], 'the website shows the live table');
  });

  it('shows the live catalog and commission levels without signing in, and hides inactive items', async () => {
    await Package.create({ name: 'Starter Kit', description: 'Everything to begin', pricePaise: 55_000, imageUrl: 'https://files.example.com/package/a.png' });
    await Package.create({ name: 'Old Kit', pricePaise: 10_000, active: false });
    await Product.create({ sku: 'RP-1', name: 'Herbal Oil', description: 'Cold pressed', mrpPaise: 20_000, taxPercent: 0, commissionable: true });
    await CommissionPlan.create({ version: 1, effectiveFrom: new Date(0), active: true, maxPayoutPercentOfVolume: 30, levels: [{ level: 2, percent: 5 }, { level: 1, percent: 10 }] });
    const r = await call(null, 'GET', '/public/catalog');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.packages.map((p: any) => [p.name, p.pricePaise, p.imageUrl]), [['Starter Kit', 55_000, 'https://files.example.com/package/a.png']]);
    assert.deepEqual(r.body.products.map((p: any) => p.name), ['Herbal Oil']);
    assert.deepEqual(r.body.plan.levels, [{ level: 1, percent: 10 }, { level: 2, percent: 5 }]);
    assert.equal(JSON.stringify(r.body).includes('sku'), false, 'no internal fields leak');
    await FranchiseTier.create({ name: 'Premium', rank: 3, discountPercent: 8, investmentPaise: 50_000_000, maxMembers: 0, description: 'Large franchise' });
    await FranchiseTier.create({ name: 'Mini', rank: 1, discountPercent: 3, investmentPaise: 2_500_000, maxMembers: 100 });
    await FranchiseTier.create({ name: 'Retired', rank: 2, discountPercent: 5, active: false });
    const withPlans = (await call(null, 'GET', '/public/catalog')).body;
    assert.deepEqual(withPlans.plans.map((p: any) => [p.name, p.discountPercent, p.investmentPaise, p.maxMembers]), [['Mini', 3, 2_500_000, 100], ['Premium', 8, 50_000_000, 0]], 'franchise plans, smallest first, inactive ones hidden');
  });

  it('takes contact messages from anyone, validates them, ignores bots, and lets the admin mark them handled', async () => {
    const ok = { name: 'Riya Sharma', email: 'riya@example.com', phone: '9876543210', subject: 'Becoming a franchise', message: 'I would like to know how to open a franchise in Nashik.' };
    assert.equal((await call(null, 'POST', '/public/contact', ok)).status, 201);
    assert.equal((await call(null, 'POST', '/public/contact', { ...ok, email: 'nope' })).status, 400);
    assert.equal((await call(null, 'POST', '/public/contact', { ...ok, message: 'short' })).status, 400);
    assert.equal((await call(null, 'POST', '/public/contact', { ...ok, phone: '123' })).status, 400);
    const bot = await call(null, 'POST', '/public/contact', { ...ok, website: 'http://spam.example' });
    assert.equal(bot.status, 200);
    assert.equal(await ContactMessage.countDocuments({}), 1, 'the bot’s message was not stored');

    assert.equal((await call(memberToken, 'GET', '/admin/support/enquiries')).status, 403);
    const list = (await call(adminToken, 'GET', '/admin/support/enquiries')).body;
    assert.deepEqual([list.total, list.newCount, list.items[0].name, list.items[0].status], [1, 1, 'Riya Sharma', 'NEW']);
    assert.equal((await call(adminToken, 'POST', `/admin/support/enquiries/${list.items[0].id}/handled`)).body.status, 'HANDLED');
    assert.equal((await call(adminToken, 'GET', '/admin/support/enquiries')).body.newCount, 0);
  });

  it('rate-limits the contact form', async () => {
    const body = { name: 'Spam Bot', email: 'bot@example.com', message: 'Please buy my product, it is very good.' };
    const codes: number[] = [];
    for (let i = 0; i < 8; i++) codes.push((await call(null, 'POST', '/public/contact', body)).status);
    assert.ok(codes.includes(429), JSON.stringify(codes));
  });
});
