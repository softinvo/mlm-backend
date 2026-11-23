/**
 * Franchise STOCK. The head office SUPPLIES joining kits (packages) and repurchase products to a franchise; the franchise
 * sells them to members. A franchise can only sell what it holds.
 *   - Supply:   stock goes up and the franchise's prepaid balance is charged retail price less its plan discount.
 *   - Sale:     stock goes down when the sale is made (so two sales can never sell the same unit) and back up if the
 *               sale is cancelled or fully refunded.
 * `moveStock` is the only place stock changes; every change is logged in StockMovement.
 */
import { ClientSession, Types } from 'mongoose';
import { Franchise, FranchiseStock, Order, Package, Product, StockItemType, StockMovement, StockMovementType, Supply } from '../models';
import { HttpError } from '../utils/http';
import { withTx } from '../utils/tx';
import { discountFor, postFranchiseEntry, wholesale } from './prepaid.service';

export const LOW_STOCK = 5; // at or below this many units an item counts as running low
export interface StockAlert { itemType: StockItemType; name: string; quantity: number }
const inr = (p: number) => `₹${(p / 100).toFixed(2)}`;
export const itemKey = (t: string, id: unknown) => `${t}:${String(id)}`;

async function describeItem(itemType: StockItemType, itemId: Types.ObjectId | string) {
  if (itemType === 'PACKAGE') { const p = await Package.findById(itemId).select('name pricePaise active'); return p && { name: p.name, sku: undefined as string | undefined, unitPricePaise: p.pricePaise, active: p.active }; }
  const p = await Product.findById(itemId).select('name sku mrpPaise active');
  return p && { name: p.name, sku: p.sku as string | undefined, unitPricePaise: p.mrpPaise, active: p.active };
}

export interface Move { franchiseId: Types.ObjectId | string; itemType: StockItemType; itemId: Types.ObjectId | string; quantity: number; type: StockMovementType; refType?: string; refId?: Types.ObjectId; key: string; note?: string; createdBy?: string }

/** The ONLY place stock changes. A removal that would take stock below zero fails (atomically), so a unit can never be sold twice. */
export async function moveStock(session: ClientSession, m: Move) {
  if (!Number.isInteger(m.quantity) || m.quantity === 0) throw new HttpError(400, 'Quantity must be a non-zero whole number');
  const key = { franchiseId: m.franchiseId, itemType: m.itemType, itemId: m.itemId };
  let row;
  if (m.quantity < 0) {
    row = await FranchiseStock.findOneAndUpdate({ ...key, quantity: { $gte: -m.quantity } }, { $inc: { quantity: m.quantity } }, { new: true, session });
    if (!row) {
      const have = (await FranchiseStock.findOne(key).session(session))?.quantity ?? 0;
      const d = await describeItem(m.itemType, m.itemId);
      throw new HttpError(400, `Not enough stock of ${d?.name ?? 'this item'}: you have ${have}, this needs ${-m.quantity}.`);
    }
  } else {
    row = await FranchiseStock.findOneAndUpdate(key, { $inc: { quantity: m.quantity } }, { new: true, upsert: true, session });
  }
  await StockMovement.create([{ ...key, type: m.type, quantity: m.quantity, balanceAfter: row.quantity, refType: m.refType, refId: m.refId, idempotencyKey: m.key, note: m.note, createdBy: m.createdBy }], { session });
  return row;
}

const orderLines = (o: InstanceType<typeof Order>) => o.items.map((it, i) => ({ i, itemType: (it.packageId ? 'PACKAGE' : 'PRODUCT') as StockItemType, itemId: (it.packageId ?? it.productId)!, quantity: it.quantity }));

/** Takes a franchise sale's items out of the franchise's stock (inside the transaction that creates the order). */
export async function reserveOrderStock(session: ClientSession, order: InstanceType<typeof Order>) {
  for (const l of orderLines(order)) {
    await moveStock(session, { franchiseId: order.franchiseId, itemType: l.itemType, itemId: l.itemId, quantity: -l.quantity, type: 'SALE', refType: 'Order', refId: order._id, key: `sale:${order._id}:${l.i}` });
  }
}

/** Puts a cancelled / fully refunded franchise sale's items back. Safe to call twice. */
export async function restockOrder(session: ClientSession, order: InstanceType<typeof Order>, note: string) {
  if (!order.soldByFranchise) return;
  const claimed = await Order.findOneAndUpdate({ _id: order._id, stockReturned: { $ne: true } }, { $set: { stockReturned: true } }, { session });
  if (!claimed) return;
  for (const l of orderLines(order)) {
    await moveStock(session, { franchiseId: order.franchiseId, itemType: l.itemType, itemId: l.itemId, quantity: l.quantity, type: 'SALE_RETURN', refType: 'Order', refId: order._id, key: `saleret:${order._id}:${l.i}`, note });
  }
}

