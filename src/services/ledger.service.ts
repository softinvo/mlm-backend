import { ClientSession, Types } from 'mongoose';
import { Wallet, WalletEntry, WalletEntryType, WalletType } from '../models';
import { HttpError } from '../utils/http';

export interface PostEntry {
  userId: Types.ObjectId | string;
  wallet: WalletType;
  amountPaise: number;           // signed
  type: WalletEntryType;
  refType?: string;
  refId?: Types.ObjectId;
  key: string;                   // idempotency key: the same key can never be posted twice
  note?: string;
  /** For debits the member initiates: fail instead of going below zero. */
  requireFunds?: boolean;
}

/**
 * The ONLY place wallet balances change. Updates the cached balance and appends the ledger entry
 * (with the balance right after it) inside the caller's transaction.
 */
export async function postEntry(session: ClientSession, e: PostEntry) {
  const strictDebit = !!e.requireFunds && e.amountPaise < 0;
  const filter: Record<string, unknown> = { userId: e.userId, type: e.wallet };
  if (strictDebit) filter.balancePaise = { $gte: -e.amountPaise };

  const wallet = await Wallet.findOneAndUpdate(filter, { $inc: { balancePaise: e.amountPaise } }, { new: true, session, upsert: !strictDebit });
  if (!wallet) throw new HttpError(400, 'Insufficient wallet balance');

  await WalletEntry.create(
    [{ walletId: wallet._id, type: e.type, amountPaise: e.amountPaise, balanceAfterPaise: wallet.balancePaise, refType: e.refType, refId: e.refId, idempotencyKey: e.key, note: e.note }],
    { session },
  );
  return wallet;
}
