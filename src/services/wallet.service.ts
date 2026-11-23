import { ClientSession, Types } from 'mongoose';
import { Member, Order, User, Wallet, WalletEntry, WalletType, Withdrawal } from '../models';
import { decrypt, encrypt, hashPan } from '../utils/crypto';
import { HttpError } from '../utils/http';
import { withTx } from '../utils/tx';
import { postEntry } from './ledger.service';
import { applyWalletSale } from './prepaid.service';

export const withdrawalConfig = () => ({
  minPaise: Number(process.env.WITHDRAWAL_MIN_PAISE ?? 10_000),
  feePercent: Number(process.env.WITHDRAWAL_FEE_PERCENT ?? 15),
  tdsPercent: Number(process.env.WITHDRAWAL_TDS_PERCENT ?? 0),
});

/** What a withdrawal of `amountPaise` costs and what the member receives. */
export function quoteWithdrawal(amountPaise: number) {
  const c = withdrawalConfig();
  const fee = Math.round((amountPaise * c.feePercent) / 100);
  const tds = Math.round((amountPaise * c.tdsPercent) / 100);
  return { amountPaise, feePaise: fee, tdsPaise: tds, netPaise: amountPaise - fee - tds };
}

const maskPan = (pan: string) => `${pan.slice(0, 5)}••••${pan.slice(-1)}`;

// ───────── Summary ─────────

export async function getWalletSummary(userId: string) {
  const [user, wallets] = await Promise.all([User.findById(userId), Wallet.find({ userId })]);
  if (!user) throw new HttpError(404, 'User not found');
  const income = wallets.find((w) => w.type === 'INCOME');
  const shopping = wallets.find((w) => w.type === 'SHOPPING');

  const rows: { _id: string; total: number }[] = income
    ? await Withdrawal.aggregate([{ $match: { walletId: income._id } }, { $group: { _id: '$status', total: { $sum: '$amountPaise' } } }])
    : [];
  const sum = (...s: string[]) => rows.filter((r) => s.includes(r._id)).reduce((n, r) => n + r.total, 0);

  const k = user.kyc;
  return {
    incomeBalancePaise: income?.balancePaise ?? 0,
    shoppingBalancePaise: shopping?.balancePaise ?? 0,
    withdrawnPaise: sum('PAID'),
    inProcessPaise: sum('REQUESTED', 'APPROVED'),
    config: withdrawalConfig(),
    kyc: k
      ? { status: k.status, accountHolder: k.accountHolder, accountLast4: k.accountLast4, ifsc: k.ifsc, panMasked: k.panMasked, note: k.note ?? null }
      : { status: 'NOT_SUBMITTED' as const },
  };
}

// ───────── Payout account (KYC) ─────────

export interface KycInput { accountHolder: string; accountNumber: string; ifsc: string; pan: string }

/** Any change goes back to PENDING until the head office verifies it again. */
export async function submitKyc(userId: string, input: KycInput) {
  const user = await User.findById(userId);
  if (!user) throw new HttpError(404, 'User not found');
  user.set('kyc', {
    accountHolder: input.accountHolder, bankAccountEnc: encrypt(input.accountNumber), accountLast4: input.accountNumber.slice(-4),
    ifsc: input.ifsc, panHash: hashPan(input.pan), panMasked: maskPan(input.pan), status: 'PENDING', submittedAt: new Date(),
  });
  await user.save();
}

export async function reviewKyc(userId: string, status: 'VERIFIED' | 'REJECTED', note: string | undefined, adminId: string) {
  const user = await User.findById(userId);
  if (!user?.kyc) throw new HttpError(404, 'No payout details submitted');
  user.kyc.status = status;
  user.kyc.note = note;
  user.kyc.reviewedBy = new Types.ObjectId(adminId);
  user.kyc.reviewedAt = new Date();
  await user.save();
}

// ───────── Withdrawals ─────────

