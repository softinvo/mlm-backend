import { Schema, model, Types, InferSchemaType } from 'mongoose';
import { FranchiseTypes } from './enums';

const zoneSchema = new Schema(
  { name: { type: String, required: true, unique: true }, states: [String] },
  { timestamps: true },
);
export const Zone = model('Zone', zoneSchema);

// SUPER_ADMIN (HQ) -> any franchise -> franchises on lower plans (Premium > Standard > Mini); parentId is null for top-level franchises
const franchiseSchema = new Schema(
  {
    type: { type: String, enum: FranchiseTypes, required: true },
    code: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    zoneId: { type: Schema.Types.ObjectId, ref: 'Zone', required: true, index: true },
    parentId: { type: Schema.Types.ObjectId, ref: 'Franchise', default: null, index: true }, // the franchise that manages this one; null = managed directly by the head office
    ownerUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    staffUserIds: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    active: { type: Boolean, default: true },
    walletSalesSeq: { type: Number, default: 0 }, // bumped on each wallet sale so concurrent approvals queue up for the daily limit
    address: { type: String, required: true },
    gstin: String,
    tierId: { type: Schema.Types.ObjectId, ref: 'FranchiseTier' }, // franchise type: sets its discount and limits
    prepaidBalancePaise: { type: Number, default: 0 },              // funds available for sales (see FranchiseLedgerEntry)
  },
  { timestamps: true },
);

// `type` is derived: a franchise with no parent is ZONAL (top level), one with a parent is REMOTE. Who may manage whom is decided by plan level (see hierarchy.service).

export type IFranchise = InferSchemaType<typeof franchiseSchema> & { _id: Types.ObjectId };
export const Franchise = model('Franchise', franchiseSchema);
