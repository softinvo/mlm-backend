// Dev-only seed: dummy users for every role, a commission plan, and orders that flow through the REAL
// order/commission services (so commissions, wallets and refunds are consistent).
//   npm run seed            create/refresh users, franchises, plan; add sample orders if there are none
//   npm run seed -- --fresh also wipe orders, commissions and wallet history first
// Writes to whatever MONGODB_URI points at. Refuses to run in production.
import bcrypt from 'bcryptjs';
import mongoose, { Types } from 'mongoose';
import { env } from './config/env';
import { migrate } from './migrate';
import {
  Commission, CommissionPlan, Franchise, FranchiseEarning, FundRequest, FranchiseLedgerEntry, FranchiseRecharge, SupportTicket, FranchiseStock, FranchiseTier, StockMovement, Supply, Member, Order, Package, Product, WalletPaymentRequest, Role, ShipmentStatus, ShippingAddress, User, Wallet, WalletEntry, Withdrawal, Zone,
} from './models';
import { approveDueCommissions, reconcileWallet, refundOrder } from './services/commission.service';
import { payDueCashback, saveCashbackSettings } from './services/cashback.service';
import { scopeOf } from './services/franchise.service';
import { confirmRecharge, createRecharge } from './services/prepaid.service';
import { createSupply } from './services/stock.service';
import { adminReply, createTicket } from './services/support.service';
import { createSale } from './services/sale.service';
import { approveFundRequest, rejectFundRequest, submitFundRequest } from './services/fund.service';
import { postEntry } from './services/ledger.service';
import { advanceShipment, cancelOrder, payOrder, placeOrder } from './services/order.service';
import { approveWithdrawal, markWithdrawalPaid, rejectWithdrawal, requestWithdrawal, reviewKyc, submitKyc, transferToShopping } from './services/wallet.service';
import { withTx } from './utils/tx';

const PASSWORD = 'Demo@1234';
const DAY = 86_400_000;

async function upsertUser(role: Role, name: string, email: string, phone: string) {
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const user = await User.findOneAndUpdate({ email }, { $set: { role, name, phone, passwordHash, status: 'ACTIVE' } }, { upsert: true, new: true });
  await Wallet.updateOne({ userId: user._id, type: 'INCOME' }, { $setOnInsert: { userId: user._id, type: 'INCOME' } }, { upsert: true });
  return user;
}

async function upsertMember(
  userId: Types.ObjectId, memberCode: string, franchiseId: Types.ObjectId,
  sponsor: { _id: Types.ObjectId; upline: Types.ObjectId[] } | null, rank: 'ASSOCIATE' | 'SILVER' = 'ASSOCIATE',
) {
  return Member.findOneAndUpdate(
    { memberCode },
    { $set: { userId, franchiseId, rank }, $setOnInsert: { sponsorId: sponsor?._id ?? null, upline: sponsor ? [sponsor._id, ...sponsor.upline] : [] } },
    { upsert: true, new: true },
  );
}

