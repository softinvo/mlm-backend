import { Schema, model, Types, InferSchemaType } from 'mongoose';

export const CashbackStatuses = ['ACTIVE', 'COMPLETED', 'CANCELLED'] as const;

/** Head-office settings for purchase cashback (one document). OFF until the head office turns it on. */
const settingsSchema = new Schema(
  {
    key: { type: String, default: 'cashback', unique: true },
    enabled: { type: Boolean, default: false },
    percentPerDay: { type: Number, default: 1, min: 0.01, max: 100 },   // of the eligible purchase value, per day
    maxDays: { type: Number, default: 30, min: 1, max: 365 },           // at most this many daily credits per purchase
    maxTotalPercent: { type: Number, default: 30, min: 0.01, max: 100 }, // and never more than this % of the purchase value in all
    includePackages: { type: Boolean, default: false },                 // joining kits / packages are not eligible unless this is on
  },
  { timestamps: true },
);
export const CashbackSettings = model('CashbackSettings', settingsSchema);

/** One purchase's cashback: a fixed number of equal daily credits, starting the day after delivery. */
const cashbackSchema = new Schema(
  {
    orderId: { type: Schema.Types.ObjectId, ref: 'Order', required: true, unique: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    baseVolumePaise: { type: Number, required: true },   // eligible product value (net of tax) when delivered
    percentPerDay: { type: Number, required: true },     // the rules in force when it was delivered
    dailyPaise: { type: Number, required: true },        // current daily credit (shrinks on a partial refund)
    daysTotal: { type: Number, required: true },
    daysPaid: { type: Number, default: 0 },
    paidPaise: { type: Number, default: 0 },             // net of reversals
    status: { type: String, enum: CashbackStatuses, default: 'ACTIVE' },
    startedAt: { type: Date, required: true },           // delivery time; day N is credited at startedAt + N days
  },
  { timestamps: true },
);
cashbackSchema.index({ status: 1, startedAt: 1 });
export type ICashback = InferSchemaType<typeof cashbackSchema> & { _id: Types.ObjectId };
export const Cashback = model('Cashback', cashbackSchema);
