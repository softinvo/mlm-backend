import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { AuditLog, Franchise, FranchiseTier, Member, Order, Package, User, Wallet, Zone } from '../models';
import { postEntry } from '../services/ledger.service';
import { placeOrder } from '../services/order.service';
import { requestWithdrawal, reviewKyc, submitKyc } from '../services/wallet.service';
import { submitFundRequest } from '../services/fund.service';
import { signToken } from '../utils/jwt';
import { withTx } from '../utils/tx';

let rs: MongoMemoryReplSet;
let server: import('node:http').Server;
let base = '';

before(async () => {
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  process.env.MONGODB_URI = rs.getUri();
  process.env.JWT_SECRET = 'test-secret-test-secret-123456';
  process.env.WITHDRAWAL_MIN_PAISE = '10000';
  await mongoose.connect(rs.getUri());
  await Promise.all(mongoose.modelNames().map((n) => mongoose.model(n).init()));
  const { app } = await import('../app');
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});
after(async () => { server.close(); await mongoose.disconnect(); await rs.stop(); });

interface Acct { userId: string; token: string }
let admin: Acct, r1: Acct, r2: Acct, zonal: Acct, other: Acct;                 // staff
let m1: Acct, m2: Acct, m3: Acct;                                              // members of R1, R2, R3
let F: Record<string, any>, pkgId: string, TIER: string, PREM = '', MID = '';

