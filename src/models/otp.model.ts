import { Schema, model, Types, InferSchemaType } from 'mongoose';

export const OtpPurposes = ['PASSWORD_RESET', 'WITHDRAWAL', 'WALLET_SALE'] as const;
export type OtpPurpose = (typeof OtpPurposes)[number];

/** One-time codes. Only a salted hash of the code is stored, never the code itself. */
const otpSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    purpose: { type: String, enum: OtpPurposes, required: true },
    ref: { type: String, default: '' },          // what the code is for (e.g. the payment request id), so a code only works for it
    channel: { type: String, enum: ['SMS', 'EMAIL'], required: true },
    codeHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    attempts: { type: Number, default: 0 },      // wrong tries so far
    usedAt: Date,
  },
  { timestamps: true },
);
otpSchema.index({ userId: 1, purpose: 1, ref: 1, createdAt: -1 });
otpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 86_400 }); // tidy up a day after expiry
export type IOtp = InferSchemaType<typeof otpSchema> & { _id: Types.ObjectId };
export const Otp = model('Otp', otpSchema);
