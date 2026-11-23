import { Request, Response } from 'express';
import { isValidObjectId } from 'mongoose';
import { z } from 'zod';
import { AuditLog, CommissionPlan, Ranks, WithdrawalStatuses } from '../models';
import { approveDueCommissions, refundOrder } from '../services/commission.service';
import { advanceShipment, cancelOrder, payOrder } from '../services/order.service';
import { listWithdrawals as listWithdrawalsScoped } from '../services/franchise.service';
import { approveWithdrawal, markWithdrawalPaid, rejectWithdrawal, reviewKyc } from '../services/wallet.service';
import { HttpError } from '../utils/http';

const orderId = (req: Request) => {
  const id = req.params.id as string;
  if (!isValidObjectId(id)) throw new HttpError(404, 'Order not found');
  return id;
};
const audit = (req: Request, action: string, entityId: string, after?: unknown) =>
  AuditLog.create({ actorId: req.auth!.userId, action, entity: 'Order', entityId, after });

const summary = (o: any) => ({ id: o._id.toString(), status: o.status, shipmentStatus: o.shipment?.status, totalPaise: o.totalPaise, refundedPaise: o.refundedPaise });

export const markPaid = async (req: Request, res: Response) => {
  const body = z.object({ gateway: z.string().trim().min(1).default('manual'), gatewayRef: z.string().trim().min(3).max(100) }).parse(req.body);
  const o = await payOrder(orderId(req), body);
  await audit(req, 'ORDER_PAID', o._id.toString(), body);
  res.json(summary(o));
};

export const updateShipment = async (req: Request, res: Response) => {
  const body = z.object({
    status: z.enum(['PACKED', 'SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED']),
    courier: z.string().trim().max(60).optional(), trackingId: z.string().trim().max(60).optional(),
    expectedDelivery: z.coerce.date().optional(), note: z.string().trim().max(200).optional(),
  }).parse(req.body);
  const o = await advanceShipment(orderId(req), body.status, body);
  await audit(req, `SHIPMENT_${body.status}`, o._id.toString(), body);
  res.json(summary(o));
};

export const cancel = async (req: Request, res: Response) => {
  const { reason } = z.object({ reason: z.string().trim().min(3).max(200) }).parse(req.body);
  const o = await cancelOrder(orderId(req), reason);
  await audit(req, 'ORDER_CANCELLED', o._id.toString(), { reason });
  res.json(summary(o));
};

export const refund = async (req: Request, res: Response) => {
  const body = z.object({ amountPaise: z.number().int().min(1), reason: z.string().trim().min(3).max(200) }).parse(req.body);
  const o = await refundOrder(orderId(req), body.amountPaise, body.reason);
  await audit(req, 'ORDER_REFUNDED', o._id.toString(), body);
  res.json(summary(o));
};

/** Manual trigger for the same job the server runs on a timer. */
export const runApprovalJob = async (_req: Request, res: Response) => {
  res.json(await approveDueCommissions());
};

// ───────── Commission plan (versioned) ─────────

export const getActivePlan = async (_req: Request, res: Response) => {
  const plan = await CommissionPlan.findOne({ active: true }).sort({ version: -1 }).lean();
  res.json(plan);
};

const planSchema = z.object({
  maxPayoutPercentOfVolume: z.number().min(0).max(100),
  effectiveFrom: z.coerce.date().optional(),
  levels: z.array(z.object({ level: z.number().int().min(1).max(50), percent: z.number().min(0).max(100), minRank: z.enum(Ranks).default('ASSOCIATE') })).min(1).max(50),
  // optional repurchase royalty table; leave empty to use `levels` for every purchase
  repurchaseLevels: z.array(z.object({ level: z.number().int().min(1).max(50), percent: z.number().min(0).max(100), minRank: z.enum(Ranks).default('ASSOCIATE') })).max(50).default([]),
});

