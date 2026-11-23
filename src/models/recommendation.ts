import { Schema } from 'mongoose';

/**
 * A franchise's recommendation on something that moves money (top-up, withdrawal, order payment).
 * It never moves money itself: the head office (admin) makes the final approval.
 */
export const recommendationSchema = new Schema(
  {
    by: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    franchiseId: { type: Schema.Types.ObjectId, ref: 'Franchise' },
    decision: { type: String, enum: ['APPROVE', 'REJECT'], required: true },
    note: { type: String, maxlength: 300 },
    approvedPaise: Number, // top-ups: the amount the franchise actually saw arrive
    at: { type: Date, default: Date.now },
  },
  { _id: false },
);
