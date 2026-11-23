import { Request, Response } from 'express';
import { isValidObjectId, Types } from 'mongoose';
import { z } from 'zod';
import { AuditLog, FranchiseTier, StockItemTypes } from '../models';
import { descendantsOf } from '../services/hierarchy.service';
import { scopeOf } from '../services/franchise.service';
import { adjustStock, createSupply, listMovements, listSupplies, priceSupply, stockOf, stockOverview } from '../services/stock.service';
import { HttpError } from '../utils/http';

const page = { page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(10) };
const oid = (v: string, what = 'Not found') => { if (!isValidObjectId(v)) throw new HttpError(404, what); return new Types.ObjectId(v); };

/** A franchise reads the stock of one of ITS OWN franchises (default: the first). */
async function own(req: Request, franchiseId?: string) {
  const scope = await scopeOf(req.auth!.userId);
  const id = franchiseId ? oid(franchiseId, 'Franchise not found') : new Types.ObjectId(scope.franchises[0].id);
  if (!scope.ownIds.some((x) => x.equals(id))) throw new HttpError(404, 'Franchise not found');
  return id;
}

// ───────── franchise ─────────

export const myStock = async (req: Request, res: Response) => {
  const { franchiseId } = z.object({ franchiseId: z.string().length(24).optional() }).parse(req.query);
  res.json(await stockOf(await own(req, franchiseId)));
};
export const myStockMovements = async (req: Request, res: Response) => {
  const q = z.object({ ...page, franchiseId: z.string().length(24).optional() }).parse(req.query);
  res.json(await listMovements(await own(req, q.franchiseId), q));
};
export const mySupplies = async (req: Request, res: Response) => {
  const q = z.object({ ...page, franchiseId: z.string().length(24).optional() }).parse(req.query);
  res.json(await listSupplies(await own(req, q.franchiseId), q));
};

/** Franchises the caller can supply (everything below the franchise they supply from) and the franchise it comes from. */
async function managed(req: Request, fromId?: string) {
  const from = await own(req, fromId);
  const below = await descendantsOf([from], { activeOnly: true });
  return { from, below };
}

export const myNetwork = async (req: Request, res: Response) => {
  const { fromFranchiseId } = z.object({ fromFranchiseId: z.string().length(24).optional() }).parse(req.query);
  const { from, below } = await managed(req, fromFranchiseId);
  const tiers = await FranchiseTier.find({ _id: { $in: below.map((f) => f.tierId).filter(Boolean) } }).select('name rank discountPercent').lean();
  res.json({
    from: from.toString(),
    franchises: below.map((f) => { const t = tiers.find((x) => f.tierId && x._id.equals(f.tierId)); return { id: f._id.toString(), code: f.code, name: f.name, plan: t?.name ?? null, discountPercent: t?.discountPercent ?? 0, direct: !!f.parentId && f.parentId.equals(from) }; }),
  });
};

const supplyBody = z.object({ franchiseId: z.string().length(24), fromFranchiseId: z.string().length(24).optional(), lines: z.array(z.object({ itemType: z.enum(StockItemTypes), itemId: z.string().length(24), quantity: z.number().int().min(1).max(100_000) })).min(1, 'Add at least one item').max(50) });

async function checked(req: Request) {
  const b = supplyBody.parse(req.body);
  const { from, below } = await managed(req, b.fromFranchiseId);
  if (!below.some((f) => f._id.toString() === b.franchiseId)) throw new HttpError(403, 'You can only supply franchises that you manage (on a lower plan, below you)');
  return { b, from: from.toString() };
}

export const franchiseSupplyPreview = async (req: Request, res: Response) => {
  const { b } = await checked(req);
  res.json(await priceSupply(b.franchiseId, b.lines));
};

export const franchiseCreateSupply = async (req: Request, res: Response) => {
  const { b, from } = await checked(req);
  const extra = z.object({ note: z.string().trim().max(200).optional(), clientKey: z.string().min(8).max(64).optional() }).parse(req.body);
  const { supply, repeated } = await createSupply(req.auth!.userId, { franchiseId: b.franchiseId, fromFranchiseId: from, lines: b.lines, ...extra });
  if (!repeated) await AuditLog.create({ actorId: req.auth!.userId, action: 'STOCK_SUPPLIED', entity: 'Franchise', entityId: b.franchiseId, after: { supplyId: supply._id, from, totalCostPaise: supply.totalCostPaise } });
  res.status(repeated ? 200 : 201).json({ id: supply._id.toString(), totalRetailPaise: supply.totalRetailPaise, totalCostPaise: supply.totalCostPaise, repeated });
};

// ───────── head office ─────────

const lines = z.array(z.object({ itemType: z.enum(StockItemTypes), itemId: z.string().length(24), quantity: z.number().int().min(1).max(100_000) })).min(1, 'Add at least one item').max(50);

export const adminStockOverview = async (_req: Request, res: Response) => res.json(await stockOverview());

export const adminFranchiseStock = async (req: Request, res: Response) => {
  const q = z.object(page).parse(req.query);
  const id = oid(req.params.franchiseId as string, 'Franchise not found');
  res.json({ stock: await stockOf(id, { all: true }), movements: await listMovements(id, q) });
};

export const adminSupplyPreview = async (req: Request, res: Response) => {
  const b = z.object({ franchiseId: z.string().length(24), lines }).parse(req.body);
  res.json(await priceSupply(b.franchiseId, b.lines));
};

export const adminCreateSupply = async (req: Request, res: Response) => {
  const b = z.object({ franchiseId: z.string().length(24), lines, note: z.string().trim().max(200).optional(), clientKey: z.string().min(8).max(64).optional() }).parse(req.body);
  const { supply, repeated } = await createSupply(req.auth!.userId, b);
  if (!repeated) await AuditLog.create({ actorId: req.auth!.userId, action: 'STOCK_SUPPLIED', entity: 'Franchise', entityId: b.franchiseId, after: { supplyId: supply._id, totalCostPaise: supply.totalCostPaise, lines: b.lines.length } });
  res.status(repeated ? 200 : 201).json({ id: supply._id.toString(), totalRetailPaise: supply.totalRetailPaise, totalCostPaise: supply.totalCostPaise, repeated });
};

export const adminSupplies = async (req: Request, res: Response) => {
  const q = z.object({ ...page, franchiseId: z.string().length(24).optional() }).parse(req.query);
  res.json(await listSupplies(q.franchiseId ? oid(q.franchiseId, 'Franchise not found') : null, q));
};

export const adminAdjustStock = async (req: Request, res: Response) => {
  const b = z.object({ itemType: z.enum(StockItemTypes), itemId: z.string().length(24), quantity: z.number().int().refine((n) => n !== 0, 'Quantity cannot be zero'), reason: z.string().trim().min(3).max(200) }).parse(req.body);
  const id = oid(req.params.franchiseId as string, 'Franchise not found').toString();
  const row = await adjustStock(req.auth!.userId, id, b);
  await AuditLog.create({ actorId: req.auth!.userId, action: 'STOCK_ADJUSTED', entity: 'Franchise', entityId: id, after: b });
  res.json({ quantity: row.quantity });
};
