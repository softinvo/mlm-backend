import { Schema, model, Types, InferSchemaType } from 'mongoose';
import { AddressLabels } from './enums';

// Saved delivery addresses for a user (address book). Orders keep their own snapshot copy.
const shippingAddressSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    label: { type: String, enum: AddressLabels, default: 'HOME' },
    fullName: { type: String, required: true, trim: true },
    phone: { type: String, required: true },
    line1: { type: String, required: true, trim: true },
    line2: { type: String, trim: true },
    city: { type: String, required: true, trim: true },
    state: { type: String, required: true, trim: true },
    pincode: { type: String, required: true },
    isDefault: { type: Boolean, default: false },
  },
  { timestamps: true },
);
// At most one default address per user, enforced by the database.
shippingAddressSchema.index({ userId: 1, isDefault: 1 }, { unique: true, partialFilterExpression: { isDefault: true } });

export type IShippingAddress = InferSchemaType<typeof shippingAddressSchema> & { _id: Types.ObjectId };
export const ShippingAddress = model('ShippingAddress', shippingAddressSchema);
