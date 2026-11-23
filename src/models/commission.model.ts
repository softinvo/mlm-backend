import { Schema, model, Types, InferSchemaType } from 'mongoose';
import { Ranks, CommissionStatuses } from './enums';

// Versioned so historical orders keep the rules they were calculated under.
const commissionPlanSchema = new Schema(
  {
    version: { type: Number, required: true, unique: true },
    effectiveFrom: { type: Date, required: true },
    active: { type: Boolean, default: false },
    // Hard cap: total member + franchise payout per order, as % of commissionable volume.
    maxPayoutPercentOfVolume: { type: Number, required: true, min: 0, max: 100 },
    levels: [
      {
        _id: false,
        level: { type: Number, required: true, min: 1 }, // 1 = direct sponsor
        percent: { type: Number, required: true, min: 0, max: 100 },
        minRank: { type: String, enum: Ranks, default: 'ASSOCIATE' },
      },
    ],
    // Repurchase royalty: its own level table, paid on product (non-package) purchases. When it is empty,
    // `levels` applies to every purchase as before; when it is set, `levels` covers joining packages only.
    repurchaseLevels: [
      {
        _id: false,
        level: { type: Number, required: true, min: 1 },
        percent: { type: Number, required: true, min: 0, max: 100 },
        minRank: { type: String, enum: Ranks, default: 'ASSOCIATE' },
      },
    ],
  },
  { timestamps: true },
);
export const CommissionPlan = model('CommissionPlan', commissionPlanSchema);

const commissionSchema = new Schema(
  {
    orderId: { type: Schema.Types.ObjectId, ref: 'Order', required: true },
    earnerId: { type: Schema.Types.ObjectId, ref: 'Member', required: true },
    planId: { type: Schema.Types.ObjectId, ref: 'CommissionPlan', required: true },
    level: { type: Number, required: true },
    kind: { type: String, enum: ['JOINING', 'REPURCHASE'], default: 'JOINING' }, // joining-package income vs repurchase royalty
    amountPaise: { type: Number, required: true },
    reversedPaise: { type: Number, default: 0 }, // clawed back by refunds; effective = amountPaise - reversedPaise
    status: { type: String, enum: CommissionStatuses, default: 'PENDING' },
    approvedAt: Date,
    reversedAt: Date,
  },
  { timestamps: true },
);
commissionSchema.index({ orderId: 1, earnerId: 1, level: 1, kind: 1 }, { unique: true }); // idempotent calc
commissionSchema.index({ earnerId: 1, status: 1 });
export type ICommission = InferSchemaType<typeof commissionSchema> & { _id: Types.ObjectId };
export const Commission = model('Commission', commissionSchema);

const franchiseEarningSchema = new Schema(
  {
    franchiseId: { type: Schema.Types.ObjectId, ref: 'Franchise', required: true },
    orderId: { type: Schema.Types.ObjectId, ref: 'Order', required: true },
    amountPaise: { type: Number, required: true },
    reversedPaise: { type: Number, default: 0 },
    status: { type: String, enum: CommissionStatuses, default: 'PENDING' },
    approvedAt: Date,
    reversedAt: Date,
  },
  { timestamps: true },
);
franchiseEarningSchema.index({ franchiseId: 1, orderId: 1 }, { unique: true });
export const FranchiseEarning = model('FranchiseEarning', franchiseEarningSchema);
