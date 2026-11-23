import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { FundRequest, User, Wallet, WalletEntry } from '../models';
import { reconcileWallet } from '../services/commission.service';
import {
  approveFundRequest, cancelFundRequest, listMemberFundRequests, normalizeRef, paymentInstructions, rejectFundRequest, submitFundRequest,
} from '../services/fund.service';

let rs: MongoMemoryReplSet;
before(async () => {
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(rs.getUri());
  await Promise.all(mongoose.modelNames().map((n) => mongoose.model(n).init()));
});
after(async () => { await mongoose.disconnect(); await rs.stop(); });

let uid: string, admin: string, other: string;
const today = () => new Date();
const req = (over: Partial<Parameters<typeof submitFundRequest>[1]> = {}) =>
  submitFundRequest(uid, { amountPaise: 100000, mode: 'UPI', reference: 'UTR123456789', paidOn: today(), ...over });
const shopping = async (u = uid) => (await Wallet.findOne({ userId: u, type: 'SHOPPING' }))?.balancePaise ?? 0;

beforeEach(async () => {
  delete process.env.PAYMENT_ACCOUNT_NUMBER; delete process.env.PAYMENT_UPI_ID;
  await Promise.all(mongoose.modelNames().map((n) => mongoose.model(n).deleteMany({})));
  const mk = async (n: string, role: 'MEMBER' | 'SUPER_ADMIN' = 'MEMBER') => {
    const u = await User.create({ role, status: 'ACTIVE', name: n, email: `${n}@t.com`, phone: String(9200000000 + Math.floor(Math.random() * 9999999)), passwordHash: 'x' });
    await Wallet.create({ userId: u._id, type: 'INCOME' });
    return u._id.toString();
  };
  uid = await mk('me'); other = await mk('other'); admin = await mk('admin', 'SUPER_ADMIN');
});

describe('submitting', () => {
  it('creates a pending request and validates amount and date', async () => {
    const r = await req();
    assert.equal(r.status, 'PENDING');
    assert.equal(r.refKey, 'UTR123456789');
    await assert.rejects(req({ reference: 'X1234567', amountPaise: 5000 }), /Minimum top-up/);
    await assert.rejects(req({ reference: 'X1234568', amountPaise: 5_000_001 }), /Maximum/);
    await assert.rejects(req({ reference: 'X1234569', paidOn: new Date(Date.now() + 5 * 86_400_000) }), /future/);
    await assert.rejects(req({ reference: 'X1234560', paidOn: new Date(Date.now() - 45 * 86_400_000) }), /last 30 days/);
    assert.equal(await FundRequest.countDocuments({}), 1);
  });

  it('blocks a reused bank reference (even reformatted, even by another member) until it is freed', async () => {
    const first = await req();
    await assert.rejects(req(), /already been submitted/);
    await assert.rejects(req({ reference: 'utr-1234 56789'.replace(' ', '') }), /already been submitted/, 'case/dash variations are the same reference');
    await assert.rejects(submitFundRequest(other, { amountPaise: 100000, mode: 'UPI', reference: 'UTR123456789', paidOn: today() }), /already been submitted/);
    await rejectFundRequest(String(first._id), admin, 'Not in statement');
    const again = await req(); // freed by the rejection
    assert.equal(again.status, 'PENDING');
    await cancelFundRequest(uid, String(again._id));
    await req();
    assert.equal(normalizeRef(' ab-12/34 cd '), 'AB1234CD');
  });

  it('caps open requests per member', async () => {
    for (let i = 0; i < 3; i++) await req({ reference: `REF00000${i}` });
    await assert.rejects(req({ reference: 'REF000009' }), /already have 3 requests waiting/);
    await submitFundRequest(other, { amountPaise: 100000, mode: 'NEFT', reference: 'OTHERREF01', paidOn: today() });
  });

  it('exposes payment details only when configured', async () => {
    assert.equal(paymentInstructions(), null);
    process.env.PAYMENT_ACCOUNT_NUMBER = '111122223333'; process.env.PAYMENT_IFSC = 'HDFC0000001';
    assert.deepEqual(paymentInstructions(), { accountName: null, accountNumber: '111122223333', ifsc: 'HDFC0000001', bank: null, upiId: null });
  });
});

