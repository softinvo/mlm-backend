import { Schema, model } from 'mongoose';
import { FundRequestStatuses, PaymentModes } from './enums';

export const PrepaidTypes = ['RECHARGE', 'SUPPLY_COST', 'SUPPLY_PROCEEDS', 'SALE_COST', 'SALE_PROCEEDS', 'COST_RETURNED', 'PROCEEDS_RETURNED', 'ADJUSTMENT'] as const;
export type PrepaidType = (typeof PrepaidTypes)[number];

/**
 * A franchise works from a PREPAID balance with the company. Positive = funds available.
 *   RECHARGE           +  the franchise paid the company and the head office confirmed it
 *   SUPPLY_COST        −  stock the company supplied to the franchise, charged at retail price less its plan discount
 *   SUPPLY_PROCEEDS    +  a franchise supplied stock to a franchise it manages and was paid from that franchise's balance
 *   SALE_COST          −  (legacy) what a sale used to cost at the time of sale
 *   SALE_PROCEEDS      +  money the company collected for a wallet-paid sale, passed to the franchise (full retail price)
 *   COST_RETURNED      +  the cost is given back when a sold order is refunded
 *   PROCEEDS_RETURNED  −  proceeds taken back when a wallet-paid order is refunded
 *   ADJUSTMENT         ±  the head office corrected something (a reason is required)
 * Append-only: the balance on the franchise is the sum of these.
 */
const ledgerSchema = new Schema(
  {
    franchiseId: { type: Schema.Types.ObjectId, ref: 'Franchise', required: true },
    type: { type: String, enum: PrepaidTypes, required: true },
    amountPaise: { type: Number, required: true },
    balanceAfterPaise: { type: Number, required: true },
    refType: String,
    refId: Schema.Types.ObjectId,
    idempotencyKey: String,
    note: String,
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
ledgerSchema.index({ franchiseId: 1, createdAt: -1 });
ledgerSchema.index({ idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } });
export const FranchiseLedgerEntry = model('FranchiseLedgerEntry', ledgerSchema);

// A franchise tells the head office it paid to recharge its balance; the head office confirms against the bank statement.
const rechargeSchema = new Schema(
  {
    franchiseId: { type: Schema.Types.ObjectId, ref: 'Franchise', required: true, index: true },
    requestedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    amountPaise: { type: Number, required: true, min: 1 },
    confirmedPaise: Number,
    mode: { type: String, enum: PaymentModes, required: true },
    reference: { type: String, required: true, trim: true },
    refKey: { type: String, required: true },
    paidOn: { type: Date, required: true },
    note: { type: String, maxlength: 200 },
    status: { type: String, enum: [...FundRequestStatuses.filter((s) => s !== 'APPROVED'), 'CONFIRMED'], default: 'PENDING' },
    holdsRef: { type: Boolean, default: true },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: Date,
    reviewNote: String,
  },
  { timestamps: true },
);
rechargeSchema.index({ refKey: 1 }, { unique: true, partialFilterExpression: { holdsRef: true } });
rechargeSchema.index({ status: 1, createdAt: 1 });
export const FranchiseRecharge = model('FranchiseRecharge', rechargeSchema);