/** Creates the next plan version and makes it the active one. Past orders keep the version they were paid under. */
export const createPlan = async (req: Request, res: Response) => {
  const body = planSchema.parse(req.body);
  const levels = [...body.levels].sort((a, b) => a.level - b.level);
  if (levels.some((l, i) => l.level !== i + 1)) throw new HttpError(400, 'Levels must be numbered 1, 2, 3… with no gaps or duplicates');
  const memberTotal = levels.reduce((n, l) => n + l.percent, 0);
  if (memberTotal > body.maxPayoutPercentOfVolume) {
    throw new HttpError(400, `Level percentages add up to ${memberTotal}%, which exceeds the ${body.maxPayoutPercentOfVolume}% payout cap`);
  }
  const repurchase = [...body.repurchaseLevels].sort((a, b) => a.level - b.level);
  if (repurchase.some((l, i) => l.level !== i + 1)) throw new HttpError(400, 'Repurchase levels must be numbered 1, 2, 3… with no gaps or duplicates');
  const repurchaseTotal = repurchase.reduce((n, l) => n + l.percent, 0);
  if (repurchaseTotal > body.maxPayoutPercentOfVolume) throw new HttpError(400, `Repurchase levels add up to ${repurchaseTotal}%, which exceeds the ${body.maxPayoutPercentOfVolume}% payout cap`);
  const last = await CommissionPlan.findOne().sort({ version: -1 });
  await CommissionPlan.updateMany({ active: true }, { $set: { active: false } });
  const plan = await CommissionPlan.create({
    version: (last?.version ?? 0) + 1, effectiveFrom: body.effectiveFrom ?? new Date(), active: true,
    maxPayoutPercentOfVolume: body.maxPayoutPercentOfVolume, levels, repurchaseLevels: repurchase,
  });
  await AuditLog.create({ actorId: req.auth!.userId, action: 'PLAN_CREATED', entity: 'CommissionPlan', entityId: plan._id, after: plan.toObject() });
  res.status(201).json(plan);
};

// ───────── Withdrawals and payout-account verification ─────────

const wid = (req: Request) => {
  const id = req.params.id as string;
  if (!isValidObjectId(id)) throw new HttpError(404, 'Withdrawal not found');
  return id;
};
const wAudit = (req: Request, action: string, id: string, after?: unknown) =>
  AuditLog.create({ actorId: req.auth!.userId, action, entity: 'Withdrawal', entityId: id, after });

export const listWithdrawals = async (req: Request, res: Response) => {
  const q = z.object({ status: z.enum(WithdrawalStatuses).optional(), recommended: z.enum(['true', 'false']).transform((v) => v === 'true').optional(), page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(20) }).parse(req.query);
  res.json(await listWithdrawalsScoped(null, q, () => true)); // head office sees the full account number to pay it
};
export const approveW = async (req: Request, res: Response) => {
  const w = await approveWithdrawal(wid(req));
  await wAudit(req, 'WITHDRAWAL_APPROVED', w._id.toString());
  res.json({ id: w._id.toString(), status: w.status });
};
export const payW = async (req: Request, res: Response) => {
  const { payoutRef } = z.object({ payoutRef: z.string().trim().min(3).max(100) }).parse(req.body);
  const w = await markWithdrawalPaid(wid(req), payoutRef);
  await wAudit(req, 'WITHDRAWAL_PAID', w._id.toString(), { payoutRef });
  res.json({ id: w._id.toString(), status: w.status, payoutRef: w.payoutRef });
};
export const rejectW = async (req: Request, res: Response) => {
  const { reason } = z.object({ reason: z.string().trim().min(3).max(200) }).parse(req.body);
  const w = await rejectWithdrawal(wid(req), reason);
  await wAudit(req, 'WITHDRAWAL_REJECTED', w._id.toString(), { reason });
  res.json({ id: w._id.toString(), status: w.status });
};
export const reviewUserKyc = async (req: Request, res: Response) => {
  const userId = req.params.userId as string;
  if (!isValidObjectId(userId)) throw new HttpError(404, 'User not found');
  const body = z.object({ status: z.enum(['VERIFIED', 'REJECTED']), note: z.string().trim().max(200).optional() }).parse(req.body);
  await reviewKyc(userId, body.status, body.note, req.auth!.userId);
  await AuditLog.create({ actorId: req.auth!.userId, action: `KYC_${body.status}`, entity: 'User', entityId: userId, after: body });
  res.json({ ok: true });
};
