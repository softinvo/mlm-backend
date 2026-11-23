import { Schema, model } from 'mongoose';

export const StockItemTypes = ['PACKAGE', 'PRODUCT'] as const; // PACKAGE = joining kit, PRODUCT = repurchase product
export type StockItemType = (typeof StockItemTypes)[number];
export const StockMovementTypes = ['SUPPLY', 'TRANSFER_OUT', 'SALE', 'SALE_RETURN', 'ADJUSTMENT'] as const;
export type StockMovementType = (typeof StockMovementTypes)[number];

// What a franchise currently holds (cached; the movements below are the history and always add up to it).
const stockSchema = new Schema(
  {
    franchiseId: { type: Schema.Types.ObjectId, ref: 'Franchise', required: true },
    itemType: { type: String, enum: StockItemTypes, required: true },
    itemId: { type: Schema.Types.ObjectId, required: true },
    quantity: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true },
);
stockSchema.index({ franchiseId: 1, itemType: 1, itemId: 1 }, { unique: true });
export const FranchiseStock = model('FranchiseStock', stockSchema);

// Append-only history of every change to a franchise's stock.
const movementSchema = new Schema(
  {
    franchiseId: { type: Schema.Types.ObjectId, ref: 'Franchise', required: true },
    itemType: { type: String, enum: StockItemTypes, required: true },
    itemId: { type: Schema.Types.ObjectId, required: true },
    type: { type: String, enum: StockMovementTypes, required: true },
    quantity: { type: Number, required: true },        // signed: + in, − out
    balanceAfter: { type: Number, required: true },
    refType: String,
    refId: Schema.Types.ObjectId,
    idempotencyKey: String,
    note: String,
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
movementSchema.index({ franchiseId: 1, createdAt: -1 });
movementSchema.index({ idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } });
export const StockMovement = model('StockMovement', movementSchema);

// A delivery from the company to a franchise: stock goes up, the prepaid balance is charged at retail less the franchise's discount.
const supplyLine = new Schema(
  {
    itemType: { type: String, enum: StockItemTypes, required: true },
    itemId: { type: Schema.Types.ObjectId, required: true },
    name: { type: String, required: true },
    sku: String,
    quantity: { type: Number, required: true, min: 1 },
    unitPricePaise: { type: Number, required: true },  // retail (tax-inclusive) at the time
    retailPaise: { type: Number, required: true },
    costPaise: { type: Number, required: true },       // retail less the franchise's discount
  },
  { _id: false },
);
const supplySchema = new Schema(
  {
    franchiseId: { type: Schema.Types.ObjectId, ref: 'Franchise', required: true, index: true }, // who receives the stock
    fromFranchiseId: { type: Schema.Types.ObjectId, ref: 'Franchise', index: true },             // a franchise supplying one it manages; empty = the head office
    lines: { type: [supplyLine], validate: (v: unknown[]) => v.length > 0 },
    discountPercent: { type: Number, required: true },
    totalRetailPaise: { type: Number, required: true },
    totalCostPaise: { type: Number, required: true },
    note: String,
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    clientKey: String,
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
supplySchema.index({ franchiseId: 1, clientKey: 1 }, { unique: true, partialFilterExpression: { clientKey: { $type: 'string' } } });
export const Supply = model('Supply', supplySchema);
