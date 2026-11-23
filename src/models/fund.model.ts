import { Schema, model, Types, InferSchemaType } from 'mongoose';
import { FundRequestStatuses, PaymentModes } from './enums';
import { recommendationSchema } from './recommendation';

// A member says "I paid the company this amount, here is the bank reference". The head office checks the
// bank statement and, if it matches, credits the member's SHOPPING wallet (never the withdrawable one).
const fundRequestSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    franchiseId: { type: Schema.Types.ObjectId, ref: 'Franchise', index: true }, // the member's franchise, for scoping
    recommendation: recommendationSchema,
    amountPaise: { type: Number, required: true, min: 1 },          // what the member says they paid
    approvedPaise: Number,                                            // what was actually credited (can be less)
    mode: { type: String, enum: PaymentModes, required: true },
    reference: { type: String, required: true, trim: true },         // UTR / transaction id as entered
    refKey: { type: String, required: true },                         // normalised reference, for duplicate detection
    paidOn: { type: Date, required: true },
    note: { type: String, maxlength: 200 },
    status: { type: String, enum: FundRequestStatuses, default: 'PENDING' },
    // True while the reference is "in use" (pending or approved). A rejected/cancelled one frees it for resubmission.
    holdsRef: { type: Boolean, default: true },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: Date,
    reviewNote: String,
  },
  { timestamps: true },
);
fundRequestSchema.index({ refKey: 1 }, { unique: true, partialFilterExpression: { holdsRef: true } });
fundRequestSchema.index({ status: 1, createdAt: 1 });

export type IFundRequest = InferSchemaType<typeof fundRequestSchema> & { _id: Types.ObjectId };
export const FundRequest = model('FundRequest', fundRequestSchema);
