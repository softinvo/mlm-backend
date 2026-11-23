import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Franchise, Member, Order, Package, User, Wallet, WalletEntry, Withdrawal, Zone } from '../models';
import { postEntry } from '../services/ledger.service';
import { refundOrder, reconcileWallet } from '../services/commission.service';
import { advanceShipment, placeOrder } from '../services/order.service';
import {
  approveWithdrawal, cancelWithdrawal, getWalletSummary, listAdminWithdrawals, listEntries, markWithdrawalPaid, quoteWithdrawal,
  rejectWithdrawal, requestWithdrawal, reviewKyc, submitKyc, transferToShopping, payOrderWithShoppingWallet,
} from '../services/wallet.service';
import { withTx } from '../utils/tx';

let rs: MongoMemoryReplSet;
before(async () => {
  process.env.WITHDRAWAL_MIN_PAISE = '10000';
  process.env.WITHDRAWAL_FEE_PERCENT = '0';
  process.env.WITHDRAWAL_TDS_PERCENT = '0';
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(rs.getUri());
  await Promise.all(mongoose.modelNames().map((n) => mongoose.model(n).init()));
});
after(async () => { await mongoose.disconnect(); await rs.stop(); });

let uid: string;
const kyc = { accountHolder: 'Demo Member', accountNumber: '123456789012', ifsc: 'HDFC0001234', pan: 'ABCDE1234F' };
const fund = (amount: number, wallet: 'INCOME' | 'SHOPPING' = 'INCOME') =>
  withTx((s) => postEntry(s, { userId: uid, wallet, amountPaise: amount, type: 'ADJUSTMENT', key: `fund:${Math.random()}` }));
const balance = async (wallet: 'INCOME' | 'SHOPPING' = 'INCOME') => (await Wallet.findOne({ userId: uid, type: wallet }))?.balancePaise ?? 0;

beforeEach(async () => {
  await Promise.all(mongoose.modelNames().map((n) => mongoose.model(n).deleteMany({})));
  const u = await User.create({ role: 'MEMBER', status: 'ACTIVE', name: 'm', email: 'm@t.com', phone: '9000000001', passwordHash: 'x' });
  uid = u._id.toString();
  await Wallet.create({ userId: u._id, type: 'INCOME' });
});
const verify = async () => { await submitKyc(uid, kyc); await reviewKyc(uid, 'VERIFIED', undefined, uid); };

describe('withdrawals', () => {
  it('requires a verified payout account, the minimum amount and enough balance', async () => {
    await fund(50000);
    await assert.rejects(requestWithdrawal(uid, 20000), /payout account must be verified/);
    await submitKyc(uid, kyc);
    await assert.rejects(requestWithdrawal(uid, 20000), /must be verified/, 'PENDING is not enough');
    await reviewKyc(uid, 'VERIFIED', undefined, uid);
    await assert.rejects(requestWithdrawal(uid, 9999), /Minimum withdrawal/);
    await assert.rejects(requestWithdrawal(uid, 50001), /Insufficient/);
    assert.equal(await balance(), 50000, 'failed attempts do not move money');
  });

  it('debits immediately and records the ledger entry with the running balance', async () => {
    await verify(); await fund(50000);
    const w = await requestWithdrawal(uid, 30000);
    assert.equal(w.status, 'REQUESTED');
    assert.equal(await balance(), 20000);
    const e = await WalletEntry.findOne({ type: 'WITHDRAWAL_DEBIT' });
    assert.equal(e!.amountPaise, -30000);
    assert.equal(e!.balanceAfterPaise, 20000);
    assert.ok((await reconcileWallet(uid))!.ok);
  });

  it('applies fee and TDS from configuration', async () => {
    process.env.WITHDRAWAL_FEE_PERCENT = '2'; process.env.WITHDRAWAL_TDS_PERCENT = '5';
    try {
      assert.deepEqual(quoteWithdrawal(100000), { amountPaise: 100000, feePaise: 2000, tdsPaise: 5000, netPaise: 93000 });
      await verify(); await fund(100000);
      const w = await requestWithdrawal(uid, 100000);
      assert.equal(w.netPaise, 93000);
      assert.equal(await balance(), 0, 'the full amount leaves the wallet; deductions come out of it');
    } finally { process.env.WITHDRAWAL_FEE_PERCENT = '0'; process.env.WITHDRAWAL_TDS_PERCENT = '0'; }
  });

  it('can never overdraw, even with simultaneous requests', async () => {
    await verify(); await fund(50000);
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => requestWithdrawal(uid, 20000)));
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    assert.equal(ok, 2, 'only two 200 requests fit in 500');
    assert.equal(await balance(), 10000);
    assert.equal(await Withdrawal.countDocuments({}), 2);
    assert.ok((await reconcileWallet(uid))!.ok);
  });

  it('cancelling a waiting request returns the money once', async () => {
    await verify(); await fund(50000);
    const w = await requestWithdrawal(uid, 30000);
    await cancelWithdrawal(uid, w._id.toString());
    assert.equal(await balance(), 50000);
    await assert.rejects(cancelWithdrawal(uid, w._id.toString()), /still waiting/);
    assert.equal(await balance(), 50000);
    assert.equal(await WalletEntry.countDocuments({ type: 'WITHDRAWAL_REFUND' }), 1);
  });

  it('follows requested -> approved -> paid, and rejecting refunds', async () => {
    await verify(); await fund(80000);
    const a = await requestWithdrawal(uid, 30000);
    await assert.rejects(markWithdrawalPaid(a._id.toString(), 'UTR1234'), /Only approved/);
    await approveWithdrawal(a._id.toString());
    await assert.rejects(cancelWithdrawal(uid, a._id.toString()), /still waiting/, 'members cannot cancel once approved');
    const paid = await markWithdrawalPaid(a._id.toString(), 'UTR1234');
    assert.equal(paid.status, 'PAID');
    assert.equal(await balance(), 50000);

    const b = await requestWithdrawal(uid, 20000);
    await approveWithdrawal(b._id.toString());
    await rejectWithdrawal(b._id.toString(), 'Bank details mismatch');
    assert.equal(await balance(), 50000, 'rejection returns the money');
    await assert.rejects(rejectWithdrawal(b._id.toString(), 'again'), /no longer/);
    assert.equal(await balance(), 50000);

    const s = await getWalletSummary(uid);
    assert.equal(s.withdrawnPaise, 30000);
    assert.equal(s.inProcessPaise, 0);
    assert.ok((await reconcileWallet(uid))!.ok);
  });

  it('changing payout details forces re-verification; admin sees the decrypted account, members never do', async () => {
    await verify(); await fund(50000);
    const w = await requestWithdrawal(uid, 20000);
    await submitKyc(uid, { ...kyc, accountNumber: '999999999999' });
    assert.equal((await getWalletSummary(uid)).kyc.status, 'PENDING');
    await assert.rejects(requestWithdrawal(uid, 20000), /must be verified/);
    const list = await listAdminWithdrawals({ page: 1, limit: 10 });
    assert.equal(list.items[0].bank!.accountNumber, '123456789012', 'payout goes to the account that was verified at request time');
    const summary = JSON.stringify(await getWalletSummary(uid));
    assert.ok(!summary.includes('999999999999') && !summary.includes('1234567890'), 'full numbers are never returned to members');
    assert.ok((await User.findById(uid).select('+kyc'))!.kyc!.bankAccountEnc.split(':').length === 3, 'stored encrypted');
    assert.ok(w);
  });
});