async function main() {
  if (process.env.NODE_ENV === 'production') throw new Error('Refusing to seed in production');
  await mongoose.connect(env.MONGODB_URI);
  console.log('Seeding database:', mongoose.connection.name, 'on', mongoose.connection.host);
  await migrate(); // bring an older database up to the current shape before writing to it

  // ── Users, franchises, member tree ──
  await upsertUser('SUPER_ADMIN', 'Super Admin', 'admin@demo.com', '9000000001');
  const zonalUser = await upsertUser('ZONAL_FRANCHISE', 'Zonal Owner', 'zonal@demo.com', '9000000002');
  const remoteUser = await upsertUser('REMOTE_FRANCHISE', 'Remote Owner', 'remote@demo.com', '9000000003');

  // Franchise types (admin-defined). Franchises are PREPAID: the discount is what they save on every sale.
  const tierOf = (name: string, rank: number, discountPercent: number, investmentPaise: number, maxMembers: number, dailyWalletSalesLimitPaise: number, description: string) =>
    FranchiseTier.findOneAndUpdate({ name }, { $set: { rank, discountPercent, investmentPaise, maxMembers, dailyWalletSalesLimitPaise, description, active: true } }, { upsert: true, new: true });
  const mini = await tierOf('Mini', 1, 3, 2_500_000, 100, 2_000_000, 'Small counter or kiosk: ₹25,000 stock investment, 3% discount');
  const standard = await tierOf('Standard', 2, 5, 10_000_000, 500, 10_000_000, 'Regular franchise: ₹1,00,000 stock investment, 5% discount');
  const premium = await tierOf('Premium', 3, 8, 50_000_000, 0, 0, 'Large franchise: ₹5,00,000 stock investment, 8% discount, no member or daily limits');

  const zone = await Zone.findOneAndUpdate({ name: 'West Zone' }, { $set: { states: ['Maharashtra', 'Gujarat'] } }, { upsert: true, new: true });
  const zonal = await Franchise.findOneAndUpdate(
    { code: 'ZF-WEST-01' },
    { $set: { type: 'ZONAL', name: 'West Zonal HQ', zoneId: zone._id, ownerUserId: zonalUser._id, address: 'Mumbai', tierId: premium._id } },
    { upsert: true, new: true },
  );
  const remote = await Franchise.findOneAndUpdate(
    { code: 'RF-PUN-01' },
    { $set: { type: 'REMOTE', name: 'Pune Remote Point', zoneId: zone._id, parentId: zonal._id, ownerUserId: remoteUser._id, address: 'Pune', tierId: standard._id } },
    { upsert: true, new: true },
  );

  const remote2User = await upsertUser('REMOTE_FRANCHISE', 'Remote Owner Mumbai', 'remote2@demo.com', '9000000004');
  const remote2 = await Franchise.findOneAndUpdate(
    { code: 'RF-MUM-01' },
    { $set: { type: 'REMOTE', name: 'Mumbai Remote Point', zoneId: zone._id, parentId: remote._id, ownerUserId: remote2User._id, address: 'Mumbai', tierId: mini._id } },
    { upsert: true, new: true },
  );

  const rootUser = await upsertUser('MEMBER', 'Root Member', 'root@demo.com', '9000000010');
  const root = await upsertMember(rootUser._id, 'MROOT0001', remote._id, null, 'SILVER');
  const demoUser = await upsertUser('MEMBER', 'Demo Member', 'member@demo.com', '9000000011');
  const demo = await upsertMember(demoUser._id, 'MDEMO0001', remote._id, root, 'SILVER');
  const aUser = await upsertUser('MEMBER', 'Asha Verma', 'asha@demo.com', '9000000012');
  const bUser = await upsertUser('MEMBER', 'Bilal Khan', 'bilal@demo.com', '9000000013');
  const a = await upsertMember(aUser._id, 'MDEMO0002', remote._id, demo);
  await upsertMember(bUser._id, 'MDEMO0003', remote._id, demo);
  const cUser = await upsertUser('MEMBER', 'Chitra Rao', 'chitra@demo.com', '9000000014');
  const c = await upsertMember(cUser._id, 'MDEMO0004', remote._id, a);
  const dUser = await upsertUser('MEMBER', 'Dev Patel', 'dev@demo.com', '9000000015'); // never orders -> non-active
  await upsertMember(dUser._id, 'MDEMO0005', remote._id, demo);
  const eUser = await upsertUser('MEMBER', 'Esha Nair', 'esha@demo.com', '9000000016');
  await upsertMember(eUser._id, 'MDEMO0006', remote._id, c);

  // A member of the OTHER franchise: Pune's franchise must never see her.
  const gitaUser = await upsertUser('MEMBER', 'Gita Shah', 'gita@demo.com', '9000000017');
  await upsertMember(gitaUser._id, 'MDEMO0007', remote2._id, root);

  // ── Catalog + a PLACEHOLDER commission plan (replace the numbers via POST /api/admin/commission-plans) ──
  const pkgA = await Package.findOneAndUpdate({ name: 'Package A' }, { $set: { description: 'Starter pack. Sample description: replace with the real product contents.', pricePaise: 55000, taxPercent: 0, active: true } }, { upsert: true, new: true });
  const pkgB = await Package.findOneAndUpdate({ name: 'Package B' }, { $set: { description: 'Family pack. Sample description: replace with the real product contents.', pricePaise: 105000, taxPercent: 0, active: true } }, { upsert: true, new: true });
  const sampleProducts: [string, string, number][] = [['RP-001', 'Sample Repurchase Product 1', 20000], ['RP-002', 'Sample Repurchase Product 2', 35000], ['RP-003', 'Sample Repurchase Product 3', 12000]];
  for (const [sku, name, mrpPaise] of sampleProducts) {
    await Product.findOneAndUpdate({ sku }, { $set: { name, description: 'Sample description: replace with the real product.', mrpPaise, taxPercent: 0, commissionable: true, active: true } }, { upsert: true });
  }
  if (!(await CommissionPlan.exists({}))) {
    await CommissionPlan.create({
      version: 1, effectiveFrom: new Date(0), active: true, maxPayoutPercentOfVolume: 50, // the plan pays 46% across 8 levels
      levels: [40, 1, 1, 1, 1, 1, 0.5, 0.5].map((percent, i) => ({ level: i + 1, percent, minRank: 'ASSOCIATE' })),
      // repurchase royalty on product purchases: 4% + 1%x5 + 0.5%x4 = 11% over 10 levels
      repurchaseLevels: [4, 1, 1, 1, 1, 1, 0.5, 0.5, 0.5, 0.5].map((percent, i) => ({ level: i + 1, percent, minRank: 'ASSOCIATE' })),
    });
  }

  // ── Shipping address book for the demo member ──
  if ((await ShippingAddress.countDocuments({ userId: demoUser._id })) === 0) {
    await ShippingAddress.create([
      { userId: demoUser._id, label: 'HOME', fullName: 'Demo Member', phone: '9000000011', line1: '12 MG Road, Flat 4B', line2: 'Near City Mall', city: 'Pune', state: 'Maharashtra', pincode: '411001', isDefault: true },
      { userId: demoUser._id, label: 'OFFICE', fullName: 'Demo Member', phone: '9000000011', line1: 'Tower 2, Business Park', city: 'Mumbai', state: 'Maharashtra', pincode: '400051', isDefault: false },
    ]);
  }

  // ── Orders (through the real services) ──
  if (process.argv.includes('--fresh')) {
    await Promise.all([Order.deleteMany({}), Commission.deleteMany({}), FranchiseEarning.deleteMany({}), WalletEntry.deleteMany({}), Withdrawal.deleteMany({}), FundRequest.deleteMany({}), WalletPaymentRequest.deleteMany({}), FranchiseLedgerEntry.deleteMany({}), SupportTicket.deleteMany({}), FranchiseStock.deleteMany({}), StockMovement.deleteMany({}), Supply.deleteMany({}), FranchiseRecharge.deleteMany({}), Wallet.deleteMany({ type: 'SHOPPING' })]);
    await Wallet.updateMany({}, { $set: { balancePaise: 0 } });
    await Franchise.updateMany({}, { $set: { prepaidBalancePaise: 0 } });
    console.log('Wiped orders, commissions and wallet history.');
  }

  if ((await Order.countDocuments({})) === 0) {
    const now = Date.now();
    const addr = { fullName: 'Demo Member', phone: '9000000011', line1: '12 MG Road, Flat 4B', line2: 'Near City Mall', city: 'Pune', state: 'Maharashtra', pincode: '411001' };
    const flow: ShipmentStatus[] = ['PENDING', 'PACKED', 'SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED'];
    const couriers = ['Delhivery', 'Blue Dart', 'DTDC'];
    let n = 0;

    /** Places an order `placedAgo` days ago and walks it through shipping up to `stage`. */
    const order = async (buyer: Types.ObjectId, pkg: typeof pkgA, placedAgo: number, stage: ShipmentStatus | 'CANCELLED',
      opts: { deliveredAgo?: number; address?: boolean; product?: boolean; refund?: { amount: number; ago: number } } = {}) => {
      const placed = new Date(now - placedAgo * DAY);
      const at = (k: number) => new Date(placed.getTime() + k * DAY);
      const i = n++;
      const o = await placeOrder({ buyerUserId: String(buyer), franchiseId: remote._id, items: [opts.product ? { productId: String(pkg._id), quantity: 2 } : { packageId: String(pkg._id), quantity: 1 }], shippingAddress: opts.address ? addr : undefined, now: placed });
      const id = String(o._id);
      await payOrder(id, { gateway: 'seed', gatewayRef: `seed-${id}`, now: placed });
      if (stage === 'CANCELLED') { await cancelOrder(id, 'Cancelled by customer', at(1)); return id; }
      for (let k = 1; k <= flow.indexOf(stage); k++) {
        const s = flow[k];
        await advanceShipment(id, s, {
          now: s === 'DELIVERED' && opts.deliveredAgo !== undefined ? new Date(now - opts.deliveredAgo * DAY) : at(k),
          courier: couriers[i % 3], trackingId: `TRK${7_000_000 + i * 1311}`,
        });
      }
      if (opts.refund) await refundOrder(id, opts.refund.amount, 'Customer return', new Date(now - opts.refund.ago * DAY));
      return id;
    };

    // Team purchases -> commissions for Demo (level 1/2/3) and Root. Covers every commission state:
    // Demo only: cashback is ON (packages included, because the sample orders are packages) so the Cashback page has data. Switch it off in Admin → Commission Plan.
    await saveCashbackSettings({ enabled: true, percentPerDay: 1, maxDays: 30, maxTotalPercent: 30, includePackages: true });
    await order(aUser._id, pkgA, 20, 'DELIVERED', { deliveredAgo: 17 });            // approved
    await order(aUser._id, pkgB, 30, 'DELIVERED', { deliveredAgo: 26, refund: { amount: 52500, ago: 20 } }); // approved, then half clawed back
    await order(bUser._id, pkgB, 12, 'DELIVERED', { deliveredAgo: 9 });             // approved
    await order(bUser._id, pkgA, 18, 'DELIVERED', { deliveredAgo: 15, refund: { amount: 55000, ago: 10 } }); // fully reversed
    await order(cUser._id, pkgA, 4, 'DELIVERED', { deliveredAgo: 2 });              // pending (cooling-off)
    // Repurchases (products) -> repurchase royalty, a separate stream from the joining packages above
    const rp1 = await Product.findOne({ sku: 'RP-001' }), rp2 = await Product.findOne({ sku: 'RP-002' });
    if (rp1 && rp2) {
      await order(aUser._id, rp1 as any, 14, 'DELIVERED', { deliveredAgo: 12, product: true });   // approved
      await order(bUser._id, rp2 as any, 10, 'DELIVERED', { deliveredAgo: 9, product: true });    // approved
      await order(cUser._id, rp1 as any, 4, 'DELIVERED', { deliveredAgo: 2, product: true });     // pending (cooling-off)
    }
    await order(cUser._id, pkgB, 1, 'PACKED');                                       // paid, not delivered: no commission yet

    // Demo member's own orders (shows in Shipping History; Root earns on the delivered ones).
    const plan: [ShipmentStatus | 'CANCELLED', number][] = [['PACKED', 1], ['SHIPPED', 3], ['OUT_FOR_DELIVERY', 5], ['CANCELLED', 12], ['DELIVERED', 20],
      ...Array.from({ length: 9 }, (_, k): [ShipmentStatus, number] => ['DELIVERED', 40 + k * 15])];
    for (const [k, [stage, ago]] of plan.entries()) await order(demoUser._id, k % 2 ? pkgA : pkgB, ago, stage, { address: true });

    console.log('Approved due commissions:', await approveDueCommissions());
    console.log('Cashback credited:', await payDueCashback());
  } else {
    console.log('Orders already exist, leaving them. Use `npm run seed -- --fresh` to rebuild.');
  }

  // ── Wallet demo data: verified payout account, withdrawals in every state, a shopping-wallet transfer ──
  if ((await Withdrawal.countDocuments({})) === 0) {
    await submitKyc(String(demoUser._id), { accountHolder: 'Demo Member', accountNumber: '123456789012', ifsc: 'HDFC0001234', pan: 'ABCDE1234F' });
    await reviewKyc(String(demoUser._id), 'VERIFIED', undefined, String(demoUser._id));
    // Dev-only top-up so there is enough balance to show a realistic history.
    await withTx((s) => postEntry(s, { userId: demoUser._id, wallet: 'INCOME', amountPaise: 50000, type: 'ADJUSTMENT', key: 'seed-opening-balance', note: 'Demo opening balance (dev seed)' }));

    const paid = await requestWithdrawal(String(demoUser._id), 20000);
    await approveWithdrawal(String(paid._id));
    await markWithdrawalPaid(String(paid._id), 'UTR2026111700123');
    const rejected = await requestWithdrawal(String(demoUser._id), 10000);
    await rejectWithdrawal(String(rejected._id), 'Bank account name does not match KYC');
    await requestWithdrawal(String(demoUser._id), 15000); // waiting
    await transferToShopping(String(demoUser._id), 10000);
  }

  // ── Deposits for the demo member: one credited, one rejected, one waiting ──
  if ((await FundRequest.countDocuments({})) === 0) {
    const adminUser = await User.findOne({ email: 'admin@demo.com' });
    const ago = (d: number) => new Date(Date.now() - d * 86_400_000);
    const me = String(demoUser._id);
    const ok = await submitFundRequest(me, { amountPaise: 100000, mode: 'NEFT', reference: 'NEFT20261109771', paidOn: ago(9) });
    await approveFundRequest(String(ok._id), String(adminUser!._id), { note: 'Matched' });
    const bad = await submitFundRequest(me, { amountPaise: 50000, mode: 'IMPS', reference: 'IMPS6120004455', paidOn: ago(4) });
    await rejectFundRequest(String(bad._id), String(adminUser!._id), 'Payment not found in the bank statement');
    await submitFundRequest(me, { amountPaise: 150000, mode: 'UPI', reference: 'UTR402611180099', paidOn: ago(1) });
  }

  // ── Work waiting for the franchises and the head office ──
  if ((await Order.countDocuments({ buyerId: gitaUser._id })) === 0) {
    const ago = (d: number) => new Date(Date.now() - d * 86_400_000);
    await submitKyc(String(bUser._id), { accountHolder: 'Bilal Khan', accountNumber: '00998877665544', ifsc: 'SBIN0001234', pan: 'BCDEF2345G' });   // Pune: bank details to verify
    await submitKyc(String(gitaUser._id), { accountHolder: 'Gita Shah', accountNumber: '55443322110099', ifsc: 'ICIC0000456', pan: 'CDEFG3456H' }); // Mumbai
    await submitFundRequest(String(gitaUser._id), { amountPaise: 75000, mode: 'UPI', reference: 'GITAUPI000123', paidOn: ago(1) });                  // Mumbai top-up
    await placeOrder({ buyerUserId: String(aUser._id), franchiseId: remote._id, items: [{ packageId: String(pkgA._id), quantity: 1 }] });           // Pune: unpaid order
    await placeOrder({ buyerUserId: String(gitaUser._id), franchiseId: remote2._id, items: [{ packageId: String(pkgB._id), quantity: 1 }] });       // Mumbai: unpaid order
  }

  // Franchise prepaid balances: each franchise recharged (confirmed by the head office), one more recharge is waiting.
  if (!(await FranchiseRecharge.exists({}))) {
    const adminUser = await User.findOne({ email: 'admin@demo.com' });
    const ago = (d: number) => new Date(Date.now() - d * 86_400_000);
    const top = async (franchiseId: Types.ObjectId, ownerId: Types.ObjectId, amountPaise: number, ref: string, days: number, confirm: boolean) => {
      const r = await createRecharge(franchiseId, String(ownerId), { amountPaise, mode: 'NEFT', reference: ref, paidOn: ago(days) });
      if (confirm) await confirmRecharge(String(adminUser!._id), String(r._id), { note: 'Matched in the bank statement' });
    };
    await top(remote._id, remoteUser._id, 10_000_000, 'NEFT-PUNE-0001', 12, true);   // ₹1,00,000
    await top(remote2._id, remote2User._id, 5_000_000, 'NEFT-MUM-0001', 10, true);   // ₹50,000
    await top(remote._id, remoteUser._id, 2_500_000, 'NEFT-PUNE-0002', 1, false);    // ₹25,000, waiting for confirmation
  }

  // The Premium head franchise funds its plan investment (also on databases seeded before it existed).
  if (!(await FranchiseLedgerEntry.exists({ franchiseId: zonal._id, type: 'RECHARGE' }))) {
    const adminUser = await User.findOne({ email: 'admin@demo.com' });
    const r = await createRecharge(zonal._id, String(zonalUser._id), { amountPaise: 50_000_000, mode: 'NEFT', reference: 'NEFT-WEST-0001', paidOn: new Date(Date.now() - 14 * 86_400_000) });
    await confirmRecharge(String(adminUser!._id), String(r._id), { note: 'Matched in the bank statement' });
  }

  // The head office supplies joining kits and repurchase products to each franchise (charged to its prepaid balance at retail less its discount).
  if (!(await Supply.exists({}))) {
    const adminUser = await User.findOne({ email: 'admin@demo.com' });
    const rp = await Product.find({ sku: { $in: ['RP-001', 'RP-002', 'RP-003'] } }).sort({ sku: 1 });
    const kit = (pkg: typeof pkgA, quantity: number) => ({ itemType: 'PACKAGE' as const, itemId: String(pkg._id), quantity });
    const prod = (i: number, quantity: number) => ({ itemType: 'PRODUCT' as const, itemId: String(rp[i]._id), quantity });
    await createSupply(String(adminUser!._id), { franchiseId: String(zonal._id), note: 'Opening stock', lines: [kit(pkgA, 100), kit(pkgB, 50), prod(0, 100), prod(1, 100), prod(2, 100)] });
    await createSupply(String(adminUser!._id), { franchiseId: String(remote._id), note: 'Opening stock', lines: [kit(pkgA, 40), kit(pkgB, 20), prod(0, 50)] });
    await createSupply(String(adminUser!._id), { franchiseId: String(remote2._id), note: 'Opening stock', lines: [kit(pkgA, 20), kit(pkgB, 10), prod(0, 30)] });
    // One counter sale: Bilal buys a joining kit at the Pune franchise, paid in cash. It comes out of Pune's stock.
    if (!(await Order.exists({ 'payments.gatewayRef': 'FC-RCPTSEED0001' }))) await createSale(await scopeOf(String(remoteUser._id)), String(remoteUser._id), { memberCode: 'MDEMO0003', items: [{ packageId: String(pkgA._id), quantity: 1 }], payment: { type: 'COUNTER', method: 'CASH', reference: 'RCPT-SEED-0001' } });
  }

  // Franchise-to-franchise: West HQ (Premium) supplies stock to Pune (Standard), which it manages. Pune is charged at its 5% discount and HQ is credited.
  if (!(await Supply.exists({ fromFranchiseId: { $exists: true } }))) {
    const rp1 = await Product.findOne({ sku: 'RP-001' });
    await createSupply(String(zonalUser._id), { franchiseId: String(remote._id), fromFranchiseId: String(zonal._id), note: 'Monthly top-up from West HQ', lines: [{ itemType: 'PACKAGE', itemId: String(pkgA._id), quantity: 10 }, { itemType: 'PRODUCT', itemId: String(rp1!._id), quantity: 20 }] });
  }

  // A franchise sale waiting for the member to approve in their app (demo member, Pune franchise).
  if (!(await WalletPaymentRequest.exists({ memberUserId: demoUser._id }))) {
    const rp = await Product.findOne({ sku: 'RP-001' });
    await createSale(await scopeOf(String(remoteUser._id)), String(remoteUser._id), { memberCode: 'MDEMO0001', items: [{ productId: String(rp!._id), quantity: 1 }], payment: { type: 'WALLET' } });
  }

  // Help & support: a few tickets so the desk and both portals have something to show.
  if (!(await SupportTicket.exists({}))) {
    const adminUser = await User.findOne({ email: 'admin@demo.com' });
    const aid = String(adminUser!._id);
    const t1 = await createTicket(String(demoUser._id), { category: 'WITHDRAWAL', subject: 'Withdrawal still pending after 3 days', message: 'I asked for a withdrawal of ₹1,000 three days ago and it still shows pending. Can you check?' });
    await adminReply(aid, t1.id, { body: 'Thanks for flagging this. Your bank details are verified, but the IFSC looks mistyped. Could you confirm the IFSC printed on your cheque book?' });
    const t2 = await createTicket(String(demoUser._id), { category: 'ORDER', subject: 'Order delivered to the wrong city', message: 'The courier marked my last order delivered, but I live in Pune and it went to Mumbai.', priority: 'HIGH', orderRef: '#8F0D12' });
    await adminReply(aid, t2.id, { body: 'We have asked the courier to redeliver it to your Pune address.', internal: true });
    await createTicket(String(remoteUser._id), { category: 'STOCK', subject: 'Running low on Package A, please supply 30 more', message: 'We sold 18 joining kits this week and only have 22 left. Please supply 30 more Package A and 40 of Sample Repurchase Product 1.', priority: 'HIGH' });
    const t4 = await createTicket(String(remote2User._id), { category: 'RECHARGE', subject: 'Recharge of ₹50,000 not showing', message: 'I paid ₹50,000 by NEFT on Monday (UTR NEFT-MUM-0001) but I cannot see it in my prepaid balance.' });
    await adminReply(aid, t4.id, { body: 'Matched with our bank statement and credited. Please check your balance.', status: 'RESOLVED' });
  }

  // ── Report ──
  for (const [name, uid] of [['Demo', demoUser._id], ['Root', rootUser._id], ['Asha', aUser._id], ['Chitra', cUser._id]] as const) {
    const [wallet, rec] = await Promise.all([Wallet.findOne({ userId: uid, type: 'INCOME' }), reconcileWallet(uid)]);
    console.log(`  ${name.padEnd(7)} wallet ₹${((wallet?.balancePaise ?? 0) / 100).toFixed(2).padStart(9)}  ledger ${rec?.ok ? 'OK' : 'MISMATCH'}`);
  }
  const by = await Commission.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]);
  console.log('Commissions by status:', Object.fromEntries(by.map((s) => [s._id, s.n])));
  console.log(`\nAll dummy accounts use password: ${PASSWORD}`);
  console.table([
    ['SUPER_ADMIN', 'admin@demo.com'], ['ZONAL_FRANCHISE', 'zonal@demo.com'], ['REMOTE_FRANCHISE (Pune)', 'remote@demo.com'], ['REMOTE_FRANCHISE (Mumbai)', 'remote2@demo.com'],
    ['MEMBER (dashboard data)', 'member@demo.com'], ['MEMBER (root sponsor MROOT0001)', 'root@demo.com'],
  ]);
  console.log('Signup test codes -> sponsor: MROOT0001, franchise: RF-PUN-01');
  await mongoose.disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