describe('review', () => {
  it('approval credits the SHOPPING wallet once, never the income wallet', async () => {
    const r = await req();
    const a = await approveFundRequest(String(r._id), admin, { note: 'matched' });
    assert.equal(a.status, 'APPROVED');
    assert.equal(a.approvedPaise, 100000);
    assert.equal(await shopping(), 100000);
    assert.equal((await Wallet.findOne({ userId: uid, type: 'INCOME' }))!.balancePaise, 0, 'deposits are not withdrawable');
    const e = await WalletEntry.findOne({ type: 'DEPOSIT' });
    assert.equal(e!.balanceAfterPaise, 100000);
    assert.match(e!.note!, /UTR123456789/);
    await assert.rejects(approveFundRequest(String(r._id), admin), /already been reviewed/);
    assert.equal(await shopping(), 100000);
    assert.ok((await reconcileWallet(uid, 'SHOPPING'))!.ok);
  });

  it('can approve a smaller amount than requested, never a larger one', async () => {
    const r = await req();
    await assert.rejects(approveFundRequest(String(r._id), admin, { approvedPaise: 100001 }), /between/);
    await assert.rejects(approveFundRequest(String(r._id), admin, { approvedPaise: 0 }), /between/);
    const a = await approveFundRequest(String(r._id), admin, { approvedPaise: 80000, note: 'Only ₹800 received' });
    assert.equal(a.approvedPaise, 80000);
    assert.equal(await shopping(), 80000);
  });

  it('two simultaneous approvals credit exactly once', async () => {
    const r = await req();
    const res = await Promise.allSettled([approveFundRequest(String(r._id), admin), approveFundRequest(String(r._id), admin), approveFundRequest(String(r._id), admin)]);
    assert.equal(res.filter((x) => x.status === 'fulfilled').length, 1);
    assert.equal(await shopping(), 100000);
    assert.equal(await WalletEntry.countDocuments({ type: 'DEPOSIT' }), 1);
  });

  it('rejected and cancelled requests credit nothing and cannot be approved afterwards', async () => {
    const a = await req(), b = await req({ reference: 'SECONDREF1' });
    await rejectFundRequest(String(a._id), admin, 'Payment not found');
    await cancelFundRequest(uid, String(b._id));
    await assert.rejects(approveFundRequest(String(a._id), admin), /already been reviewed/);
    await assert.rejects(approveFundRequest(String(b._id), admin), /already been reviewed/);
    await assert.rejects(rejectFundRequest(String(a._id), admin, 'again'), /already been reviewed/);
    assert.equal(await shopping(), 0);
  });

  it('a member can cancel only their own pending request', async () => {
    const r = await req();
    await assert.rejects(cancelFundRequest(other, String(r._id)), /not found/i);
    await approveFundRequest(String(r._id), admin);
    await assert.rejects(cancelFundRequest(uid, String(r._id)), /still waiting/);
  });
});

describe('listing', () => {
  it('summarises credited and pending amounts and filters by status', async () => {
    const a = await req(), b = await req({ reference: 'REFB00001', amountPaise: 50000 });
    await req({ reference: 'REFC00001', amountPaise: 20000 });
    await approveFundRequest(String(a._id), admin, { approvedPaise: 90000 });
    await rejectFundRequest(String(b._id), admin, 'no match');
    const all = await listMemberFundRequests(uid, { page: 1, limit: 10 });
    assert.equal(all.total, 3);
    assert.deepEqual(all.summary, { creditedPaise: 90000, pendingPaise: 20000, pendingCount: 1 });
    assert.equal((await listMemberFundRequests(uid, { status: 'REJECTED', page: 1, limit: 10 })).items[0].reviewNote, 'no match');
    assert.equal((await listMemberFundRequests(other, { page: 1, limit: 10 })).total, 0, 'members only see their own');
  });
});
