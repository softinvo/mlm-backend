import { Commission, Franchise, FranchiseLedgerEntry, FranchiseRecharge, FranchiseTier, FundRequest, Member, Wallet, Withdrawal } from './models';

/** Idempotent upgrades for databases created before a feature existed. Safe to run on every start. */
export async function migrate() {
  // Franchises are prepaid now: older tiers had a sales share instead of a discount, and older franchises had no balance.
  await FranchiseTier.updateMany({ discountPercent: { $exists: false } }, { $set: { discountPercent: 0 }, $unset: { commissionPercent: '' } });
  await Franchise.updateMany({ prepaidBalancePaise: { $exists: false } }, { $set: { prepaidBalancePaise: 0 } });
  // Plan level decides who can manage whom (Premium > Standard > Mini). Name the known plans; anything else stays level 1.
  for (const [name, rank] of [['Mini', 1], ['Standard', 2], ['Premium', 3]] as const) await FranchiseTier.updateOne({ name, rank: { $exists: false } }, { $set: { rank } });
  // Commissions now carry a kind (joining vs repurchase), so the unique index includes it.
  await Commission.updateMany({ kind: { $exists: false } }, { $set: { kind: 'JOINING' } });
  await Commission.syncIndexes();
  await FranchiseLedgerEntry.syncIndexes();
  await FranchiseRecharge.syncIndexes();

  // Wallets used to be one per user with no type; they are now one per (user, type).
  await Wallet.updateMany({ type: { $exists: false } }, { $set: { type: 'INCOME' } });
  await Wallet.syncIndexes();

  // Top-ups and withdrawals now record the member's franchise so franchises only see their own.
  const fix = async (model: typeof FundRequest | typeof Withdrawal, userOf: (doc: any) => Promise<unknown>) => {
    for (const doc of await (model as typeof FundRequest).find({ franchiseId: { $exists: false } }).limit(5000)) {
      const userId = await userOf(doc);
      const m: { franchiseId?: unknown } | null = userId ? await Member.findOne({ userId }).select('franchiseId').lean() : null;
      if (m?.franchiseId) await (model as typeof FundRequest).updateOne({ _id: doc._id }, { $set: { franchiseId: m.franchiseId as any } });
    }
  };
  await fix(FundRequest, async (d) => d.userId);
  await fix(Withdrawal, async (d) => (await Wallet.findById(d.walletId).select('userId'))?.userId);
}
