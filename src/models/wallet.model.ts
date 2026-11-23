import { Schema, model } from 'mongoose';
import { WalletEntryTypes, WalletTypes, WithdrawalStatuses } from './enums';
import { recommendationSchema } from './recommendation';

const walletSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    // INCOME = commissions (withdrawable). SHOPPING = spendable on products only.
    type: { type: String, enum: WalletTypes, default: 'INCOME' },
    // Cached running balance. Source of truth is SUM(WalletEntry.amountPaise);
    // update both inside one Mongo transaction.
    balancePaise: { type: Number, default: 0 },
  },
  { timestamps: true },
);
walletSchema.index({ userId: 1, type: 1 }, { unique: true });
export const Wallet = model('Wallet', walletSchema);

// Append-only ledger: never update or delete.
const walletEntrySchema = new Schema(
  {
    walletId: { type: Schema.Types.ObjectId, ref: 'Wallet', required: true },
    type: { type: String, enum: WalletEntryTypes, required: true },
    amountPaise: { type: Number, required: true }, // signed
    balanceAfterPaise: Number,                      // wallet balance right after this entry (passbook)
    refType: String,
    refId: Schema.Types.ObjectId,
    // Guards against double credits/debits when a job is retried. Unique when present.
    idempotencyKey: String,
    note: String,
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
walletEntrySchema.index({ walletId: 1, createdAt: -1 });
walletEntrySchema.index({ idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } });
export const WalletEntry = model('WalletEntry', walletEntrySchema);

const withdrawalSchema = new Schema(
  {
    walletId: { type: Schema.Types.ObjectId, ref: 'Wallet', required: true, index: true },
    franchiseId: { type: Schema.Types.ObjectId, ref: 'Franchise', index: true }, // the member's franchise, for scoping
    recommendation: recommendationSchema,
    amountPaise: { type: Number, required: true, min: 1 },
    tdsPaise: { type: Number, default: 0 },
    feePaise: { type: Number, default: 0 },
    netPaise: { type: Number, required: true },
    status: { type: String, enum: WithdrawalStatuses, default: 'REQUESTED' },
    // Snapshot of the payout account at request time (the full number stays encrypted on the user).
    bank: { _id: false, accountHolder: String, accountLast4: String, ifsc: String, accountEnc: String },
    payoutRef: String,
    rejectReason: String,
    processedAt: Date,
  },
  { timestamps: true },
);
export const Withdrawal = model('Withdrawal', withdrawalSchema);

// Member-to-member transfers of shopping-wallet credit. The ledger entries are the money record;
// this collection is the human-readable history and enforces retry-safety per sender.
const p2pSchema = new Schema(
  {
    fromUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    toUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    amountPaise: { type: Number, required: true, min: 1 },
    note: { type: String, maxlength: 80 },
    clientKey: String,
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
p2pSchema.index({ fromUserId: 1, createdAt: -1 });
p2pSchema.index({ toUserId: 1, createdAt: -1 });
p2pSchema.index({ fromUserId: 1, clientKey: 1 }, { unique: true, partialFilterExpression: { clientKey: { $type: 'string' } } });
export const P2PTransfer = model('P2PTransfer', p2pSchema);
