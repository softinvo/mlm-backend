import { Schema, model, Types, InferSchemaType } from 'mongoose';

// Franchise types (by size), defined by the admin. Franchises are PREPAID: the tier's discount is what they save on every sale
// (e.g. 3% / 5% / 8%), and its limits say how much a franchise may handle.
const tierSchema = new Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    description: { type: String, default: '' },
    discountPercent: { type: Number, required: true, min: 0, max: 50 },    // discount off the retail price the franchise pays the company
    rank: { type: Number, default: 1, min: 1, max: 9 },                    // plan level: a franchise can manage franchises on a LOWER level only (Mini 1, Standard 2, Premium 3)
    investmentPaise: { type: Number, default: 0, min: 0 },                 // the stock investment this plan stands for: prepaid funds the company supplies joining/repurchase products against
    maxMembers: { type: Number, default: 0, min: 0 },                      // members it may onboard; 0 = no limit
    dailyWalletSalesLimitPaise: { type: Number, default: 0, min: 0 },      // wallet-paid sales per rolling 24h; 0 = no limit
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);
export type ITier = InferSchemaType<typeof tierSchema> & { _id: Types.ObjectId };
export const FranchiseTier = model('FranchiseTier', tierSchema);

// A franchise asks a member to pay for an order from their shopping wallet. Nothing moves until the MEMBER approves.
const paymentRequestSchema = new Schema(
  {
    orderId: { type: Schema.Types.ObjectId, ref: 'Order', required: true, index: true },
    memberUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    franchiseId: { type: Schema.Types.ObjectId, ref: 'Franchise', required: true },
    requestedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    amountPaise: { type: Number, required: true, min: 1 },
    status: { type: String, enum: ['PENDING', 'APPROVED', 'DECLINED', 'EXPIRED', 'CANCELLED'], default: 'PENDING' },
    expiresAt: { type: Date, required: true },
    decidedAt: Date,
  },
  { timestamps: true },
);
paymentRequestSchema.index({ memberUserId: 1, status: 1, createdAt: -1 });
paymentRequestSchema.index({ franchiseId: 1, status: 1, decidedAt: -1 });
export type IPaymentRequest = InferSchemaType<typeof paymentRequestSchema> & { _id: Types.ObjectId };
export const WalletPaymentRequest = model('WalletPaymentRequest', paymentRequestSchema);