// ───────── Supply (head office → franchise) ─────────

export interface SupplyInput { franchiseId: string; lines: { itemType: StockItemType; itemId: string; quantity: number }[]; note?: string; clientKey?: string; fromFranchiseId?: string }

/** Prices a supply without saving it (used for the preview and by createSupply). The receiver is charged at ITS plan discount. */
export async function priceSupply(franchiseId: string, lines: SupplyInput['lines']) {
  if (!lines.length) throw new HttpError(400, 'Add at least one item');
  const discountPercent = await discountFor(franchiseId);
  const seen = new Set<string>();
  const priced = [];
  for (const l of lines) {
    const k = itemKey(l.itemType, l.itemId);
    if (seen.has(k)) throw new HttpError(400, 'Each item can appear only once in a supply');
    seen.add(k);
    if (!Number.isInteger(l.quantity) || l.quantity < 1 || l.quantity > 100_000) throw new HttpError(400, 'Quantity must be between 1 and 100000');
    const d = await describeItem(l.itemType, l.itemId);
    if (!d || !d.active) throw new HttpError(400, 'One of the items is not in the active catalog');
    const retailPaise = d.unitPricePaise * l.quantity;
    priced.push({ itemType: l.itemType, itemId: new Types.ObjectId(l.itemId), name: d.name, sku: d.sku, quantity: l.quantity, unitPricePaise: d.unitPricePaise, retailPaise, costPaise: wholesale(retailPaise, discountPercent) });
  }
  return { discountPercent, lines: priced, totalRetailPaise: priced.reduce((n, l) => n + l.retailPaise, 0), totalCostPaise: priced.reduce((n, l) => n + l.costPaise, 0) };
}

/**
 * A supply of stock to a franchise, charged to ITS prepaid balance at retail less its plan discount.
 *  - From the head office (no `fromFranchiseId`): the stock is new to the franchise.
 *  - From a franchise (`fromFranchiseId`): the stock moves out of that franchise's own stock, and the amount charged to the
 *    receiver is credited to the sender's balance. Both balances are held by the company, so this is an internal transfer.
 *    The sender must manage the receiver (a lower plan below it); the caller checks that.
 */
export async function createSupply(actorId: string, i: SupplyInput) {
  const fr = await Franchise.findOne({ _id: i.franchiseId, active: true }).select('code prepaidBalancePaise');
  if (!fr) throw new HttpError(400, 'Choose an active franchise');
  if (i.fromFranchiseId && i.fromFranchiseId === i.franchiseId) throw new HttpError(400, 'A franchise cannot supply itself');
  const from = i.fromFranchiseId ? await Franchise.findOne({ _id: i.fromFranchiseId, active: true }).select('code') : null;
  if (i.fromFranchiseId && !from) throw new HttpError(400, 'The supplying franchise is not active');
  if (i.clientKey) { const again = await Supply.findOne({ franchiseId: i.franchiseId, clientKey: i.clientKey }); if (again) return { supply: again, repeated: true }; }
  const p = await priceSupply(i.franchiseId, i.lines);
  if (fr.prepaidBalancePaise < p.totalCostPaise) {
    throw new HttpError(400, from
      ? `${fr.code}’s prepaid balance does not cover this supply (${inr(p.totalCostPaise)}). Ask them to recharge, or send less.`
      : `${fr.code} has ${inr(fr.prepaidBalancePaise)} prepaid, but this supply costs ${inr(p.totalCostPaise)}. They need to recharge first.`);
  }
  try {
    const supply = await withTx(async (session) => {
      const [s] = await Supply.create([{ franchiseId: fr._id, fromFranchiseId: from?._id, lines: p.lines, discountPercent: p.discountPercent, totalRetailPaise: p.totalRetailPaise, totalCostPaise: p.totalCostPaise, note: i.note, createdBy: actorId, clientKey: i.clientKey }], { session });
      const who = from ? `from ${from.code}` : 'by the company';
      await postFranchiseEntry(session, { franchiseId: fr._id, amountPaise: -p.totalCostPaise, type: 'SUPPLY_COST', refType: 'Supply', refId: s._id, key: `supply:${s._id}`, note: `Stock supplied ${who} (${p.discountPercent}% discount)${i.note ? ` · ${i.note}` : ''}` }, true);
      if (from) await postFranchiseEntry(session, { franchiseId: from._id, amountPaise: p.totalCostPaise, type: 'SUPPLY_PROCEEDS', refType: 'Supply', refId: s._id, key: `supplyin:${s._id}`, note: `Stock supplied to ${fr.code}` });
      for (const [n, l] of p.lines.entries()) {
        if (from) await moveStock(session, { franchiseId: from._id, itemType: l.itemType, itemId: l.itemId, quantity: -l.quantity, type: 'TRANSFER_OUT', refType: 'Supply', refId: s._id, key: `supplyout:${s._id}:${n}`, note: `Supplied to ${fr.code}`, createdBy: actorId });
        await moveStock(session, { franchiseId: fr._id, itemType: l.itemType, itemId: l.itemId, quantity: l.quantity, type: 'SUPPLY', refType: 'Supply', refId: s._id, key: `supply:${s._id}:${n}`, note: from ? `From ${from.code}${i.note ? ` · ${i.note}` : ''}` : i.note, createdBy: actorId });
      }
      return s;
    });
    return { supply, repeated: false };
  } catch (e: any) {
    if (e?.code === 11000 && i.clientKey) { const again = await Supply.findOne({ franchiseId: i.franchiseId, clientKey: i.clientKey }); if (again) return { supply: again, repeated: true }; }
    throw e;
  }
}

