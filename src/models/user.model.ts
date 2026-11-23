import { Schema, model, Types, InferSchemaType } from 'mongoose';
import { Roles, UserStatuses, KycStatuses } from './enums';

// All money in this codebase is integer paise.
const kycSchema = new Schema(
  {
    accountHolder: { type: String, required: true },
    bankAccountEnc: { type: String, required: true }, // AES-256-GCM, only decrypted for payouts
    accountLast4: { type: String, required: true },
    ifsc: { type: String, required: true },
    panHash: { type: String, required: true },       // salted hash, never stored raw
    panMasked: { type: String, required: true },     // e.g. ABCDE••••F
    status: { type: String, enum: KycStatuses, default: 'PENDING' },
    note: String,
    submittedAt: Date,
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: Date,
  },
  { _id: false },
);

const addressSchema = new Schema(
  { line1: String, line2: String, city: String, state: String, pincode: String },
  { _id: false },
);

const userSchema = new Schema(
  {
    role: { type: String, enum: Roles, required: true, index: true },
    status: { type: String, enum: UserStatuses, default: 'PENDING' },
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true }, // one email per account
    phone: { type: String, required: true, unique: true },                  // one mobile per account
    passwordHash: { type: String, required: true, select: false },
    dateOfBirth: Date,
    gender: { type: String, enum: ["MALE", "FEMALE", "OTHER"] },
    address: addressSchema,
    otpChannel: { type: String, enum: ['SMS', 'EMAIL'], default: 'SMS' }, // where this person wants their one-time codes
    kyc: kycSchema,
  },
  { timestamps: true },
);

export type IUser = InferSchemaType<typeof userSchema> & { _id: Types.ObjectId };
export const User = model('User', userSchema);
