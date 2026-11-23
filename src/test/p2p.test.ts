import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Franchise, Member, P2PTransfer, User, Wallet, WalletEntry, Zone } from '../models';
import { reconcileWallet } from '../services/commission.service';
import { postEntry } from '../services/ledger.service';
import { listP2P, lookupRecipient, maskName, sendP2P } from '../services/p2p.service';
import { withTx } from '../utils/tx';

let rs: MongoMemoryReplSet;
before(async () => {
  process.env.P2P_DAILY_LIMIT_PAISE = '100000'; // ₹1,000 for tests
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(rs.getUri());
  await Promise.all(mongoose.modelNames().map((n) => mongoose.model(n).init()));
});
after(async () => { await mongoose.disconnect(); await rs.stop(); });

let a: string, b: string, c: string;
const fund = (userId: string, amount: number) => withTx((s) => postEntry(s, { userId, wallet: 'SHOPPING', amountPaise: amount, type: 'ADJUSTMENT', key: `f:${Math.random()}` }));
const bal = async (userId: string, w: 'INCOME' | 'SHOPPING' = 'SHOPPING') => (await Wallet.findOne({ userId, type: w }))?.balancePaise ?? 0;

beforeEach(async () => {
  await Promise.all(mongoose.modelNames().map((n) => mongoose.model(n).deleteMany({})));
  const zone = await Zone.create({ name: 'Z', states: [] });
  const o = await User.create({ role: 'REMOTE_FRANCHISE', status: 'ACTIVE', name: 'o', email: 'o@t.com', phone: '9000000099', passwordHash: 'x' });
  const fr = await Franchise.create({ type: 'ZONAL', code: 'Z1', name: 'F', zoneId: zone._id, ownerUserId: o._id, address: 'x', commissionPercent: 0 });
  const mk = async (name: string, code: string, status = 'ACTIVE') => {
    const u = await User.create({ role: 'MEMBER', status, name, email: `${code}@t.com`, phone: String(9100000000 + Math.floor(Math.random() * 9999999)), passwordHash: 'x' });
    await Member.create({ userId: u._id, memberCode: code, franchiseId: fr._id, upline: [] });
    return u._id.toString();
  };
  a = await mk('Asha Verma', 'MA'); b = await mk('Bilal Khan', 'MB'); c = await mk('Chitra Rao', 'MC', 'SUSPENDED');
});

describe('lookup', () => {
  it('masks the name and rejects yourself, unknown and non-active members', async () => {
    assert.deepEqual(await lookupRecipient(a, 'mb'), { memberCode: 'MB', name: 'Bilal K.' });
    assert.equal(maskName('Madonna'), 'Madonna');
    await assert.rejects(lookupRecipient(a, 'MA'), /yourself/);
    await assert.rejects(lookupRecipient(a, 'NOPE'), /No active member/);
    await assert.rejects(lookupRecipient(a, 'MC'), /No active member/, 'suspended members cannot receive');
  });
});

