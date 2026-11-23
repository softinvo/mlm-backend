import { Schema, model, Types, InferSchemaType } from 'mongoose';
import { Ranks } from './enums';

const memberSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    memberCode: { type: String, required: true, unique: true },
    sponsorId: { type: Schema.Types.ObjectId, ref: 'Member', default: null, index: true },
    // Materialized upline, nearest first: [sponsor, sponsor's sponsor, ...].
    // Set once at signup (sponsor.upline prefixed by sponsorId); lets us fetch
    // "upline up to N levels" without recursion. Immutable after creation.
    upline: [{ type: Schema.Types.ObjectId, ref: 'Member' }],
    franchiseId: { type: Schema.Types.ObjectId, ref: 'Franchise', required: true, index: true },
    rank: { type: String, enum: Ranks, default: 'ASSOCIATE' },
    joinedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);
memberSchema.index({ upline: 1 }); // "all downline of X"

export type IMember = InferSchemaType<typeof memberSchema> & { _id: Types.ObjectId };
export const Member = model('Member', memberSchema);