/** A correction by the head office (e.g. damaged or counted stock). No money moves. A reason is required. */
export async function adjustStock(adminId: string, franchiseId: string, i: { itemType: StockItemType; itemId: string; quantity: number; reason: string }) {
  if (!(await Franchise.exists({ _id: franchiseId }))) throw new HttpError(404, 'Franchise not found');
  if (!(await describeItem(i.itemType, i.itemId))) throw new HttpError(400, 'Item not found');
  return withTx((session) => moveStock(session, { franchiseId, itemType: i.itemType, itemId: i.itemId, quantity: i.quantity, type: 'ADJUSTMENT', key: `stockadj:${new Types.ObjectId()}`, note: i.reason, createdBy: adminId }));
}

// ───────── Reading ─────────

/** What a franchise holds, with names and retail prices. Includes catalog items it has none of when `all` is set (for the sell screen). */
export async function stockOf(franchiseId: Types.ObjectId | string, opts: { all?: boolean } = {}) {
  const rows = await FranchiseStock.find({ franchiseId }).lean();
  const [packages, products] = await Promise.all([
    Package.find(opts.all ? { active: true } : { _id: { $in: rows.filter((r) => r.itemType === 'PACKAGE').map((r) => r.itemId) } }).select('name description pricePaise active imageUrl').lean(),
    Product.find(opts.all ? { active: true } : { _id: { $in: rows.filter((r) => r.itemType === 'PRODUCT').map((r) => r.itemId) } }).select('name sku mrpPaise active imageUrl').lean(),
  ]);
  const qty = (t: string, id: unknown) => rows.find((r) => r.itemType === t && String(r.itemId) === String(id))?.quantity ?? 0;
  const items = [
    ...packages.map((p) => ({ itemType: 'PACKAGE' as const, kind: 'JOINING', id: p._id.toString(), name: p.name, sku: null as string | null, pricePaise: p.pricePaise, imageUrl: p.imageUrl ?? '', active: p.active, quantity: qty('PACKAGE', p._id) })),
    ...products.map((p) => ({ itemType: 'PRODUCT' as const, kind: 'REPURCHASE', id: p._id.toString(), name: p.name, sku: p.sku as string | null, pricePaise: p.mrpPaise, imageUrl: p.imageUrl ?? '', active: p.active, quantity: qty('PRODUCT', p._id) })),
  ].sort((a, b) => (a.itemType === b.itemType ? a.name.localeCompare(b.name) : a.itemType === 'PACKAGE' ? -1 : 1));
  return { items, totalUnits: items.reduce((n, i) => n + i.quantity, 0), valuePaise: items.reduce((n, i) => n + i.quantity * i.pricePaise, 0) };
}

