import { summaryMine as supportSummary } from '../services/support.service';
import { Request, Response } from 'express';
import { isValidObjectId } from 'mongoose';
import { z } from 'zod';
import { AuditLog, FundRequestStatuses, WithdrawalStatuses } from '../models';
import {
  cancelUnpaid, kycDetail, listFunds, listKyc, listMembers, listOrders, listWithdrawals, ORDER_TAB_KEYS, overview, payWithdrawal, recommendFund, recommendWithdrawal,
  collectPayment, reviewMemberKyc, scopeOf, shipOrder,
} from '../services/franchise.service';
import { HttpError } from '../utils/http';

const page = { page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(20) };
const idOf = (req: Request, name = 'id') => {
  const v = req.params[name] as string;
  if (!isValidObjectId(v)) throw new HttpError(404, 'Not found');
  return v;
};
const audit = (req: Request, action: string, entity: string, entityId: string, after?: unknown) =>
  AuditLog.create({ actorId: req.auth!.userId, action, entity, entityId, after });
const me = (req: Request) => req.auth!.userId;
const scope = (req: Request) => scopeOf(me(req));
const decision = z.object({ decision: z.enum(['APPROVE', 'REJECT']), note: z.string().trim().max(300).optional() });

export const getOverview = async (req: Request, res: Response) => {
  const [o, mine] = await Promise.all([overview(await scope(req)), supportSummary(req.auth!.userId)]);
  res.json({ ...o, counts: { ...o.counts, supportNeedsReply: mine.needsReply } }); // tickets where the head office is waiting for this owner
};

export const members = async (req: Request, res: Response) => {
  const q = z.object({ ...page, search: z.string().trim().max(50).optional() }).parse(req.query);
  res.json(await listMembers(await scope(req), q));
};

// bank-detail verification
export const kycList = async (req: Request, res: Response) => {
  const q = z.object({ ...page, status: z.enum(['PENDING', 'VERIFIED', 'REJECTED']).optional() }).parse(req.query);
  res.json(await listKyc(await scope(req), q));
};
export const kycView = async (req: Request, res: Response) => {
  const userId = idOf(req, 'userId');
  const d = await kycDetail(await scope(req), userId);
  await audit(req, 'KYC_VIEWED', 'User', userId); // viewing the full account number is always logged
  res.json(d);
};
export const kycReview = async (req: Request, res: Response) => {
  const userId = idOf(req, 'userId');
  const b = z.object({ status: z.enum(['VERIFIED', 'REJECTED']), note: z.string().trim().max(200).optional() }).parse(req.body);
  await reviewMemberKyc(await scope(req), me(req), userId, b.status, b.note);
  await audit(req, `KYC_${b.status}`, 'User', userId, b);
  res.json({ ok: true });
};

// top-ups (recommend only)
export const funds = async (req: Request, res: Response) => {
  const q = z.object({ ...page, status: z.enum(FundRequestStatuses).optional(), recommended: z.enum(['true', 'false']).transform((v) => v === 'true').optional() }).parse(req.query);
  res.json(await listFunds(await scope(req), q));
};
export const fundRecommend = async (req: Request, res: Response) => {
  const b = decision.extend({ approvedPaise: z.number().int().min(1).optional() }).parse(req.body);
  const r = await recommendFund(await scope(req), me(req), idOf(req), b);
  await audit(req, 'FUND_RECOMMENDED', 'FundRequest', r._id.toString(), b);
  res.json({ id: r._id.toString(), recommended: b.decision });
};

// withdrawals (recommend; mark paid once the admin approved)
export const withdrawals = async (req: Request, res: Response) => {
  const q = z.object({ ...page, status: z.enum(WithdrawalStatuses).optional(), recommended: z.enum(['true', 'false']).transform((v) => v === 'true').optional() }).parse(req.query);
  res.json(await listWithdrawals(await scope(req), q, (status) => status === 'APPROVED'));
};
export const withdrawalRecommend = async (req: Request, res: Response) => {
  const b = decision.parse(req.body);
  const w = await recommendWithdrawal(await scope(req), me(req), idOf(req), b);
  await audit(req, 'WITHDRAWAL_RECOMMENDED', 'Withdrawal', w._id.toString(), b);
  res.json({ id: w._id.toString(), recommended: b.decision });
};
export const withdrawalPay = async (req: Request, res: Response) => {
  const { payoutRef } = z.object({ payoutRef: z.string().trim().min(3).max(100) }).parse(req.body);
  const w = await payWithdrawal(await scope(req), idOf(req), payoutRef);
  await audit(req, 'WITHDRAWAL_PAID', 'Withdrawal', w._id.toString(), { payoutRef });
  res.json({ id: w._id.toString(), status: w.status });
};

// orders
export const orders = async (req: Request, res: Response) => {
  const q = z.object({ ...page, tab: z.enum(ORDER_TAB_KEYS as [string, ...string[]]).default('awaiting') }).parse(req.query);
  res.json(await listOrders(await scope(req), q));
};
export const orderPaymentReceived = async (req: Request, res: Response) => {
  const b = z.object({
    method: z.enum(['CASH', 'UPI', 'BANK_TRANSFER']),
    reference: z.string().trim().regex(/^[A-Za-z0-9\-\/]{4,30}$/, 'Enter the receipt / reference number (4 to 30 letters or digits)'),
    note: z.string().trim().max(300).optional(),
  }).parse(req.body);
  const o = await collectPayment(await scope(req), idOf(req), b);
  await audit(req, 'ORDER_PAYMENT_COLLECTED', 'Order', o._id.toString(), b);
  res.json({ id: o._id.toString(), status: o.status });
};
export const orderShip = async (req: Request, res: Response) => {
  const b = z.object({
    status: z.enum(['PACKED', 'SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED']),
    courier: z.string().trim().max(60).optional(), trackingId: z.string().trim().max(60).optional(), note: z.string().trim().max(200).optional(),
  }).parse(req.body);
  const o = await shipOrder(await scope(req), idOf(req), b.status, b);
  await audit(req, `SHIPMENT_${b.status}`, 'Order', o._id.toString(), b);
  res.json({ id: o._id.toString(), status: o.status, shipmentStatus: o.shipment?.status });
};
export const orderCancel = async (req: Request, res: Response) => {
  const { reason } = z.object({ reason: z.string().trim().min(3).max(200) }).parse(req.body);
  const o = await cancelUnpaid(await scope(req), idOf(req), reason);
  await audit(req, 'ORDER_CANCELLED', 'Order', o._id.toString(), { reason });
  res.json({ id: o._id.toString(), status: o.status });
};