describe('sending', () => {
  it('moves shopping credit between members atomically and records both ledger entries', async () => {
    await fund(a, 50000);
    const t = await sendP2P(a, { toMemberCode: 'MB', amountPaise: 20000, note: 'for you' });
    assert.equal(t.direction, 'SENT');
    assert.equal(await bal(a), 30000);
    assert.equal(await bal(b), 20000);
    const out = await WalletEntry.findOne({ type: 'P2P_OUT' }), inn = await WalletEntry.findOne({ type: 'P2P_IN' });
    assert.equal(out!.balanceAfterPaise, 30000);
    assert.equal(inn!.balanceAfterPaise, 20000);
    assert.match(out!.note!, /Bilal K\. \(MB\)/);
    assert.match(inn!.note!, /Asha V\./);
    assert.ok((await reconcileWallet(a, 'SHOPPING'))!.ok && (await reconcileWallet(b, 'SHOPPING'))!.ok);
  });

  it('never touches the income (withdrawable) wallet', async () => {
    await withTx((s) => postEntry(s, { userId: a, wallet: 'INCOME', amountPaise: 90000, type: 'ADJUSTMENT', key: 'inc' }));
    await assert.rejects(sendP2P(a, { toMemberCode: 'MB', amountPaise: 10000 }), /Insufficient/);
    assert.equal(await bal(a, 'INCOME'), 90000);
    assert.equal(await bal(b, 'INCOME'), 0);
  });

  it('validates amount, recipient and balance, and a failure leaves nothing behind', async () => {
    await fund(a, 5000);
    await assert.rejects(sendP2P(a, { toMemberCode: 'MB', amountPaise: 50 }), /Minimum/);
    await assert.rejects(sendP2P(a, { toMemberCode: 'MB', amountPaise: 9000 }), /Insufficient/);
    await assert.rejects(sendP2P(a, { toMemberCode: 'MA', amountPaise: 1000 }), /yourself/);
    await assert.rejects(sendP2P(a, { toMemberCode: 'MC', amountPaise: 1000 }), /No active member/);
    assert.equal(await bal(a), 5000);
    assert.equal(await P2PTransfer.countDocuments({}), 0);
    assert.equal(await WalletEntry.countDocuments({ type: { $in: ['P2P_OUT', 'P2P_IN'] } }), 0);
  });

  it('enforces the rolling daily limit', async () => {
    await fund(a, 500000);
    await sendP2P(a, { toMemberCode: 'MB', amountPaise: 70000 });
    await assert.rejects(sendP2P(a, { toMemberCode: 'MB', amountPaise: 40000 }), /daily limit/);
    assert.equal(await bal(a), 500000 - 70000, 'the rejected transfer was rolled back');
    await assert.rejects(sendP2P(a, { toMemberCode: 'MB', amountPaise: 100001 }), /daily transfer limit/);
    await sendP2P(a, { toMemberCode: 'MB', amountPaise: 30000 });
    assert.equal(await bal(b), 100000);
  });

  it('cannot exceed the daily limit or the balance with simultaneous sends', async () => {
    await fund(a, 500000);
    const res = await Promise.allSettled(Array.from({ length: 8 }, () => sendP2P(a, { toMemberCode: 'MB', amountPaise: 30000 })));
    const ok = res.filter((r) => r.status === 'fulfilled').length;
    assert.equal(ok, 3, 'only three ₹300 sends fit in ₹1,000');
    assert.equal(await bal(b), 90000);
    assert.equal(await bal(a), 410000);
    assert.ok((await reconcileWallet(a, 'SHOPPING'))!.ok);
  });

  it('is retry-safe with a clientKey', async () => {
    await fund(a, 50000);
    const rs = await Promise.all(Array.from({ length: 4 }, () => sendP2P(a, { toMemberCode: 'MB', amountPaise: 10000, clientKey: 'same-key-12345' })));
    assert.equal(new Set(rs.map((r) => r.id)).size, 1);
    assert.equal(await bal(b), 10000);
    assert.equal(await P2PTransfer.countDocuments({}), 1);
  });

  it('lists sent and received transfers with masked counterparties and today’s total', async () => {
    await fund(a, 50000); await fund(b, 50000);
    await sendP2P(a, { toMemberCode: 'MB', amountPaise: 10000 });
    await sendP2P(b, { toMemberCode: 'MA', amountPaise: 5000 });
    const all = await listP2P(a, { direction: 'all', page: 1, limit: 10 });
    assert.deepEqual(all.items.map((i) => [i.direction, i.counterparty, i.amountPaise]), [['RECEIVED', 'Bilal K.', 5000], ['SENT', 'Bilal K.', 10000]]);
    assert.equal(all.sentTodayPaise, 10000);
    assert.equal((await listP2P(a, { direction: 'sent', page: 1, limit: 10 })).total, 1);
    assert.equal((await listP2P(a, { direction: 'received', page: 1, limit: 10 })).total, 1);
    assert.equal((await listP2P(c, { direction: 'all', page: 1, limit: 10 })).total, 0);
  });
});