export async function listMovements(franchiseId: Types.ObjectId | string, q: { page: number; limit: number }) {
  const filter = { franchiseId };
  const [rows, total] = await Promise.all([StockMovement.find(filter).sort({ createdAt: -1, _id: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(), StockMovement.countDocuments(filter)]);
  const [pk, pr] = await Promise.all([Package.find({ _id: { $in: rows.filter((r) => r.itemType === 'PACKAGE').map((r) => r.itemId) } }).select('name').lean(), Product.find({ _id: { $in: rows.filter((r) => r.itemType === 'PRODUCT').map((r) => r.itemId) } }).select('name').lean()]);
  const name = (t: string, id: unknown) => (t === 'PACKAGE' ? pk : pr).find((x) => String(x._id) === String(id))?.name ?? 'Item';
  return {
    items: rows.map((r) => ({ id: r._id.toString(), createdAt: r.createdAt, type: r.type, itemType: r.itemType, name: name(r.itemType, r.itemId), quantity: r.quantity, balanceAfter: r.balanceAfter, note: r.note ?? null })),
    total, page: q.page, limit: q.limit, pages: Math.max(1, Math.ceil(total / q.limit)),
  };
}

export async function listSupplies(franchiseId: Types.ObjectId | string | null, q: { page: number; limit: number }) {
  const filter = franchiseId ? { $or: [{ franchiseId }, { fromFranchiseId: franchiseId }] } : {};
  const [rows, total] = await Promise.all([Supply.find(filter).sort({ createdAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(), Supply.countDocuments(filter)]);
  const frs = await Franchise.find({ _id: { $in: rows.flatMap((r) => [r.franchiseId, r.fromFranchiseId].filter(Boolean) as Types.ObjectId[]) } }).select('code name').lean();
  const fr = (id?: Types.ObjectId | null) => { const f = id && frs.find((x) => x._id.equals(id)); return f ? { code: f.code, name: f.name } : null; };
  return {
    items: rows.map((r) => ({
      id: r._id.toString(), createdAt: r.createdAt, note: r.note ?? null, discountPercent: r.discountPercent, totalRetailPaise: r.totalRetailPaise, totalCostPaise: r.totalCostPaise,
      franchise: fr(r.franchiseId), from: r.fromFranchiseId ? fr(r.fromFranchiseId) : null,
      direction: franchiseId && r.fromFranchiseId && String(r.fromFranchiseId) === String(franchiseId) ? 'OUT' : 'IN',
      lines: r.lines.map((l) => ({ itemType: l.itemType, name: l.name, sku: l.sku ?? null, quantity: l.quantity, unitPricePaise: l.unitPricePaise, costPaise: l.costPaise })),
    })),
    total, page: q.page, limit: q.limit, pages: Math.max(1, Math.ceil(total / q.limit)),
  };
}

/** Headline stock numbers for the overview: units, retail worth, and how many catalog items are low (1-5 left) or out. Franchise = its own; null = everyone. */
export async function stockSummary(franchiseIds: (Types.ObjectId | string)[] | null) {
  if (!franchiseIds) {
    const o = await stockOverview();
    return { units: o.items.reduce((n, f) => n + f.units, 0), valuePaise: o.items.reduce((n, f) => n + f.valuePaise, 0), low: 0, out: o.items.filter((f) => f.active && f.units === 0).length, alerts: [] as StockAlert[] };
  }
  let units = 0, valuePaise = 0, low = 0, out = 0;
  const alerts: StockAlert[] = [];
  for (const id of franchiseIds) {
    const s = await stockOf(id, { all: true });
    units += s.totalUnits; valuePaise += s.valuePaise;
    for (const i of s.items) {
      if (!i.active) continue;
      if (i.quantity === 0) out++; else if (i.quantity <= LOW_STOCK) low++; else continue;
      alerts.push({ itemType: i.itemType, name: i.name, quantity: i.quantity });
    }
  }
  alerts.sort((a, b) => a.quantity - b.quantity || a.name.localeCompare(b.name)); // none first, then the fewest left
  return { units, valuePaise, low, out, alerts: alerts.slice(0, 10) };
}

/** One row per franchise for the admin: how much stock it holds and what that is worth at retail. */
export async function stockOverview() {
  const [frs, rows] = await Promise.all([Franchise.find().sort({ code: 1 }).select('code name active').lean(), FranchiseStock.find({ quantity: { $gt: 0 } }).lean()]);
  const [pk, pr] = await Promise.all([Package.find().select('pricePaise').lean(), Product.find().select('mrpPaise').lean()]);
  const price = (t: string, id: unknown) => (t === 'PACKAGE' ? pk.find((x) => String(x._id) === String(id))?.pricePaise : pr.find((x) => String(x._id) === String(id))?.mrpPaise) ?? 0;
  return {
    items: frs.map((f) => {
      const mine = rows.filter((r) => f._id.equals(r.franchiseId));
      return { id: f._id.toString(), code: f.code, name: f.name, active: f.active, lines: mine.length, units: mine.reduce((n, r) => n + r.quantity, 0), valuePaise: mine.reduce((n, r) => n + r.quantity * price(r.itemType, r.itemId), 0) };
    }),
  };
}
