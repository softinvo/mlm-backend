import { Request, Response } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { Franchise, Order } from '../models';

const PAID = ['PAID', 'DELIVERED', 'PARTIALLY_REFUNDED'];
const FILTERS: Record<string, Record<string, unknown>> = {
  all: {},
  paid: { status: { $in: PAID } },
  awaiting: { status: 'PLACED' },
  cancelled: { status: 'CANCELLED' },
  refunded: { status: { $in: ['REFUNDED', 'PARTIALLY_REFUNDED'] } },
  // delivery: paid orders that have not arrived yet, and ones that have
  shipping: { status: { $in: PAID.filter((s) => s !== 'DELIVERED') }, 'shipment.status': { $in: ['PENDING', 'PACKED', 'SHIPPED', 'OUT_FOR_DELIVERY'] } },
  delivered: { 'shipment.status': 'DELIVERED' },
};
const TYPES: Record<string, Record<string, unknown>> = { all: {}, joining: { 'items.packageId': { $exists: true } }, repurchase: { 'items.productId': { $exists: true } } };

/** How an order was paid, in words a member understands. */
export const paymentLabel = (gateway?: string) => {
  if (!gateway) return null;
  if (gateway === 'SHOPPING_WALLET') return 'Shopping wallet';
  if (gateway === 'COUNTER_CASH') return 'Cash at the shop';
  if (gateway === 'COUNTER_UPI') return 'UPI at the shop';
  if (gateway === 'COUNTER_BANK_TRANSFER') return 'Bank transfer at the shop';
  if (gateway === 'manual') return 'Confirmed by the head office';
  return gateway.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase());
};

/** What the member bought, when, from which shop, at what price, how they paid, and where the delivery is. */
export const purchaseHistory = async (req: Request, res: Response) => {
  const q = z.object({
    page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(50).default(8),
    status: z.enum(['all', 'paid', 'shipping', 'delivered', 'awaiting', 'cancelled', 'refunded']).default('all'),
    type: z.enum(['all', 'joining', 'repurchase']).default('all'),
  }).parse(req.query);
  const buyerId = new Types.ObjectId(req.auth!.userId);
  const filter = { buyerId, ...FILTERS[q.status], ...TYPES[q.type] };

  const [orders, total, sums] = await Promise.all([
    Order.find(filter).sort({ createdAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit)
      .populate('items.packageId', 'name imageUrl').populate('items.productId', 'name sku imageUrl').lean(),
    Order.countDocuments(filter),
    Order.aggregate([
      { $match: { buyerId, status: { $in: [...PAID, 'REFUNDED'] } } },
      { $group: { _id: null, spent: { $sum: { $subtract: ['$totalPaise', { $ifNull: ['$refundedPaise', 0] }] } }, refunded: { $sum: { $ifNull: ['$refundedPaise', 0] } }, orders: { $sum: { $cond: [{ $in: ['$status', PAID] }, 1, 0] } }, last: { $max: '$createdAt' }, units: { $sum: { $cond: [{ $in: ['$status', PAID] }, { $sum: '$items.quantity' }, 0] } } } },
    ]),
  ]);
  const frs = await Franchise.find({ _id: { $in: orders.map((o) => o.franchiseId) } }).select('name code').lean();

  res.json({
    items: orders.map((o: any) => {
      const f = frs.find((x) => x._id.equals(o.franchiseId));
      const paidWith = [...(o.payments ?? [])].reverse().find((p: any) => p.status === 'SUCCESS');
      return {
        id: o._id.toString(), orderNo: '#' + o._id.toString().slice(-6).toUpperCase(), placedAt: o.createdAt, paidAt: o.paidAt ?? null,
        status: o.status, totalPaise: o.totalPaise, refundedPaise: o.refundedPaise ?? 0, paymentMethod: paymentLabel(paidWith?.gateway),
        shop: f ? { name: f.name, code: f.code } : null,
        // Orders from before shipment tracking existed fall back to the order status.
        shipment: (() => { const s = o.shipment ?? {}; return {
          status: s.status ?? (o.status === 'DELIVERED' ? 'DELIVERED' : 'PENDING'), courier: s.courier ?? null, trackingId: s.trackingId ?? null, expectedDelivery: s.expectedDelivery ?? null,
          events: (s.events ?? []).map((e: any) => ({ status: e.status, at: e.at, note: e.note ?? null })), address: o.shippingAddress ?? null,
        }; })(),
        items: (o.items ?? []).map((i: any) => ({
          kind: i.packageId ? 'JOINING' : 'REPURCHASE', name: i.packageId?.name ?? i.productId?.name ?? 'Item', sku: i.productId?.sku ?? null,
          imageUrl: i.packageId?.imageUrl || i.productId?.imageUrl || '', quantity: i.quantity, unitPricePaise: i.unitPricePaise, linePaise: i.unitPricePaise * i.quantity,
        })),
      };
    }),
    total, page: q.page, limit: q.limit, pages: Math.max(1, Math.ceil(total / q.limit)),
    summary: { spentPaise: sums[0]?.spent ?? 0, refundedPaise: sums[0]?.refunded ?? 0, orders: sums[0]?.orders ?? 0, units: sums[0]?.units ?? 0, lastPurchaseAt: sums[0]?.last ?? null },
  });
};