const mkUser = async (role: any, name: string): Promise<Acct> => {
  const u = await User.create({ role, status: 'ACTIVE', name, email: `${name}@t.com`, phone: String(9300000000 + Math.floor(Math.random() * 9999999)), passwordHash: await bcrypt.hash('Passw0rd!', 4) });
  await Wallet.create({ userId: u._id, type: 'INCOME' });
  return { userId: u._id.toString(), token: signToken({ userId: u._id.toString(), role }) };
};
const call = async (who: Acct | null, method: string, path: string, body?: unknown) => {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(who ? { Authorization: `Bearer ${who.token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
const fund = (userId: string, wallet: 'INCOME' | 'SHOPPING', amt: number) => withTx((s) => postEntry(s, { userId, wallet, amountPaise: amt, type: 'ADJUSTMENT', key: `f:${Math.random()}` }));
const bal = async (u: string, t: 'INCOME' | 'SHOPPING' = 'SHOPPING') => (await Wallet.findOne({ userId: u, type: t }))?.balancePaise ?? 0;
const kyc = { accountHolder: 'Member One', accountNumber: '123456789012', ifsc: 'HDFC0001234', pan: 'ABCDE1234F' };

beforeEach(async () => {
  await Promise.all(mongoose.modelNames().map((n) => mongoose.model(n).deleteMany({})));
  admin = await mkUser('SUPER_ADMIN', 'admin'); zonal = await mkUser('ZONAL_FRANCHISE', 'zonal');
  r1 = await mkUser('REMOTE_FRANCHISE', 'r1'); r2 = await mkUser('REMOTE_FRANCHISE', 'r2'); other = await mkUser('ZONAL_FRANCHISE', 'otherzonal');
  const r3u = await mkUser('REMOTE_FRANCHISE', 'r3');
  TIER = String((await FranchiseTier.create({ name: 'Std', rank: 1, discountPercent: 5 }))._id);
  PREM = String((await FranchiseTier.create({ name: 'Prem', rank: 3, discountPercent: 8 }))._id);
  MID = String((await FranchiseTier.create({ name: 'Mid', rank: 2, discountPercent: 6 }))._id);
  const z1 = await Zone.create({ name: 'Z1', states: [] }), z2 = await Zone.create({ name: 'Z2', states: [] });
  const Z1 = await Franchise.create({ type: 'ZONAL', code: 'Z1', name: 'Zonal 1', zoneId: z1._id, ownerUserId: zonal.userId, address: 'x', commissionPercent: 1 });
  const Z2 = await Franchise.create({ type: 'ZONAL', code: 'Z2', name: 'Zonal 2', zoneId: z2._id, ownerUserId: other.userId, address: 'x', commissionPercent: 1 });
  const R1 = await Franchise.create({ type: 'REMOTE', code: 'R1', name: 'Remote 1', zoneId: z1._id, parentId: Z1._id, ownerUserId: r1.userId, address: 'x', commissionPercent: 2 });
  const R2 = await Franchise.create({ type: 'REMOTE', code: 'R2', name: 'Remote 2', zoneId: z1._id, parentId: Z1._id, ownerUserId: r2.userId, address: 'x', commissionPercent: 2 });
  const R3 = await Franchise.create({ type: 'REMOTE', code: 'R3', name: 'Remote 3', zoneId: z2._id, parentId: Z2._id, ownerUserId: r3u.userId, address: 'x', commissionPercent: 2 });
  F = { Z1, Z2, R1, R2, R3 };
  const mk = async (name: string, fr: any) => { const a = await mkUser('MEMBER', name); await Member.create({ userId: a.userId, memberCode: name.toUpperCase(), franchiseId: fr._id, upline: [] }); return a; };
  m1 = await mk('m1', R1); m2 = await mk('m2', R2); m3 = await mk('m3', R3);
  pkgId = String((await Package.create({ name: 'Package A', pricePaise: 55000 }))._id);
});

const orderFor = async (m: Acct, fr: any) => String((await placeOrder({ buyerUserId: m.userId, franchiseId: fr._id, items: [{ packageId: pkgId, quantity: 1 }] }))._id);

describe('who can reach the franchise panel', () => {
  it('only franchise accounts; admins and members are refused', async () => {
    assert.equal((await call(null, 'GET', '/franchise/overview')).status, 401);
    assert.equal((await call(m1, 'GET', '/franchise/overview')).status, 403);
    assert.equal((await call(admin, 'GET', '/franchise/overview')).status, 403);
    assert.equal((await call(r1, 'GET', '/franchise/overview')).status, 200);
  });
  it('a franchise sees only its own members; a zonal franchise also sees its remotes; nobody sees another zone', async () => {
    const names = async (who: Acct) => (await call(who, 'GET', '/franchise/members')).body.items.map((m: any) => m.name).sort();
    assert.deepEqual(await names(r1), ['m1']);
    assert.deepEqual(await names(r2), ['m2']);
    assert.deepEqual(await names(zonal), ['m1', 'm2']);
    assert.deepEqual(await names(other), ['m3']);
    const o = (await call(zonal, 'GET', '/franchise/overview')).body;
    assert.deepEqual(o.franchises.map((f: any) => f.code).sort(), ['R1', 'R2', 'Z1']);
    assert.equal(o.counts.members, 2);
  });
  it('a franchise with no active franchise gets 403', async () => {
    await Franchise.updateMany({}, { active: false });
    assert.equal((await call(r1, 'GET', '/franchise/overview')).status, 403);
  });
});

describe('bank-detail verification', () => {
  it('lets only the member’s own franchise review it, and logs every view of the full number', async () => {
    await submitKyc(m1.userId, kyc);
    const q = (await call(r1, 'GET', '/franchise/kyc?status=PENDING')).body;
    assert.equal(q.total, 1);
    assert.equal(q.items[0].accountLast4, '9012');
    assert.ok(!JSON.stringify(q).includes('123456789012'), 'the list never carries the full number');
    assert.equal((await call(r2, 'GET', '/franchise/kyc')).body.total, 0);
    assert.equal((await call(r2, 'GET', `/franchise/kyc/${m1.userId}`)).status, 404);
    assert.equal((await call(r2, 'POST', `/franchise/kyc/${m1.userId}/review`, { status: 'VERIFIED' })).status, 404);

    const d = await call(r1, 'GET', `/franchise/kyc/${m1.userId}`);
    assert.equal(d.body.accountNumber, '123456789012');
    assert.equal(await AuditLog.countDocuments({ action: 'KYC_VIEWED', actorId: r1.userId }), 1);

    assert.equal((await call(r1, 'POST', `/franchise/kyc/${m1.userId}/review`, { status: 'REJECTED' })).status, 400, 'a rejection needs a reason');
    assert.equal((await call(r1, 'POST', `/franchise/kyc/${m1.userId}/review`, { status: 'VERIFIED' })).status, 200);
    assert.equal((await User.findById(m1.userId))!.kyc!.status, 'VERIFIED');
  });
});

describe('top-ups: franchise recommends, admin decides', () => {
  const submit = (m: Acct) => submitFundRequest(m.userId, { amountPaise: 100000, mode: 'UPI', reference: 'UTR' + Math.random().toString(36).slice(2, 12).toUpperCase(), paidOn: new Date() });

  it('only the owning franchise can see and recommend; a recommendation never credits money', async () => {
    const f = await submit(m1);
    assert.equal((await call(r2, 'GET', '/franchise/fund-requests')).body.total, 0);
    assert.equal((await call(r2, 'POST', `/franchise/fund-requests/${f._id}/recommend`, { decision: 'APPROVE' })).status, 404);
    assert.equal((await call(r1, 'POST', `/franchise/fund-requests/${f._id}/recommend`, { decision: 'REJECT' })).status, 400, 'reject needs a note');
    assert.equal((await call(r1, 'POST', `/franchise/fund-requests/${f._id}/recommend`, { decision: 'APPROVE', approvedPaise: 200000 })).status, 400, 'cannot exceed the claim');
    assert.equal((await call(r1, 'POST', `/franchise/fund-requests/${f._id}/recommend`, { decision: 'APPROVE', approvedPaise: 90000, note: 'Cash seen: 900' })).status, 200);
    assert.equal(await bal(m1.userId), 0, 'franchise recommendation moves no money');
    const l = (await call(r1, 'GET', '/franchise/fund-requests?status=PENDING')).body.items[0];
    assert.equal(l.status, 'PENDING');
    assert.equal(l.recommendation.decision, 'APPROVE');
  });

  it('franchises cannot use the approval endpoints; the admin sees the recommendation and credits once', async () => {
    const f = await submit(m1);
    await call(r1, 'POST', `/franchise/fund-requests/${f._id}/recommend`, { decision: 'APPROVE', approvedPaise: 90000, note: 'ok' });
    assert.equal((await call(r1, 'POST', `/admin/fund-requests/${f._id}/approve`, {})).status, 403);
    assert.equal((await call(zonal, 'POST', `/admin/fund-requests/${f._id}/approve`, {})).status, 403);
    const q = (await call(admin, 'GET', '/admin/fund-requests?status=PENDING')).body.items[0];
    assert.equal(q.recommendation.approvedPaise, 90000);
    assert.equal(q.franchise.code, 'R1');
    assert.equal(q.member.name, 'm1');
    assert.equal((await call(admin, 'POST', `/admin/fund-requests/${f._id}/approve`, { approvedPaise: 90000 })).status, 200);
    assert.equal(await bal(m1.userId), 90000);
  });
});

describe('withdrawals: franchise recommends and pays only after the admin approves', () => {
  it('runs the whole chain and hides the account number until it is needed', async () => {
    await submitKyc(m1.userId, kyc); await reviewKyc(m1.userId, 'VERIFIED', undefined, admin.userId);
    await fund(m1.userId, 'INCOME', 50000);
    const w = await requestWithdrawal(m1.userId, 30000);
    assert.equal((await call(r2, 'GET', '/franchise/withdrawals')).body.total, 0);

    const first = (await call(r1, 'GET', '/franchise/withdrawals')).body.items[0];
    assert.equal(first.bank.accountNumber, null, 'not revealed while it is only a request');
    assert.equal((await call(r1, 'POST', `/franchise/withdrawals/${w._id}/recommend`, { decision: 'APPROVE', note: 'KYC ok' })).status, 200);
    assert.equal((await call(r1, 'POST', `/franchise/withdrawals/${w._id}/pay`, { payoutRef: 'UTR999999' })).status, 409, 'cannot pay before admin approval');
    assert.equal((await call(r1, 'POST', `/admin/withdrawals/${w._id}/approve`)).status, 403);

    assert.equal((await call(admin, 'POST', `/admin/withdrawals/${w._id}/approve`)).status, 200);
    const approved = (await call(r1, 'GET', '/franchise/withdrawals?status=APPROVED')).body.items[0];
    assert.equal(approved.bank.accountNumber, '123456789012', 'revealed once approved, so it can be paid');
    assert.equal((await call(r2, 'POST', `/franchise/withdrawals/${w._id}/pay`, { payoutRef: 'UTR999999' })).status, 404);
    assert.equal((await call(r1, 'POST', `/franchise/withdrawals/${w._id}/pay`, { payoutRef: 'UTR999999' })).status, 200);
    assert.equal((await Wallet.findOne({ userId: m1.userId, type: 'INCOME' }))!.balancePaise, 20000);
  });
});

describe('orders: the franchise collects payment and ships', () => {
  it('walks an order from placed to delivered', async () => {
    const id = await orderFor(m1, F.R1);
    assert.equal((await call(r2, 'GET', '/franchise/orders?tab=awaiting')).body.total, 0);
    assert.equal((await call(r2, 'POST', `/franchise/orders/${id}/payment-received`, { method: 'CASH', reference: 'RCPT0001' })).status, 404);
    assert.equal((await call(r1, 'POST', `/franchise/orders/${id}/shipment`, { status: 'PACKED' })).status, 409, 'cannot ship an unpaid order');

    const paid = await call(r1, 'POST', `/franchise/orders/${id}/payment-received`, { method: 'CASH', reference: 'RCPT0001', note: 'Cash at counter' });
    assert.equal(paid.status, 200, JSON.stringify(paid.body));
    assert.equal((await Order.findById(id))!.status, 'PAID', 'paid at once, no head-office confirmation needed');
    assert.equal((await Franchise.findById(F.R1._id))!.prepaidBalancePaise, 0, 'collecting a payment does not touch the prepaid balance');

    const dup = await orderFor(m1, F.R1);
    assert.equal((await call(r1, 'POST', `/franchise/orders/${dup}/payment-received`, { method: 'CASH', reference: 'rcpt-0001' })).status, 409, 'same receipt cannot back two orders');

    assert.equal((await call(r1, 'POST', `/franchise/orders/${id}/shipment`, { status: 'PACKED' })).status, 200);
    assert.equal((await call(r2, 'POST', `/franchise/orders/${id}/shipment`, { status: 'SHIPPED', courier: 'C', trackingId: 'T' })).status, 404);
    assert.equal((await call(r1, 'POST', `/franchise/orders/${id}/shipment`, { status: 'SHIPPED' })).status, 400, 'courier details required');
    assert.equal((await call(r1, 'POST', `/franchise/orders/${id}/shipment`, { status: 'SHIPPED', courier: 'Delhivery', trackingId: 'DL1' })).status, 200);
    assert.equal((await call(r1, 'GET', '/franchise/orders?tab=transit')).body.total, 1);
    assert.equal((await call(r1, 'POST', `/franchise/orders/${id}/shipment`, { status: 'DELIVERED' })).status, 200);
    assert.equal((await call(r1, 'GET', '/franchise/orders?tab=done')).body.total, 1);
    assert.equal((await call(r1, 'POST', `/franchise/orders/${id}/cancel`, { reason: 'too late' })).status, 409);
  });

  it('lets a franchise cancel an unpaid order, and the admin still confirm a payment made elsewhere', async () => {
    const a = await orderFor(m1, F.R1), b = await orderFor(m1, F.R1);
    assert.equal((await call(r1, 'POST', `/franchise/orders/${a}/cancel`, { reason: 'customer left' })).status, 200);
    assert.equal((await call(r1, 'POST', `/admin/orders/${b}/pay`, { gatewayRef: 'X-1234' })).status, 403, 'franchises cannot confirm payments');
    assert.equal((await call(admin, 'POST', `/admin/orders/${b}/pay`, { gatewayRef: 'ONLINE-1234', gateway: 'manual' })).status, 200);
    assert.equal((await Franchise.findById(F.R1._id))!.prepaidBalancePaise, 0, 'an order the head office collected does not touch the franchise balance');
  });
});

describe('head office manages franchises', () => {
  const owner = (n: string) => ({ name: `${n} Owner`, email: `${n}@owners.com`, phone: String(9400000000 + Math.floor(Math.random() * 9999999)), password: 'Welcome#123' });

  it('creates a zonal and a remote franchise whose owners can sign in to their own panel', async () => {
    const z = await call(admin, 'POST', '/admin/franchises', { name: 'North Zone HQ', code: 'zn-01', zoneName: 'North', address: 'Delhi', tierId: PREM, owner: owner('north') });
    assert.equal(z.status, 201, JSON.stringify(z.body));
    const r = await call(admin, 'POST', '/admin/franchises', { name: 'Noida Point', code: 'RN-01', parentId: (await Franchise.findOne({ code: 'ZN-01' }))!._id.toString(), address: 'Noida', tierId: TIER, owner: owner('noida') });
    assert.equal(r.status, 201, JSON.stringify(r.body));

    const login = await call(null, 'POST', '/auth/login', { email: 'noida@owners.com', password: 'Welcome#123' });
    assert.equal(login.body.role, 'REMOTE_FRANCHISE');
    const token = { userId: '', token: login.body.token };
    assert.equal((await call(token, 'GET', '/franchise/overview')).body.franchises[0].code, 'RN-01');
    const zl = await call(null, 'POST', '/auth/login', { email: 'north@owners.com', password: 'Welcome#123' });
    assert.deepEqual((await call({ userId: '', token: zl.body.token }, 'GET', '/franchise/overview')).body.franchises.map((f: any) => f.code).sort(), ['RN-01', 'ZN-01']);
  });

  it('rejects duplicates, bad parents and non-admins; can deactivate a franchise', async () => {
    await Franchise.updateMany({ code: { $in: ['Z1', 'Z2'] } }, { tierId: PREM });
    await Franchise.updateMany({ code: { $in: ['R1', 'R2', 'R3'] } }, { tierId: TIER });
    const body = { name: 'Xray Point', code: 'RX-01', parentId: F.Z1._id.toString(), address: 'addr', tierId: TIER, owner: owner('x') };
    assert.equal((await call(r1, 'POST', '/admin/franchises', body)).status, 403);
    assert.equal((await call(admin, 'POST', '/admin/franchises', { ...body, parentId: F.R1._id.toString() })).status, 400, 'a lowest-plan franchise cannot manage others');
    assert.equal((await call(admin, 'POST', '/admin/franchises', body)).status, 201);
    assert.equal((await call(admin, 'POST', '/admin/franchises', { ...body, owner: owner('y') })).status, 409, 'code already used');
    assert.equal((await call(admin, 'POST', '/admin/franchises', { ...body, code: 'RX-02', owner: { ...owner('x'), email: 'x@owners.com' } })).status, 409, 'email already used');
    const list = (await call(admin, 'GET', '/admin/franchises')).body.items;
    assert.ok(list.find((f: any) => f.code === 'R1').members === 1);
    assert.equal((await call(admin, 'PATCH', `/admin/franchises/${F.R1._id}`, { active: false })).status, 200);
    assert.equal((await call(r1, 'GET', '/franchise/overview')).status, 403, 'a deactivated franchise loses access');
  });
});

describe('accounts', () => {
  it('shows who you are and lets any role change its own password', async () => {
    const me = (await call(r1, 'GET', '/account/me')).body;
    assert.equal(me.role, 'REMOTE_FRANCHISE');
    assert.equal(me.franchises[0].code, 'R1');
    assert.equal((await call(r1, 'POST', '/account/password', { currentPassword: 'wrong', newPassword: 'Another#1234' })).status, 400);
    assert.equal((await call(r1, 'POST', '/account/password', { currentPassword: 'Passw0rd!', newPassword: 'Another#1234' })).status, 200);
    assert.equal((await call(null, 'POST', '/auth/login', { email: 'r1@t.com', password: 'Another#1234' })).status, 200);
  });
});

describe('hierarchy follows the plan: Premium > Standard > Mini', () => {
  const owner = (n: string) => ({ name: `${n} Owner`, email: `${n}@h.com`, phone: String(9300000000 + Math.floor(Math.random() * 9999999)), password: 'Welcome#123' });
  const mk = (extra: object) => call(admin, 'POST', '/admin/franchises', { address: 'addr', ...extra });

  it('lets Premium manage Standard and Mini, Standard manage Mini, and never Mini manage anyone', async () => {
    const p = await mk({ name: 'P Franchise', code: 'PRM-1', zoneName: 'Hub', tierId: PREM, owner: owner('p') });
    assert.equal(p.status, 201, JSON.stringify(p.body));
    const pid = p.body.franchiseId;
    const s = await mk({ name: 'S Franchise', code: 'STD-1', parentId: pid, tierId: MID, owner: owner('s') });
    assert.equal(s.status, 201, JSON.stringify(s.body));
    const m1x = await mk({ name: 'M1 Franchise', code: 'MIN-1', parentId: pid, tierId: TIER, owner: owner('m1x') });
    assert.equal(m1x.status, 201, 'Premium can manage Mini directly');
    const m2x = await mk({ name: 'M2 Franchise', code: 'MIN-2', parentId: s.body.franchiseId, tierId: TIER, owner: owner('m2x') });
    assert.equal(m2x.status, 201, 'Standard can manage Mini');

    const bad1 = await mk({ name: 'M3 Franchise', code: 'MIN-3', parentId: m1x.body.franchiseId, tierId: TIER, owner: owner('m3x') });
    assert.equal(bad1.status, 400); assert.match(bad1.body.error, /cannot manage/);
    assert.equal((await mk({ name: 'S2 Franchise', code: 'STD-2', parentId: s.body.franchiseId, tierId: MID, owner: owner('s2x') })).status, 400, 'Standard cannot manage Standard');
    assert.equal((await mk({ name: 'P2 Franchise', code: 'PRM-2', parentId: s.body.franchiseId, tierId: PREM, owner: owner('p2x') })).status, 400, 'nobody manages a higher plan');
  });

  it('a franchise sees everyone below it at any depth, but never above or beside, and never a sub-franchise’s money', async () => {
    const p = (await mk({ name: 'P Franchise', code: 'PRM-1', zoneName: 'Hub', tierId: PREM, owner: owner('p') })).body.franchiseId;
    const s = (await mk({ name: 'S Franchise', code: 'STD-1', parentId: p, tierId: MID, owner: owner('s') })).body.franchiseId;
    await mk({ name: 'M Franchise', code: 'MIN-1', parentId: s, tierId: TIER, owner: owner('m') });
    const login = async (e: string) => ({ userId: '', token: (await call(null, 'POST', '/auth/login', { email: e, password: 'Welcome#123' })).body.token });
    const codes = async (e: string) => (await call(await login(e), 'GET', '/franchise/overview')).body.franchises.map((f: any) => f.code).sort();
    assert.deepEqual(await codes('p@h.com'), ['MIN-1', 'PRM-1', 'STD-1']);
    assert.deepEqual(await codes('s@h.com'), ['MIN-1', 'STD-1']);
    assert.deepEqual(await codes('m@h.com'), ['MIN-1']);
    const top = await login('p@h.com');
    const childId = (await Franchise.findOne({ code: 'MIN-1' }))!._id.toString();
    assert.equal((await call(top, 'GET', `/franchise/prepaid?franchiseId=${childId}`)).status, 404);
    assert.equal((await call(top, 'POST', '/franchise/recharges', { franchiseId: childId, amountPaise: 500000, mode: 'NEFT', reference: 'NEFT-XYZ-001', paidOn: new Date().toISOString() })).status, 404);
  });

  it('the admin can move a franchise to another parent, or detach it, but only within the rules', async () => {
    const p = (await mk({ name: 'P Franchise', code: 'PRM-1', zoneName: 'Hub', tierId: PREM, owner: owner('p') })).body.franchiseId;
    const s = (await mk({ name: 'S Franchise', code: 'STD-1', parentId: p, tierId: MID, owner: owner('s') })).body.franchiseId;
    const m = (await mk({ name: 'M Franchise', code: 'MIN-1', parentId: p, tierId: TIER, owner: owner('m') })).body.franchiseId;
    assert.equal((await call(r1, 'PATCH', `/admin/franchises/${m}`, { parentId: s })).status, 403);
    assert.equal((await call(admin, 'PATCH', `/admin/franchises/${m}`, { parentId: s })).status, 200, 'Mini moves under Standard');
    assert.equal((await Franchise.findById(m))!.parentId?.toString(), s);
    assert.equal((await call(admin, 'PATCH', `/admin/franchises/${p}`, { parentId: m })).status, 400, 'Premium cannot move under Mini');
    assert.equal((await call(admin, 'PATCH', `/admin/franchises/${s}`, { tierId: TIER })).status, 400, 'Standard cannot drop to Mini while it manages one');
    assert.equal((await call(admin, 'PATCH', `/admin/franchises/${m}`, { tierId: MID })).status, 400, 'Mini cannot rise to its parent’s plan');
    assert.equal((await call(admin, 'PATCH', `/admin/franchises/${m}`, { parentId: null })).status, 200, 'detached: reports to head office');
    assert.equal((await Franchise.findById(m))!.parentId, null);
    const list = (await call(admin, 'GET', '/admin/franchises')).body.items;
    assert.equal(list.find((f: any) => f.code === 'PRM-1').manages, 1);
    assert.equal(list.find((f: any) => f.code === 'STD-1').parent.code, 'PRM-1');
  });
});
