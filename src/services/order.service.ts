import { Types } from 'mongoose';
import { Franchise, Order, Package, Product, ShipmentStatus, WalletPaymentRequest } from '../models';
import { HttpError } from '../utils/http';
import { completeDelivery, refundOrder } from './commission.service';
import { reserveOrderStock, restockOrder } from './stock.service';
import { withTx } from '../utils/tx';

export const SHIPMENT_FLOW: ShipmentStatus[] = ['PENDING', 'PACKED', 'SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED'];
const DAY = 86_400_000;

export interface AddressSnapshot { fullName: string; phone: string; line1: string; line2?: string; city: string; state: string; pincode: string }
export interface OrderItemInput { packageId?: string; productId?: string; quantity: number }
export interface PlaceOrderInput {
  buyerUserId: string;
  franchiseId: string | Types.ObjectId;
  items: OrderItemInput[];
  shippingAddress?: AddressSnapshot;
  clientKey?: string;
  soldByFranchise?: boolean;
  now?: Date;
}

/** Prices always come from the catalog, never from the client. Prices are tax-inclusive. */
export async function placeOrder(input: PlaceOrderInput) {
  const now = input.now ?? new Date();
  if (!input.items.length) throw new HttpError(400, 'Add at least one item');
  const franchise = await Franchise.findOne({ _id: input.franchiseId, active: true });
  if (!franchise) throw new HttpError(400, 'Fulfilling franchise is not available');

  const items = [];
  let total = 0;
  let net = 0;
  for (const it of input.items) {
    if (!Number.isInteger(it.quantity) || it.quantity < 1 || it.quantity > 50) throw new HttpError(400, 'Quantity must be between 1 and 50');
    let unit: number, tax: number, commissionable: boolean;
    if (it.packageId) {
      const p = await Package.findOne({ _id: it.packageId, active: true });
      if (!p) throw new HttpError(400, 'Package is not available');
      [unit, tax, commissionable] = [p.pricePaise, p.taxPercent ?? 0, true];
    } else if (it.productId) {
      const p = await Product.findOne({ _id: it.productId, active: true });
      if (!p) throw new HttpError(400, 'Product is not available');
      [unit, tax, commissionable] = [p.mrpPaise, p.taxPercent, p.commissionable];
    } else {
      throw new HttpError(400, 'Each item needs a packageId or productId');
    }
    const gross = unit * it.quantity;
    const lineNet = Math.round(gross / (1 + tax / 100));
    total += gross;
    net += lineNet;
    items.push({
      packageId: it.packageId, productId: it.productId, quantity: it.quantity, unitPricePaise: unit, taxPercent: tax,
      commissionableVolumePaise: commissionable ? lineNet : 0,
    });
  }

  const doc = {
    buyerId: input.buyerUserId, franchiseId: franchise._id, status: 'PLACED', items,
    subtotalPaise: net, taxPaise: total - net, totalPaise: total,
    shippingAddress: input.shippingAddress, clientKey: input.clientKey, soldByFranchise: input.soldByFranchise || undefined, createdAt: now,
    shipment: { status: 'PENDING', events: [{ status: 'PENDING', at: now, note: 'Order placed' }] },
  };
  if (!input.soldByFranchise) return Order.create(doc);
  // A franchise sale takes its items out of the franchise's stock in the same transaction, so it can only sell what it holds.
  return withTx(async (session) => {
    const [o] = await Order.create([doc], { session });
    await reserveOrderStock(session, o);
    return o;
  });
}

/** Confirms payment. Idempotent per gatewayRef. */
export async function payOrder(orderId: string, pay: { gateway: string; gatewayRef: string; amountPaise?: number; now?: Date }) {
  const now = pay.now ?? new Date();
  const order = await Order.findById(orderId);
  if (!order) throw new HttpError(404, 'Order not found');
  if (order.payments.some((p) => p.gatewayRef === pay.gatewayRef)) return order; // retry of the same payment
  if (order.status !== 'PLACED') throw new HttpError(409, `Order is already ${order.status}`);
  if ((pay.amountPaise ?? order.totalPaise) !== order.totalPaise) throw new HttpError(400, 'Payment amount does not match the order total');

  const updated = await Order.findOneAndUpdate(
    { _id: orderId, status: 'PLACED' },
    {
      $set: { status: 'PAID', paidAt: now },
      $push: { payments: { gateway: pay.gateway, gatewayRef: pay.gatewayRef, amountPaise: order.totalPaise, status: 'SUCCESS', createdAt: now } },
    },
    { new: true },
  );
  if (!updated) throw new HttpError(409, 'Order was updated by someone else, please retry');
  return updated;
}

