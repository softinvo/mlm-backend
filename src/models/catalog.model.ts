import { Schema, model, Types, InferSchemaType } from 'mongoose';

const productSchema = new Schema(
  {
    sku: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    description: { type: String, required: true },
    imageUrl: { type: String, default: '' },
    mrpPaise: { type: Number, required: true, min: 0 },
    taxPercent: { type: Number, required: true, min: 0 },
    commissionable: { type: Boolean, default: true },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);
export type IProduct = InferSchemaType<typeof productSchema> & { _id: Types.ObjectId };
export const Product = model('Product', productSchema);

// A bundle of products sold at one price (e.g. "Package A" 55000 paise once confirmed).
const packageSchema = new Schema(
  {
    name: { type: String, required: true, unique: true },
    description: { type: String, default: '' },
    imageUrl: { type: String, default: '' },
    pricePaise: { type: Number, required: true, min: 0 }, // tax-inclusive selling price
    taxPercent: { type: Number, default: 0, min: 0 },
    items: [
      {
        _id: false,
        productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
        quantity: { type: Number, required: true, min: 1 },
      },
    ],
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);
export type IPackage = InferSchemaType<typeof packageSchema> & { _id: Types.ObjectId };
export const Package = model('Package', packageSchema);