export async function requestWithdrawal(userId: string, amountPaise: number) {
  const user = await User.findById(userId);
  if (!user) throw new HttpError(404, 'User not found');
  if (user.status !== 'ACTIVE') throw new HttpError(403, 'Your account cannot withdraw right now');
  if (user.kyc?.status !== 'VERIFIED') throw new HttpError(400, 'Your payout account must be verified before you can withdraw');
  const cfg = withdrawalConfig();
  if (!Number.isInteger(amountPaise) || amountPaise < cfg.minPaise) throw new HttpError(400, `Minimum withdrawal is ₹${cfg.minPaise / 100}`);
  const member = await Member.findOne({ userId }).select('franchiseId');
  const q = quoteWithdrawal(amountPaise);
  if (q.netPaise <= 0) throw new HttpError(400, 'Amount is too small after deductions');

  return withTx(async (session) => {
    const id = new Types.ObjectId();
    // Debit first (guarded: balance must cover it) so concurrent requests can never overdraw.
    const wallet = await postEntry(session, { userId, wallet: 'INCOME', amountPaise: -amountPaise, type: 'WITHDRAWAL_DEBIT', refType: 'Withdrawal', refId: id, key: `wd:${id}`, note: 'Withdrawal request', requireFunds: true });
    const [w] = await Withdrawal.create([{
      _id: id, walletId: wallet._id, franchiseId: member?.franchiseId, ...q, status: 'REQUESTED',
      bank: { accountHolder: user.kyc!.accountHolder, accountLast4: user.kyc!.accountLast4, ifsc: user.kyc!.ifsc, accountEnc: user.kyc!.bankAccountEnc },
    }], { session });
    return w;
  });
}

async function refundWithdrawal(session: ClientSession, w: InstanceType<typeof Withdrawal>, note: string) {
  const wallet = await Wallet.findById(w.walletId).session(session);
  if (!wallet) throw new HttpError(500, 'Wallet not found');
  await postEntry(session, { userId: wallet.userId, wallet: 'INCOME', amountPaise: w.amountPaise, type: 'WITHDRAWAL_REFUND', refType: 'Withdrawal', refId: w._id, key: `wdrefund:${w._id}`, note });
}

export async function cancelWithdrawal(userId: string, id: string) {
  return withTx(async (session) => {
    const w = await Withdrawal.findOne({ _id: id }).session(session);
    const wallet = w && (await Wallet.findById(w.walletId).session(session));
    if (!w || !wallet || wallet.userId.toString() !== userId) throw new HttpError(404, 'Withdrawal not found');
    const claimed = await Withdrawal.findOneAndUpdate({ _id: id, status: 'REQUESTED' }, { $set: { status: 'CANCELLED', processedAt: new Date() } }, { new: true, session });
    if (!claimed) throw new HttpError(409, 'Only requests that are still waiting can be cancelled');
    await refundWithdrawal(session, claimed, 'Withdrawal cancelled');
    return claimed;
  });
}

// Head-office steps: REQUESTED -> APPROVED -> PAID, or REJECTED (money returns to the wallet).
export async function approveWithdrawal(id: string) {
  const w = await Withdrawal.findOneAndUpdate({ _id: id, status: 'REQUESTED' }, { $set: { status: 'APPROVED' } }, { new: true });
  if (!w) throw new HttpError(409, 'Only requested withdrawals can be approved');
  return w;
}

export async function markWithdrawalPaid(id: string, payoutRef: string) {
  const w = await Withdrawal.findOneAndUpdate({ _id: id, status: 'APPROVED' }, { $set: { status: 'PAID', payoutRef, processedAt: new Date() } }, { new: true });
  if (!w) throw new HttpError(409, 'Only approved withdrawals can be marked paid');
  return w;
}

export async function rejectWithdrawal(id: string, reason: string) {
  return withTx(async (session) => {
    const w = await Withdrawal.findOneAndUpdate({ _id: id, status: { $in: ['REQUESTED', 'APPROVED'] } }, { $set: { status: 'REJECTED', rejectReason: reason, processedAt: new Date() } }, { new: true, session });
    if (!w) throw new HttpError(409, 'This withdrawal can no longer be rejected');
    await refundWithdrawal(session, w, `Withdrawal rejected: ${reason}`);
    return w;
  });
}

