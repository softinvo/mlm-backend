import { Request, Response } from 'express';
import { isValidObjectId, Types } from 'mongoose';
import { z } from 'zod';
import { AuditLog, FranchiseRecharge, PaymentModes } from '../models';
import { scopeOf } from '../services/franchise.service';
import {
  adjustBalance, adminOverview, cancelRecharge, confirmRecharge, createRecharge, listEntries, listRecharges, rejectRecharge, statement,
} from '../services/prepaid.service';
import { HttpError } from '../utils/http';

const page = { page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(10) };
const oid = (v: string, what = 'Not found') => { if (!isValidObjectId(v)) throw new HttpError(404, what); return new Types.ObjectId(v); };
const audit = (req: Request, action: string, entity: string, entityId: unknown, after?: unknown) =>
  AuditLog.create({ actorId: req.auth!.userId, action, entity, entityId, after });

/** A franchise user works on one of THEIR OWN franchises (not ones they manage); default to the first they run. */
async function pick(req: Request, franchiseId?: string) {
  const scope = await scopeOf(req.auth!.userId);
  const id = franchiseId ? oid(franchiseId, 'Franchise not found') : new Types.ObjectId(scope.franchises[0].id);
  if (!scope.ownIds.some((x) => x.equals(id))) throw new HttpError(404, 'Franchise not found');
  return { scope, id };
}

// ───────── franchise ─────────

export const myPrepaid = async (req: Request, res: Response) => {
  const { franchiseId } = z.object({ franchiseId: z.string().length(24).optional() }).parse(req.query);
  const { scope, id } = await pick(req, franchiseId);
  res.json({ ...(await statement(id)), franchises: scope.franchises.filter((f) => scope.ownIds.some((o) => o.toString() === f.id)) });
};

export const myPrepaidEntries = async (req: Request, res: Response) => {
  const q = z.object({ ...page, franchiseId: z.string().length(24).optional(), type: z.string().optional() }).parse(req.query);
  const { id } = await pick(req, q.franchiseId);
  res.json(await listEntries(id, q));
};

export const myRecharges = async (req: Request, res: Response) => {
  const q = z.object({ ...page, status: z.enum(['PENDING', 'CONFIRMED', 'REJECTED', 'CANCELLED']).optional() }).parse(req.query);
  const scope = await scopeOf(req.auth!.userId);
  res.json(await listRecharges(scope.ownIds, q));
};

export const submitRecharge = async (req: Request, res: Response) => {
  const b = z.object({
    franchiseId: z.string().length(24).optional(),
    amountPaise: z.number().int('Enter a whole number of paise').min(1),
    mode: z.enum(PaymentModes),
    reference: z.string().trim().regex(/^[A-Za-z0-9\-\/]{6,30}$/, 'Enter the bank reference / UTR (6 to 30 letters or digits)'),
    paidOn: z.coerce.date({ message: 'Enter the payment date' }),
    note: z.string().trim().max(200).optional(),
  }).parse(req.body);
  const { id } = await pick(req, b.franchiseId);
  const r = await createRecharge(id, req.auth!.userId, b);
  await audit(req, 'RECHARGE_SUBMITTED', 'FranchiseRecharge', r._id, { amountPaise: b.amountPaise });
  res.status(201).json({ id: r._id.toString(), status: r.status });
};

export const cancelMyRecharge = async (req: Request, res: Response) => {
  const scope = await scopeOf(req.auth!.userId);
  const r = await cancelRecharge(scope.ownIds, oid(req.params.id as string, 'Recharge not found').toString());
  await audit(req, 'RECHARGE_CANCELLED', 'FranchiseRecharge', r._id);
  res.json({ id: r._id.toString(), status: r.status });
};

// ───────── head office ─────────

export const adminPrepaid = async (_req: Request, res: Response) => res.json(await adminOverview());

export const adminFranchisePrepaid = async (req: Request, res: Response) => {
  const q = z.object({ ...page, type: z.string().optional() }).parse(req.query);
  const id = oid(req.params.franchiseId as string, 'Franchise not found');
  res.json({ statement: await statement(id), entries: await listEntries(id, q) });
};

export const adminAdjust = async (req: Request, res: Response) => {
  const b = z.object({ amountPaise: z.number().int().refine((n) => n !== 0, 'Amount cannot be zero'), reason: z.string().trim().min(3).max(200) }).parse(req.body);
  const id = oid(req.params.franchiseId as string, 'Franchise not found').toString();
  const balance = await adjustBalance(id, b);
  await audit(req, 'PREPAID_ADJUSTED', 'Franchise', id, b);
  res.json({ balancePaise: balance });
};

export const adminRecharges = async (req: Request, res: Response) => {
  const q = z.object({ ...page, limit: z.coerce.number().int().min(1).max(100).default(20), status: z.enum(['PENDING', 'CONFIRMED', 'REJECTED', 'CANCELLED']).optional() }).parse(req.query);
  res.json(await listRecharges(null, q));
};

export const adminConfirmRecharge = async (req: Request, res: Response) => {
  const b = z.object({ confirmedPaise: z.number().int().min(1).optional(), note: z.string().trim().max(200).optional() }).parse(req.body);
  const r = await confirmRecharge(req.auth!.userId, oid(req.params.id as string, 'Recharge not found').toString(), b);
  await audit(req, 'RECHARGE_CONFIRMED', 'FranchiseRecharge', r._id, { confirmedPaise: r.confirmedPaise });
  res.json({ id: r._id.toString(), status: r.status, confirmedPaise: r.confirmedPaise });
};

export const adminRejectRecharge = async (req: Request, res: Response) => {
  const { reason } = z.object({ reason: z.string().trim().min(3).max(200) }).parse(req.body);
  const r = await rejectRecharge(req.auth!.userId, oid(req.params.id as string, 'Recharge not found').toString(), reason);
  await audit(req, 'RECHARGE_REJECTED', 'FranchiseRecharge', r._id, { reason });
  res.json({ id: r._id.toString(), status: r.status });
};

void FranchiseRecharge;
