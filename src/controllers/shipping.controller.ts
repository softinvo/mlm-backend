import { Request, Response } from 'express';
import { isValidObjectId } from 'mongoose';
import { z } from 'zod';
import { AddressLabels, Order, ShipmentStatuses, ShippingAddress } from '../models';
import { HttpError } from '../utils/http';

const MAX_ADDRESSES = 10;

const addressSchema = z.object({
  label: z.enum(AddressLabels).default('HOME'),
  fullName: z.string().trim().min(2, 'Enter the recipient name').max(80),
  phone: z.string().regex(/^[6-9]\d{9}$/, 'Enter a valid 10-digit mobile number'),
  line1: z.string().trim().min(3, 'Enter the house / street address').max(120),
  line2: z.string().trim().max(120).optional().default(''),
  city: z.string().trim().min(2, 'Enter the city').max(60),
  state: z.string().trim().min(2, 'Select the state').max(60),
  pincode: z.string().regex(/^\d{6}$/, 'Enter a 6-digit pincode'),
  isDefault: z.boolean().optional(),
});

const serialize = (a: any) => ({
  id: a._id.toString(), label: a.label, fullName: a.fullName, phone: a.phone, line1: a.line1, line2: a.line2 ?? '',
  city: a.city, state: a.state, pincode: a.pincode, isDefault: a.isDefault, createdAt: a.createdAt,
});

const idParam = (req: Request) => {
  const id = req.params.id as string;
  if (!isValidObjectId(id)) throw new HttpError(404, 'Address not found');
  return id;
};

async function findOwned(req: Request) {
  const address = await ShippingAddress.findOne({ _id: idParam(req), userId: req.auth!.userId });
  if (!address) throw new HttpError(404, 'Address not found');
  return address;
}

export const listAddresses = async (req: Request, res: Response) => {
  const rows = await ShippingAddress.find({ userId: req.auth!.userId }).sort({ isDefault: -1, createdAt: -1 });
  res.json({ items: rows.map(serialize), max: MAX_ADDRESSES });
};

export const createAddress = async (req: Request, res: Response) => {
  const userId = req.auth!.userId;
  const body = addressSchema.parse(req.body);
  if ((await ShippingAddress.countDocuments({ userId })) >= MAX_ADDRESSES) {
    throw new HttpError(400, `You can save up to ${MAX_ADDRESSES} addresses. Delete one to add another.`);
  }
  const makeDefault = body.isDefault || (await ShippingAddress.countDocuments({ userId })) === 0;
  if (makeDefault) await ShippingAddress.updateMany({ userId, isDefault: true }, { $set: { isDefault: false } });
  const created = await ShippingAddress.create({ ...body, userId, isDefault: makeDefault });
  res.status(201).json(serialize(created));
};

export const updateAddress = async (req: Request, res: Response) => {
  const address = await findOwned(req);
  const { isDefault, ...fields } = addressSchema.parse(req.body);
  address.set(fields);
  if (isDefault && !address.isDefault) {
    await ShippingAddress.updateMany({ userId: address.userId, isDefault: true }, { $set: { isDefault: false } });
    address.isDefault = true;
  }
  await address.save();
  res.json(serialize(address));
};

export const setDefaultAddress = async (req: Request, res: Response) => {
  const address = await findOwned(req);
  if (!address.isDefault) {
    await ShippingAddress.updateMany({ userId: address.userId, isDefault: true }, { $set: { isDefault: false } });
    address.isDefault = true;
    await address.save();
  }
  res.json(serialize(address));
};

export const deleteAddress = async (req: Request, res: Response) => {
  const address = await findOwned(req);
  await address.deleteOne();
  if (address.isDefault) {
    // Promote the most recent remaining address so there is always a default.
    const next = await ShippingAddress.findOne({ userId: address.userId }).sort({ createdAt: -1 });
    if (next) { next.isDefault = true; await next.save(); }
  }
  res.json({ ok: true });
};

// ───────── Shipping history ─────────

const historyQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(10),
  status: z.enum(ShipmentStatuses).optional(),
});

export const shippingHistory = async (req: Request, res: Response) => {
  const q = historyQuery.parse(req.query);
  const filter: Record<string, unknown> = { buyerId: req.auth!.userId };
  if (q.status) filter['shipment.status'] = q.status;

  const [orders, total] = await Promise.all([
    Order.find(filter).sort({ createdAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit)
      .populate('items.productId', 'name imageUrl').populate('items.packageId', 'name imageUrl').lean(),
    Order.countDocuments(filter),
  ]);

  const items = orders.map((o: any) => {
    const s = o.shipment ?? {};
    // Orders created before shipment tracking existed fall back to the order status.
    const status = s.status ?? (o.status === 'DELIVERED' ? 'DELIVERED' : 'PENDING');
    return {
      id: o._id.toString(),
      orderNo: '#' + o._id.toString().slice(-6).toUpperCase(),
      placedAt: o.createdAt,
      totalPaise: o.totalPaise,
      status,
      awaitingPayment: o.status === 'PLACED',
      courier: s.courier ?? null,
      trackingId: s.trackingId ?? null,
      expectedDelivery: s.expectedDelivery ?? null,
      items: (o.items ?? []).map((i: any) => ({ name: i.packageId?.name ?? i.productId?.name ?? 'Item', imageUrl: i.packageId?.imageUrl || i.productId?.imageUrl || '', quantity: i.quantity })),
      address: o.shippingAddress ?? null,
      events: (s.events ?? []).map((e: any) => ({ status: e.status, at: e.at, note: e.note ?? null })),
    };
  });
  res.json({ items, total, page: q.page, limit: q.limit, pages: Math.max(1, Math.ceil(total / q.limit)) });
};
