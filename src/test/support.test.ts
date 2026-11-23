import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { AuditLog, Franchise, Member, SupportTicket, User, Wallet, Zone } from '../models';
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
let admin: Acct, admin2: Acct, m1: Acct, m2: Acct, shop: Acct;
const mkUser = async (role: any, name: string): Promise<Acct> => {
  const u = await User.create({ role, status: 'ACTIVE', name, email: `${name}@t.com`, phone: String(9100000000 + Math.floor(Math.random() * 9999999)), passwordHash: await bcrypt.hash('Passw0rd!', 4) });
  await Wallet.create({ userId: u._id, type: 'INCOME' });
  return { userId: u._id.toString(), token: signToken({ userId: u._id.toString(), role }) };
};
const call = async (who: Acct | null, method: string, path: string, body?: unknown) => {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(who ? { Authorization: `Bearer ${who.token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
const ticket = (over: object = {}) => ({ category: 'ORDER', subject: 'My order has not arrived', message: 'I ordered a week ago and nothing has come yet.', ...over });

beforeEach(async () => {
  await Promise.all(mongoose.modelNames().map((n) => mongoose.model(n).deleteMany({})));
  admin = await mkUser('SUPER_ADMIN', 'admin'); admin2 = await mkUser('SUPER_ADMIN', 'admin2'); m1 = await mkUser('MEMBER', 'm1'); m2 = await mkUser('MEMBER', 'm2'); shop = await mkUser('REMOTE_FRANCHISE', 'shop');
  const zone = await Zone.create({ name: 'Z', states: [] });
  const f = await Franchise.create({ type: 'ZONAL', code: 'F1', name: 'Pune Point', zoneId: zone._id, ownerUserId: shop.userId, address: 'x' });
  await Member.create({ userId: m1.userId, memberCode: 'MEM1', franchiseId: f._id, upline: [] });
});

describe('help & support', () => {
  it('a member raises a ticket, the admin answers, the member replies, and it is solved', async () => {
    const c = await call(m1, 'POST', '/member/support/tickets', ticket({ orderRef: '#8F0D12' }));
    assert.equal(c.status, 201, JSON.stringify(c.body));
    assert.match(c.body.number, /^SUP-\d{6}$/);
    assert.deepEqual([c.body.status, c.body.priority, c.body.messages.length], ['OPEN', 'NORMAL', 1]);
    const id = c.body.id;

    assert.equal((await call(m2, 'GET', `/member/support/tickets/${id}`)).status, 404, 'nobody else can read it');
    assert.equal((await call(m2, 'POST', `/member/support/tickets/${id}/reply`, { message: 'hi' })).status, 404);
    assert.equal((await call(m1, 'GET', '/member/support/tickets')).body.total, 1);
    assert.equal((await call(m2, 'GET', '/member/support/tickets')).body.total, 0);
    assert.equal((await call(m1, 'GET', '/admin/support/tickets')).status, 403, 'members cannot open the desk');

    const desk = (await call(admin, 'GET', '/admin/support/tickets?status=active')).body;
    assert.deepEqual([desk.total, desk.items[0].from.memberCode, desk.items[0].waitingOnUs], [1, 'MEM1', true]);
    const detail = (await call(admin, 'GET', `/admin/support/tickets/${id}`)).body;
    assert.deepEqual([detail.requester.name, detail.requester.memberCode, detail.requester.franchise.code], ['m1', 'MEM1', 'F1']);

    const note = await call(admin, 'POST', `/admin/support/tickets/${id}/reply`, { message: 'Courier says it is stuck; checking with the shop.', internal: true });
    assert.equal(note.status, 200);
    assert.equal(note.body.status, 'OPEN', 'a private note changes nothing');
    assert.equal((await call(m1, 'GET', `/member/support/tickets/${id}`)).body.messages.length, 1, 'the member never sees internal notes');

    const reply = await call(admin, 'POST', `/admin/support/tickets/${id}/reply`, { message: 'We are chasing the courier. Expect it in 2 days.' });
    assert.equal(reply.body.status, 'WAITING_ON_USER');
    assert.equal(reply.body.assignedName, 'admin', 'the first admin to answer takes it');
    assert.ok(reply.body.firstResponseMinutes >= 0);
    const mine = (await call(m1, 'GET', `/member/support/tickets/${id}`)).body;
    assert.deepEqual([mine.needsYourReply, mine.messages.map((m: any) => m.author)], [true, ['m1', 'Support team']]);
    assert.equal((await call(m1, 'GET', '/member/support/summary')).body.needsReply, 1);
    assert.equal((await call(admin, 'GET', '/admin/overview')).body.counts.supportOpen, 0, 'nothing waits on the head office now');

    const back = await call(m1, 'POST', `/member/support/tickets/${id}/reply`, { message: 'Thanks, it came today!' });
    assert.equal(back.body.status, 'OPEN', 'their reply puts it back in the queue');
    assert.equal((await call(admin, 'GET', '/admin/overview')).body.counts.supportOpen, 1);

    const solved = await call(admin, 'POST', `/admin/support/tickets/${id}/reply`, { message: 'Glad it arrived!', status: 'RESOLVED' });
    assert.equal(solved.body.status, 'RESOLVED');
    assert.equal((await call(m1, 'POST', `/member/support/tickets/${id}/rate`, { stars: 5, comment: 'Quick help' })).body.rating.stars, 5);
    assert.equal((await call(m1, 'POST', `/member/support/tickets/${id}/rate`, { stars: 1 })).status, 409, 'one rating only');
    assert.equal((await call(admin, 'GET', '/admin/support/summary')).body.rating.average, 5);
    assert.ok(await AuditLog.exists({ action: 'TICKET_REPLY', entityId: id }));
  });

  it('works for franchise owners too, and the desk can filter, assign and reprioritise', async () => {
    const f = await call(shop, 'POST', '/franchise/support/tickets', ticket({ category: 'STOCK', subject: 'Need more kits urgently', priority: 'HIGH' }));
    assert.equal(f.status, 201, JSON.stringify(f.body));
    const mem = await call(m1, 'POST', '/member/support/tickets', ticket({ category: 'WITHDRAWAL', subject: 'Withdrawal still pending' }));
    const asUrgent = await call(m1, 'POST', '/member/support/tickets', ticket({ subject: 'Trying to mark urgent', priority: 'URGENT' }));
    assert.equal(asUrgent.body.priority, 'NORMAL', 'only the head office can mark a ticket urgent');

    assert.equal((await call(admin, 'GET', '/admin/support/tickets?who=franchise')).body.items[0].from.franchiseCode, 'F1');
    assert.equal((await call(admin, 'GET', '/admin/support/tickets?who=member')).body.total, 2);
    assert.equal((await call(admin, 'GET', '/admin/support/tickets?category=STOCK')).body.total, 1);
    assert.equal((await call(admin, 'GET', `/admin/support/tickets?search=${f.body.number.slice(-3)}`)).body.items.length >= 1, true, 'find by ticket number');
    assert.equal((await call(admin, 'GET', '/admin/support/tickets?search=Withdrawal')).body.total, 1);
    assert.equal((await call(admin, 'GET', '/admin/support/tickets?assigned=unassigned')).body.total, 3);

    assert.equal((await call(shop, 'GET', `/franchise/support/tickets/${mem.body.id}`)).status, 404, 'a franchise cannot read a member’s ticket');
    const upd = await call(admin2, 'PATCH', `/admin/support/tickets/${f.body.id}`, { assign: 'me', priority: 'URGENT', status: 'IN_PROGRESS' });
    assert.deepEqual([upd.body.assignedName, upd.body.priority, upd.body.status], ['admin2', 'URGENT', 'IN_PROGRESS']);
    assert.equal((await call(admin2, 'GET', '/admin/support/tickets?assigned=me')).body.total, 1);
    const s = (await call(admin, 'GET', '/admin/support/summary')).body;
    assert.deepEqual([s.urgent, s.unassigned, s.inProgress, s.open], [1, 2, 1, 2]);
    assert.equal((await call(shop, 'PATCH', `/admin/support/tickets/${f.body.id}`, { status: 'CLOSED' })).status, 403);
  });

  it('limits open tickets, validates input, and handles close and reopen', async () => {
    assert.equal((await call(m1, 'POST', '/member/support/tickets', ticket({ subject: 'x' }))).status, 400);
    assert.equal((await call(m1, 'POST', '/member/support/tickets', ticket({ category: 'NOPE' }))).status, 400);
    assert.equal((await call(m1, 'POST', '/member/support/tickets', ticket({ message: 'short' }))).status, 400);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await call(m1, 'POST', '/member/support/tickets', ticket({ subject: `Question number ${i}` }))).body.id);
    const sixth = await call(m1, 'POST', '/member/support/tickets', ticket({ subject: 'One more question' }));
    assert.equal(sixth.status, 400); assert.match(sixth.body.error, /5 open tickets/);

    const closed = await call(m1, 'POST', `/member/support/tickets/${ids[0]}/close`);
    assert.equal(closed.body.status, 'CLOSED');
    assert.equal((await call(m1, 'POST', `/member/support/tickets/${ids[0]}/reply`, { message: 'hello again' })).status, 409, 'closed tickets take no replies');
    assert.equal((await call(admin, 'POST', `/admin/support/tickets/${ids[0]}/reply`, { message: 'too late' })).status, 409);
    assert.equal((await call(m1, 'POST', '/member/support/tickets', ticket({ subject: 'Now there is room' }))).status, 201, 'closing frees a slot');
    const re = await call(m1, 'POST', `/member/support/tickets/${ids[0]}/reopen`);
    assert.equal(re.body.status, 'OPEN');
    assert.equal((await call(m1, 'POST', `/member/support/tickets/${ids[1]}/reopen`)).status, 409, 'only solved tickets can be reopened');
    await SupportTicket.updateOne({ _id: ids[0] }, { status: 'CLOSED', closedAt: new Date(Date.now() - 20 * 86_400_000) });
    assert.equal((await call(m1, 'POST', `/member/support/tickets/${ids[0]}/reopen`)).status, 409, 'too old to reopen');
    assert.equal((await call(m1, 'GET', '/member/support/tickets?view=closed')).body.total, 1);
  });

  it('numbers tickets uniquely even when raised at the same time, and the franchise badge counts waiting replies', async () => {
    const users = await Promise.all(Array.from({ length: 4 }, (_, i) => mkUser('MEMBER', `bulk${i}`)));
    const res = await Promise.all(users.map((u) => call(u, 'POST', '/member/support/tickets', ticket())));
    assert.equal(new Set(res.map((r) => r.body.number)).size, 4);
    const t = await call(shop, 'POST', '/franchise/support/tickets', ticket({ category: 'RECHARGE', subject: 'Recharge not credited' }));
    await call(admin, 'POST', `/admin/support/tickets/${t.body.id}/reply`, { message: 'Please share the UTR number.' });
    assert.equal((await call(shop, 'GET', '/franchise/overview')).body.counts.supportNeedsReply, 1);
  });
});
