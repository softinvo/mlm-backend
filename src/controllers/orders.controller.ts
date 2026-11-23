import { Request, Response } from 'express';
import { isValidObjectId } from 'mongoose';
import { z } from 'zod';
import { Member, Order, Package, Product, ShippingAddress } from '../models';
import { cancelOrder, placeOrder } from '../services/order.service';
import { payOrderWithShoppingWallet } from '../services/wallet.service';
import { HttpError } from '../utils/http';

export const catalog = async (_req: Request, res: Response) => {
  const [packages, products] = await Promise.all([Package.find({ active: true }).sort({ pricePaise: 1 }).lean(), Product.find({ active: true }).sort({ name: 1 }).lean()]);
  res.json({
    packages: packages.map((p) => ({ id: p._id.toString(), kind: 'JOINING', name: p.name, description: p.description ?? '', pricePaise: p.pricePaise, taxPercent: p.taxPercent ?? 0, imageUrl: p.imageUrl ?? '' })),
    products: products.map((p) => ({ id: p._id.toString(), kind: 'REPURCHASE', sku: p.sku, name: p.name, description: p.description, pricePaise: p.mrpPaise, taxPercent: p.taxPercent, imageUrl: p.imageUrl ?? '' })),
  });
};

const orderNo = (id: { toString(): string }) => '#' + id.toString().slice(-6).toUpperCase();

/** What the checkout confirmation page needs. */
async function summarize(orderId: string) {
  const o: any = await Order.findById(orderId).populate('items.packageId', 'name imageUrl').populate('items.productId', 'name imageUrl').lean();
  const gateway = o.payments?.[0]?.gateway ?? null;
  return {
    id: o._id.toString(), orderNo: orderNo(o._id), placedAt: o.createdAt, status: o.status,
    paymentStatus: o.status === 'PLACED' ? 'AWAITING_PAYMENT' : o.status === 'CANCELLED' ? 'CANCELLED' : 'PAID',
    paidWith: gateway, totalPaise: o.totalPaise, taxPaise: o.taxPaise, refundedPaise: o.refundedPaise ?? 0,
    shipmentStatus: o.shipment?.status ?? 'PENDING',
    items: o.items.map((i: any) => ({ name: i.packageId?.name ?? i.productId?.name ?? 'Item', imageUrl: i.packageId?.imageUrl || i.productId?.imageUrl || '', quantity: i.quantity, unitPricePaise: i.unitPricePaise })),
    address: o.shippingAddress ?? null,
  };
}

const orderSchema = z.object({
  items: z.array(z.object({
    packageId: z.string().length(24, 'Invalid package').optional(),
    productId: z.string().length(24, 'Invalid product').optional(),
    quantity: z.number().int().min(1).max(50),
  }).refine((i) => !!i.packageId !== !!i.productId, 'Each item is either a package or a product')).min(1, 'Add at least one item').max(20),
  addressId: z.string().length(24, 'Choose a delivery address'),
  payWith: z.enum(['SHOPPING_WALLET']).optional(), // omit: order is reserved until payment is confirmed
  clientKey: z.string().min(8).max(64).optional(),  // retry-safe: the same key returns the same order
});

const ownedOrder = async (req: Request) => {
  const id = req.params.id as string;
  if (!isValidObjectId(id)) throw new HttpError(404, 'Order not found');
  const order = await Order.findOne({ _id: id, buyerId: req.auth!.userId });
  if (!order) throw new HttpError(404, 'Order not found');
  return order;
};

/** A member buys for themselves. Price, tax and the fulfilling franchise are decided server-side. */
export const createOrder = async (req: Request, res: Response) => {
  const body = orderSchema.parse(req.body);
  const userId = req.auth!.userId;

  if (body.clientKey) {
    const existing = await Order.findOne({ buyerId: userId, clientKey: body.clientKey }).select('_id');
    if (existing) return res.status(200).json(await summarize(existing._id.toString()));
  }

  const member = await Member.findOne({ userId });
  if (!member) throw new HttpError(404, 'Member profile not found');
  const a = await ShippingAddress.findOne({ _id: body.addressId, userId });
  if (!a) throw new HttpError(400, 'Delivery address not found');
  const shippingAddress = { fullName: a.fullName, phone: a.phone, line1: a.line1, line2: a.line2 ?? undefined, city: a.city, state: a.state, pincode: a.pincode };

  let order;
  try {
    order = await placeOrder({ buyerUserId: userId, franchiseId: member.franchiseId, items: body.items, shippingAddress, clientKey: body.clientKey });
  } catch (e: any) {
    if (e?.code === 11000 && body.clientKey) { // two identical requests raced; return the winner
      const existing = await Order.findOne({ buyerId: userId, clientKey: body.clientKey }).select('_id');
      if (existing) return res.status(200).json(await summarize(existing._id.toString()));
    }
    throw e;
  }

  if (body.payWith === 'SHOPPING_WALLET') {
    try {
      await payOrderWithShoppingWallet(order._id.toString(), userId);
    } catch (e) {
      await cancelOrder(order._id.toString(), 'Shopping wallet payment failed').catch(() => {}); // do not leave an unpaid order behind
      throw e;
    }
  }
  res.status(201).json(await summarize(order._id.toString()));
};

export const getOrder = async (req: Request, res: Response) => {
  const o = await ownedOrder(req);
  res.json(await summarize(o._id.toString()));
};

/** Pays a reserved (unpaid) order from the shopping wallet. */
export const payMyOrder = async (req: Request, res: Response) => {
  const o = await ownedOrder(req);
  z.object({ payWith: z.literal('SHOPPING_WALLET') }).parse(req.body);
  await payOrderWithShoppingWallet(o._id.toString(), req.auth!.userId);
  res.json(await summarize(o._id.toString()));
};

/** Members can cancel orders that are still unpaid; paid orders go through support/refund. */
export const cancelMyOrder = async (req: Request, res: Response) => {
  const o = await ownedOrder(req);
  if (o.status !== 'PLACED') throw new HttpError(409, 'Only unpaid orders can be cancelled here. Contact support for paid orders.');
  await cancelOrder(o._id.toString(), 'Cancelled by customer');
  res.json(await summarize(o._id.toString()));
};
