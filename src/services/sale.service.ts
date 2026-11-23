import { Types } from 'mongoose';
import { Franchise, Member, Order, User, WalletPaymentRequest } from '../models';
import { HttpError } from '../utils/http';
import type { Scope } from './franchise.service';
import { cancelOrder, OrderItemInput, placeOrder } from './order.service';
import { createWalletRequest } from './payment-request.service';
import { issueOtp } from './otp.service';
import { payAtCounter } from './prepaid.service';

const orderNo = (id: { toString(): string }) => '#' + id.toString().slice(-6).toUpperCase();

/** A franchise finds a member by their member ID before selling to them. */
export async function lookupMember(code: string) {
  const m = await Member.findOne({ memberCode: code.trim().toUpperCase() });
  const u = m && (await User.findById(m.userId).select('name phone status'));
  if (!m || !u || u.status !== 'ACTIVE') throw new HttpError(404, 'No active member found with that ID');
  return { memberCode: m.memberCode, name: u.name, phoneLast4: u.phone.slice(-4) };
}

export type SalePayment = { type: 'WALLET' } | { type: 'COUNTER'; method: 'CASH' | 'UPI' | 'BANK_TRANSFER'; reference: string; note?: string };

/**
 * A franchise sells a joining package or repurchase products to a member (prices come from the admin's catalog).
 *  - Stock: a franchise can only sell what the head office has supplied to it (see stock.service); placing the sale takes it off the shelf.
 *  - COUNTER: the franchise took cash/UPI/bank payment; it records the receipt and the order is paid at once.
 *  - WALLET:  the member is asked to approve paying from their shopping wallet in their own app.
 */
export async function createSale(scope: Scope, actorId: string, i: { franchiseId?: string; memberCode: string; items: OrderItemInput[]; payment: SalePayment; clientKey?: string }) {
  const franchiseId = i.franchiseId ? new Types.ObjectId(i.franchiseId) : new Types.ObjectId(scope.franchises[0].id);
  if (!scope.ownIds.some((x) => x.equals(franchiseId))) throw new HttpError(404, 'Franchise not found'); // you sell from your own prepaid balance, never a sub-franchise's
  const fr = await Franchise.findOne({ _id: franchiseId, active: true });
  if (!fr) throw new HttpError(400, 'That franchise is not active');

  const buyer = await lookupMember(i.memberCode);
  const member = await Member.findOne({ memberCode: buyer.memberCode });
  const buyerUserId = member!.userId.toString();

  if (i.clientKey) { // a retried submit returns the same sale instead of creating a second one
    const existing = await Order.findOne({ buyerId: buyerUserId, clientKey: i.clientKey });
    if (existing) return { orderId: existing._id.toString(), orderNo: orderNo(existing._id), totalPaise: existing.totalPaise, payment: i.payment.type, repeated: true };
  }

  let order;
  try {
    order = await placeOrder({ buyerUserId, franchiseId, items: i.items, clientKey: i.clientKey, soldByFranchise: true });
  } catch (e: any) {
    if (e?.code === 11000 && i.clientKey) { // two identical requests raced; the other one won
      const winner = await Order.findOne({ buyerId: buyerUserId, clientKey: i.clientKey });
      if (winner) return { orderId: winner._id.toString(), orderNo: orderNo(winner._id), totalPaise: winner.totalPaise, payment: i.payment.type, repeated: true };
    }
    throw e;
  }
  let walletRequestId: string | undefined;
  let otpSent: Awaited<ReturnType<typeof issueOtp>> | undefined;
  try {
    if (i.payment.type === 'WALLET') {
      const req = await createWalletRequest({ orderId: order._id, memberUserId: member!.userId, franchiseId, requestedBy: actorId, amountPaise: order.totalPaise });
      walletRequestId = req._id.toString();
      otpSent = await issueOtp({ userId: member!.userId.toString(), purpose: 'WALLET_SALE', ref: walletRequestId }); // the member gets a code and reads it out to the shop
    } else {
      await payAtCounter(order._id.toString(), i.payment); // marks the order PAID; the stock was already taken when the sale was made
    }
  } catch (e) {
    await WalletPaymentRequest.updateMany({ orderId: order._id, status: 'PENDING' }, { $set: { status: 'CANCELLED', decidedAt: new Date() } }).catch(() => {});
    await cancelOrder(order._id.toString(), 'Sale could not be completed').catch(() => {}); // never leave a half-made sale behind
    throw e;
  }
  return { orderId: order._id.toString(), orderNo: orderNo(order._id), totalPaise: order.totalPaise, payment: i.payment.type, repeated: false, member: { name: buyer.name, memberCode: buyer.memberCode }, requestId: walletRequestId, otp: otpSent };
}
