import { Schema, model, Types, InferSchemaType } from 'mongoose';
import { OrderStatuses, ShipmentStatuses } from './enums';
import { recommendationSchema } from './recommendation';

const orderItemSchema = new Schema(
  {
    productId: { type: Schema.Types.ObjectId, ref: 'Product' },
    packageId: { type: Schema.Types.ObjectId, ref: 'Package' },
    quantity: { type: Number, required: true, min: 1 },
    unitPricePaise: { type: Number, required: true }, // tax-inclusive
    taxPercent: { type: Number, default: 0 },
    // Net of tax (0 for non-commissionable products). Commission is computed from this at delivery.
    commissionableVolumePaise: { type: Number, default: 0 },
  },
  { _id: false },
);

const refundSchema = new Schema(
  {
    amountPaise: { type: Number, required: true, min: 1 },
    reason: { type: String, required: true },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: true },
);

const paymentSchema = new Schema(
  {
    gateway: { type: String, required: true },
    gatewayRef: { type: String, required: true },
    amountPaise: { type: Number, required: true },
    status: { type: String, required: true },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: true },
);

// Address copied onto the order at purchase time, so later edits to the address book do not rewrite history.
const shippingSnapshotSchema = new Schema(
  { fullName: String, phone: String, line1: String, line2: String, city: String, state: String, pincode: String },
  { _id: false },
);

const shipmentSchema = new Schema(
  {
    status: { type: String, enum: ShipmentStatuses, default: "PENDING" },
    courier: String,
    trackingId: String,
    expectedDelivery: Date,
    events: [{ _id: false, status: { type: String, enum: ShipmentStatuses, required: true }, at: { type: Date, required: true }, note: String }],
  },
  { _id: false },
);

const orderSchema = new Schema(
  {
    buyerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    franchiseId: { type: Schema.Types.ObjectId, ref: 'Franchise', required: true }, // fulfilling franchise
    status: { type: String, enum: OrderStatuses, default: 'PLACED' },
    items: { type: [orderItemSchema], validate: (v: unknown[]) => v.length > 0 },
    subtotalPaise: { type: Number, required: true },
    taxPaise: { type: Number, required: true },
    totalPaise: { type: Number, required: true },
    shippingAddress: shippingSnapshotSchema,
    shipment: shipmentSchema,
    payments: [paymentSchema],
    refunds: [refundSchema],
    paidAt: Date,
    // Franchise sales (prepaid model): the franchise pays the company the retail price less its tier discount.
    stockReturned: Boolean,                   // the stock of a cancelled / fully refunded franchise sale went back to the franchise
    soldByFranchise: Boolean,                 // created by a franchise's New Sale
    franchiseCollected: Boolean,              // the franchise took the money itself (cash/UPI/bank at the counter)
    franchiseDiscountPercent: Number,         // discount applied at the time of sale
    franchiseCostPaise: Number,               // what the franchise paid the company for these goods
    franchiseCostReturnedPaise: { type: Number, default: 0 },
    clientKey: String, // lets a retried checkout return the same order instead of creating a duplicate
    refundedPaise: { type: Number, default: 0 },
    deliveredAt: Date,         // commission eligibility starts here
    coolingOffEndsAt: Date,    // commission held PENDING until this passes
  },
  { timestamps: true },
);
orderSchema.index({ franchiseId: 1, createdAt: -1 });
orderSchema.index({ buyerId: 1, clientKey: 1 }, { unique: true, partialFilterExpression: { clientKey: { $type: 'string' } } });
orderSchema.index({ 'payments.gatewayRef': 1 }, { unique: true, sparse: true });

export type IOrder = InferSchemaType<typeof orderSchema> & { _id: Types.ObjectId };
export const Order = model('Order', orderSchema);