export async function listMemberWithdrawals(userId: string, q: { status?: string; page: number; limit: number }) {
  const wallet = await Wallet.findOne({ userId, type: 'INCOME' });
  const filter: Record<string, unknown> = { walletId: wallet?._id ?? new Types.ObjectId() };
  if (q.status) filter.status = q.status;
  const [rows, total] = await Promise.all([
    Withdrawal.find(filter).sort({ createdAt: -1, _id: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(),
    Withdrawal.countDocuments(filter),
  ]);
  return {
    items: rows.map((w) => ({
      id: w._id.toString(), requestedAt: w.createdAt, amountPaise: w.amountPaise, feePaise: w.feePaise, tdsPaise: w.tdsPaise, netPaise: w.netPaise,
      status: w.status, payoutRef: w.payoutRef ?? null, rejectReason: w.rejectReason ?? null, processedAt: w.processedAt ?? null,
      account: w.bank ? `${w.bank.accountHolder} •••• ${w.bank.accountLast4}` : null,
    })),
    total, page: q.page, limit: q.limit, pages: Math.max(1, Math.ceil(total / q.limit)),
  };
}

/** Head-office view: includes the decrypted account number, needed to actually send the money. */
export async function listAdminWithdrawals(q: { status?: string; page: number; limit: number }) {
  const filter: Record<string, unknown> = q.status ? { status: q.status } : {};
  const [rows, total] = await Promise.all([
    Withdrawal.find(filter).sort({ createdAt: 1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(),
    Withdrawal.countDocuments(filter),
  ]);
  const wallets = await Wallet.find({ _id: { $in: rows.map((r) => r.walletId) } }).lean();
  const users = await User.find({ _id: { $in: wallets.map((w) => w.userId) } }).select('name email phone').lean();
  return {
    items: rows.map((w) => {
      const wallet = wallets.find((x) => x._id.equals(w.walletId));
      const u = users.find((x) => wallet && x._id.equals(wallet.userId));
      return {
        id: w._id.toString(), userId: u?._id.toString(), name: u?.name, email: u?.email, phone: u?.phone, requestedAt: w.createdAt,
        amountPaise: w.amountPaise, feePaise: w.feePaise, tdsPaise: w.tdsPaise, netPaise: w.netPaise, status: w.status, payoutRef: w.payoutRef ?? null,
        bank: w.bank ? { accountHolder: w.bank.accountHolder, ifsc: w.bank.ifsc, accountNumber: w.bank.accountEnc ? decrypt(w.bank.accountEnc) : null } : null,
      };
    }),
    total, page: q.page, limit: q.limit, pages: Math.max(1, Math.ceil(total / q.limit)),
  };
}

// ───────── Transfers and shopping wallet ─────────

/** Moves earnings into the shopping wallet. One-way: shopping balance is spendable on products only. */
export async function transferToShopping(userId: string, amountPaise: number) {
  if (!Number.isInteger(amountPaise) || amountPaise < 100) throw new HttpError(400, 'Minimum transfer is ₹1');
  return withTx(async (session) => {
    const tid = new Types.ObjectId();
    const from = await postEntry(session, { userId, wallet: 'INCOME', amountPaise: -amountPaise, type: 'TRANSFER_OUT', refType: 'Transfer', refId: tid, key: `tr:${tid}:out`, note: 'Moved to shopping wallet', requireFunds: true });
    const to = await postEntry(session, { userId, wallet: 'SHOPPING', amountPaise, type: 'TRANSFER_IN', refType: 'Transfer', refId: tid, key: `tr:${tid}:in`, note: 'Moved from income wallet' });
    return { incomeBalancePaise: from.balancePaise, shoppingBalancePaise: to.balancePaise };
  });
}

/** Pays a PLACED order from the shopping wallet, atomically with the debit. */
export async function payOrderWithShoppingWallet(orderId: string, userId: string, now = new Date(), outer?: ClientSession) {
  const run = async (session: ClientSession) => {
    const order = await Order.findOne({ _id: orderId, buyerId: userId, status: 'PLACED' }).session(session);
    if (!order) throw new HttpError(404, 'Order not found or already paid');
    await postEntry(session, { userId, wallet: 'SHOPPING', amountPaise: -order.totalPaise, type: 'SHOPPING_SPEND', refType: 'Order', refId: order._id, key: `spend:${order._id}`, note: `Order #${order._id.toString().slice(-6).toUpperCase()}`, requireFunds: true });
    if (order.soldByFranchise) await applyWalletSale(session, order); // the franchise is charged its discounted cost and credited the proceeds
    order.status = 'PAID';
    order.paidAt = now;
    order.payments.push({ gateway: 'SHOPPING_WALLET', gatewayRef: `wallet-${order._id}`, amountPaise: order.totalPaise, status: 'SUCCESS', createdAt: now });
    await order.save({ session });
    return order;
  };
  return outer ? run(outer) : withTx(run);
}

// ───────── Passbook ─────────

export async function listEntries(userId: string, type: WalletType, q: { entryType?: string; page: number; limit: number }) {
  const wallet = await Wallet.findOne({ userId, type });
  if (!wallet) return { items: [], total: 0, page: q.page, limit: q.limit, pages: 1, balancePaise: 0 };
  const filter: Record<string, unknown> = { walletId: wallet._id };
  if (q.entryType) filter.type = q.entryType;
  const [rows, total] = await Promise.all([
    WalletEntry.find(filter).sort({ createdAt: -1, _id: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(),
    WalletEntry.countDocuments(filter),
  ]);
  return {
    items: rows.map((e) => ({ id: e._id.toString(), type: e.type, amountPaise: e.amountPaise, balanceAfterPaise: e.balanceAfterPaise ?? null, note: e.note ?? null, createdAt: e.createdAt })),
    total, page: q.page, limit: q.limit, pages: Math.max(1, Math.ceil(total / q.limit)), balancePaise: wallet.balancePaise,
  };
}