export interface ShipmentUpdate { courier?: string; trackingId?: string; expectedDelivery?: Date; note?: string; now?: Date }

/** Moves the shipment forward. Reaching DELIVERED also creates the order's (pending) commissions. */
export async function advanceShipment(orderId: string, next: ShipmentStatus, u: ShipmentUpdate = {}) {
  const now = u.now ?? new Date();
  const order = await Order.findById(orderId);
  if (!order) throw new HttpError(404, 'Order not found');
  if (order.shipment?.status === 'DELIVERED') throw new HttpError(409, 'Shipment is already DELIVERED');
  if (order.status !== 'PAID') throw new HttpError(409, `Only paid orders can be shipped (order is ${order.status})`);

  const current = order.shipment?.status ?? 'PENDING';
  const from = SHIPMENT_FLOW.indexOf(current);
  const to = SHIPMENT_FLOW.indexOf(next);
  if (to < 0) throw new HttpError(400, `Cannot move a shipment to ${next}; use cancel or refund`);
  if (to <= from) throw new HttpError(409, `Shipment is already ${current}`);
  if (next === 'SHIPPED' && (!u.courier || !u.trackingId)) throw new HttpError(400, 'courier and trackingId are required when shipping');

  if (next === 'DELIVERED') {
    const delivered = await completeDelivery(orderId, now, { note: u.note });
    if (!delivered) throw new HttpError(409, 'Order was updated by someone else, please retry');
    return delivered;
  }

  const set: Record<string, unknown> = { 'shipment.status': next };
  if (next === 'SHIPPED') {
    set['shipment.courier'] = u.courier;
    set['shipment.trackingId'] = u.trackingId;
    set['shipment.expectedDelivery'] = u.expectedDelivery ?? new Date(now.getTime() + 4 * DAY);
  }
  const updated = await Order.findOneAndUpdate(
    { _id: orderId, status: 'PAID', 'shipment.status': current },
    { $set: set, $push: { 'shipment.events': { status: next, at: now, note: u.note } } },
    { new: true },
  );
  if (!updated) throw new HttpError(409, 'Order was updated by someone else, please retry');
  return updated;
}

/** Cancels an order that has not shipped. A paid order is fully refunded. No commission exists yet at this stage. */
export async function cancelOrder(orderId: string, reason: string, now = new Date()) {
  const order = await Order.findById(orderId);
  if (!order) throw new HttpError(404, 'Order not found');
  const shipStatus = order.shipment?.status ?? 'PENDING';
  if (!['PLACED', 'PAID'].includes(order.status) || !['PENDING', 'PACKED'].includes(shipStatus)) {
    throw new HttpError(409, 'Only orders that have not shipped can be cancelled');
  }
  if (order.status === 'PAID') return refundOrder(orderId, order.totalPaise - order.refundedPaise, reason, now);
  await WalletPaymentRequest.updateMany({ orderId, status: 'PENDING' }, { $set: { status: 'CANCELLED', decidedAt: now } });

  return withTx(async (session) => {
    const updated = await Order.findOneAndUpdate(
      { _id: orderId, status: 'PLACED' },
      { $set: { status: 'CANCELLED', 'shipment.status': 'CANCELLED' }, $push: { 'shipment.events': { status: 'CANCELLED', at: now, note: reason } } },
      { new: true, session },
    );
    if (!updated) throw new HttpError(409, 'Order was updated by someone else, please retry');
    await restockOrder(session, updated, `Order cancelled: ${reason}`); // the unsold goods go back on the franchise's shelf
    return updated;
  });
}
