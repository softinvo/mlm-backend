import { Request, Response } from 'express';
import { isValidObjectId } from 'mongoose';
import { z } from 'zod';
import { AuditLog, Package, Product } from '../models';
import { scopeOf } from '../services/franchise.service';
import { stockOf } from '../services/stock.service';
import { cancelRequestByFranchise, confirmWithOtp, listForFranchise, sendRequestOtp } from '../services/payment-request.service';
import { createSale, lookupMember } from '../services/sale.service';
import { HttpError } from '../utils/http';

export const franchiseCatalog = async (req: Request, res: Response) => {
  const { franchiseId } = z.object({ franchiseId: z.string().length(24).optional() }).parse(req.query);
  const scope = await scopeOf(req.auth!.userId);
  const fid = franchiseId ?? scope.franchises[0].id;
  if (!scope.ownIds.some((x) => x.toString() === fid)) throw new HttpError(404, 'Franchise not found');
  const held = await stockOf(fid);
  const have = (t: string, id: string) => held.items.find((i) => i.itemType === t && i.id === id)?.quantity ?? 0;
  const [pk, pr] = await Promise.all([Package.find({ active: true }).sort({ pricePaise: 1 }).lean(), Product.find({ active: true }).sort({ name: 1 }).lean()]);
  res.json({
    packages: pk.map((p) => ({ id: p._id.toString(), available: have('PACKAGE', p._id.toString()), kind: 'JOINING', name: p.name, imageUrl: p.imageUrl ?? '', description: p.description ?? '', pricePaise: p.pricePaise, taxPercent: p.taxPercent ?? 0 })),
    products: pr.map((p) => ({ id: p._id.toString(), available: have('PRODUCT', p._id.toString()), kind: 'REPURCHASE', sku: p.sku, name: p.name, imageUrl: p.imageUrl ?? '', description: p.description, pricePaise: p.mrpPaise, taxPercent: p.taxPercent })),
  });
};

export const memberLookup = async (req: Request, res: Response) => {
  const { code } = z.object({ code: z.string().trim().min(3).max(20) }).parse(req.query);
  await scopeOf(req.auth!.userId); // must be an active franchise
  res.json(await lookupMember(code));
};

const itemSchema = z.object({ packageId: z.string().length(24).optional(), productId: z.string().length(24).optional(), quantity: z.number().int().min(1).max(50) })
  .refine((i) => !!i.packageId !== !!i.productId, 'Each item is either a package or a product');

const saleSchema = z.object({
  franchiseId: z.string().length(24).optional(),
  memberCode: z.string().trim().min(3).max(20),
  items: z.array(itemSchema).min(1, 'Add at least one item').max(20),
  payment: z.discriminatedUnion('type', [
    z.object({ type: z.literal('WALLET') }),
    z.object({
      type: z.literal('COUNTER'), method: z.enum(['CASH', 'UPI', 'BANK_TRANSFER']),
      reference: z.string().trim().regex(/^[A-Za-z0-9\-\/]{4,30}$/, 'Enter the receipt / reference number (4 to 30 letters or digits)'), note: z.string().trim().max(300).optional(),
    }),
  ]),
  clientKey: z.string().min(8).max(64).optional(),
});

export const sell = async (req: Request, res: Response) => {
  const b = saleSchema.parse(req.body);
  const sale = await createSale(await scopeOf(req.auth!.userId), req.auth!.userId, b);
  await AuditLog.create({ actorId: req.auth!.userId, action: 'FRANCHISE_SALE', entity: 'Order', entityId: sale.orderId, after: { memberCode: b.memberCode, payment: b.payment.type, totalPaise: sale.totalPaise } });
  res.status(sale.repeated ? 200 : 201).json(sale);
};

export const paymentRequests = async (req: Request, res: Response) => {
  const q = z.object({ page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(20), status: z.enum(['PENDING', 'APPROVED', 'DECLINED', 'EXPIRED', 'CANCELLED']).optional() }).parse(req.query);
  res.json(await listForFranchise(await scopeOf(req.auth!.userId), q));
};

export const cancelPaymentRequest = async (req: Request, res: Response) => {
  const id = req.params.id as string;
  if (!isValidObjectId(id)) throw new HttpError(404, 'Request not found');
  const r = await cancelRequestByFranchise(await scopeOf(req.auth!.userId), id);
  res.json({ id: r._id.toString(), status: r.status });
};

const oid = (req: Request) => { const id = req.params.id as string; if (!isValidObjectId(id)) throw new HttpError(404, 'Payment request not found'); return id; };

/** The shop enters the code the member read out. */
export const confirmPaymentRequest = async (req: Request, res: Response) => {
  const { otp } = z.object({ otp: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code') }).parse(req.body);
  const id = oid(req);
  const r = await confirmWithOtp(await scopeOf(req.auth!.userId), id, otp);
  await AuditLog.create({ actorId: req.auth!.userId, action: 'WALLET_SALE_CONFIRMED_BY_OTP', entity: 'WalletPaymentRequest', entityId: r._id, after: { amountPaise: r.amountPaise } });
  res.json({ id, status: r.status });
};

/** The member did not get the code (or wants it by email instead of SMS): send another. */
export const resendPaymentOtp = async (req: Request, res: Response) => {
  const { channel } = z.object({ channel: z.enum(['SMS', 'EMAIL']).optional() }).parse(req.body ?? {});
  const id = oid(req);
  await scopeOf(req.auth!.userId);
  res.json(await sendRequestOtp(id, channel));
};