describe('transfers and shopping wallet', () => {
  it('moves income to the shopping wallet atomically', async () => {
    await fund(50000);
    const r = await transferToShopping(uid, 20000);
    assert.deepEqual(r, { incomeBalancePaise: 30000, shoppingBalancePaise: 20000 });
    await assert.rejects(transferToShopping(uid, 40000), /Insufficient/);
    await assert.rejects(transferToShopping(uid, 50), /Minimum/);
    assert.equal(await balance('INCOME'), 30000);
    assert.equal(await balance('SHOPPING'), 20000);
    assert.ok((await reconcileWallet(uid, 'INCOME'))!.ok && (await reconcileWallet(uid, 'SHOPPING'))!.ok);
  });

  it('is safe under simultaneous transfers', async () => {
    await fund(50000);
    const res = await Promise.allSettled(Array.from({ length: 8 }, () => transferToShopping(uid, 20000)));
    assert.equal(res.filter((r) => r.status === 'fulfilled').length, 2);
    assert.equal(await balance('INCOME'), 10000);
    assert.equal(await balance('SHOPPING'), 40000);
  });

  it('pays an order from the shopping wallet and refunds back to it', async () => {
    const zone = await Zone.create({ name: 'Z', states: [] });
    const owner = await User.create({ role: 'REMOTE_FRANCHISE', status: 'ACTIVE', name: 'o', email: 'o@t.com', phone: '9000000002', passwordHash: 'x' });
    const fr = await Franchise.create({ type: 'ZONAL', code: 'Z1', name: 'F', zoneId: zone._id, ownerUserId: owner._id, address: 'x', commissionPercent: 0 });
    const pkg = await Package.create({ name: 'A', pricePaise: 55000 });
    await Member.create({ userId: uid, memberCode: 'M1', franchiseId: fr._id, upline: [] });

    const o = await placeOrder({ buyerUserId: uid, franchiseId: fr._id, items: [{ packageId: String(pkg._id), quantity: 1 }] });
    await assert.rejects(payOrderWithShoppingWallet(String(o._id), uid), /Insufficient/);
    assert.equal((await Order.findById(o._id))!.status, 'PLACED', 'failed payment leaves the order unpaid');

    await fund(60000, 'SHOPPING');
    const paid = await payOrderWithShoppingWallet(String(o._id), uid);
    assert.equal(paid.status, 'PAID');
    assert.equal(await balance('SHOPPING'), 5000);
    await assert.rejects(payOrderWithShoppingWallet(String(o._id), uid), /not found or already paid/);
    assert.equal(await balance('SHOPPING'), 5000, 'cannot be charged twice');

    await refundOrder(String(o._id), 25000, 'partial return');
    assert.equal(await balance('SHOPPING'), 30000, 'refund lands in the shopping wallet');
    assert.ok((await reconcileWallet(uid, 'SHOPPING'))!.ok);
    void advanceShipment;
  });
});

describe('passbook', () => {
  it('lists entries newest first with running balance, filterable by type', async () => {
    await verify(); await fund(50000); await fund(25000);
    await requestWithdrawal(uid, 20000);
    const all = await listEntries(uid, 'INCOME', { page: 1, limit: 10 });
    assert.equal(all.total, 3);
    assert.deepEqual(all.items.map((e) => [e.type, e.amountPaise, e.balanceAfterPaise]), [['WITHDRAWAL_DEBIT', -20000, 55000], ['ADJUSTMENT', 25000, 75000], ['ADJUSTMENT', 50000, 50000]]);
    assert.equal(all.balancePaise, 55000);
    const only = await listEntries(uid, 'INCOME', { entryType: 'WITHDRAWAL_DEBIT', page: 1, limit: 10 });
    assert.equal(only.total, 1);
    const p2 = await listEntries(uid, 'INCOME', { page: 2, limit: 2 });
    assert.equal(p2.items.length, 1);
    assert.equal((await listEntries(uid, 'SHOPPING', { page: 1, limit: 10 })).total, 0);
  });
});
