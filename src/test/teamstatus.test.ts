import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import mongoose, { Types } from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Member, Order, User } from '../models';
import { getRankCriteria, purchaseStatus, rewardsStatus, saveRankCriteria } from '../services/teamstatus.service';

let rs: MongoMemoryReplSet;
before(async () => {
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(rs.getUri());
  await Promise.all(mongoose.modelNames().map((n) => mongoose.model(n).init()));
});
after(async () => { await mongoose.disconnect(); await rs.stop(); });

const DAY = 86_400_000;
const fr = new Types.ObjectId();
let root: any, a: any, b: any, c: any, ua: any, ub: any, uc: any;

async function mk(name: string, sponsor: any | null) {
  const u = await User.create({ role: 'MEMBER', status: 'ACTIVE', name, email: `${name}@t.com`, phone: String(9000000000 + Math.floor(Math.random() * 99999999)), passwordHash: 'x' });
  const m = await Member.create({ userId: u._id, memberCode: name.toUpperCase(), sponsorId: sponsor?._id ?? null, upline: sponsor ? [sponsor._id, ...sponsor.upline] : [], franchiseId: fr });
  return { u, m };
}
const order = (buyer: Types.ObjectId, total: number, o: { pkg?: boolean; status?: string; ago?: number; refunded?: number } = {}) =>
  Order.create({
    buyerId: buyer, franchiseId: fr, status: o.status ?? 'DELIVERED', subtotalPaise: total, taxPaise: 0, totalPaise: total, refundedPaise: o.refunded ?? 0,
    items: [{ ...(o.pkg ? { packageId: new Types.ObjectId() } : { productId: new Types.ObjectId() }), quantity: 1, unitPricePaise: total, commissionableVolumePaise: total }],
    createdAt: new Date(Date.now() - (o.ago ?? 1) * DAY),
  });

beforeEach(async () => {
  await Promise.all(mongoose.modelNames().map((n) => mongoose.model(n).deleteMany({})));
  const r = await mk('root', null); root = r.m;
  const x = await mk('amy', root); a = x.m; ua = x.u;
  const y = await mk('bob', a); b = y.m; ub = y.u;
  const z = await mk('cat', root); c = z.m; uc = z.u; // second direct, never buys
  void uc; void c;
});

describe('team purchase status', () => {
  it('totals the whole team, per level, net of refunds, and counts who bought recently', async () => {
    await order(ua._id, 55_000, { pkg: true, ago: 40 });
    await order(ua._id, 20_000, { ago: 3 });
    await order(ub._id, 100_000, { ago: 2, refunded: 40_000 });
    await order(ub._id, 99_000, { status: 'CANCELLED' });            // not counted
    const s = await purchaseStatus(root._id);
    assert.equal(s.totals.teamSize, 3);
    assert.equal(s.totals.buyers, 2);
    assert.equal(s.totals.orders, 3);
    assert.equal(s.totals.valuePaise, 55_000 + 20_000 + 60_000);
    assert.equal(s.totals.active, 2, 'amy and bob bought in the last 30 days');
    assert.equal(s.totals.recentOrders, 2);
    assert.deepEqual([s.levels[0].members, s.levels[0].buyers, s.levels[0].valuePaise], [2, 1, 75_000]);
    assert.deepEqual([s.levels[1].members, s.levels[1].valuePaise], [1, 60_000]);
    assert.equal(s.levels.length, 10);
    assert.equal(s.recent[0].buyerName, 'bob');
    assert.equal(s.recent.find((r) => r.kind === 'Joining package')!.buyerName, 'amy');
  });

  it('is empty for a member with no team', async () => {
    const s = await purchaseStatus(b._id);
    assert.equal(s.totals.teamSize, 0);
    assert.equal(s.recent.length, 0);
  });
});

describe('rewards & awards status', () => {
  it('shows rank progress against the head office requirements, without promoting anyone', async () => {
    await order(ua._id, 150_000, { ago: 3 });
    await order(ub._id, 50_000, { ago: 5 });
    assert.equal((await rewardsStatus(root._id)).configured, false, 'no requirements published yet');
    await saveRankCriteria([{ rank: 'SILVER', minTeamVolumePaise: 400_000, minActiveDirects: 1 }, { rank: 'GOLD', minTeamVolumePaise: 1_000_000, minActiveDirects: 3 }]);
    assert.equal((await getRankCriteria()).length, 2);
    const r = await rewardsStatus(root._id);
    assert.equal(r.rank, 'ASSOCIATE');
    assert.equal(r.next, 'SILVER');
    assert.equal(r.configured, true);
    assert.equal(r.stats.teamVolumePaise, 200_000);
    assert.equal(r.stats.activeDirects, 1);
    const silver = r.ladder.find((l) => l.rank === 'SILVER')!;
    assert.deepEqual([silver.progress!.volumePct, silver.progress!.directsPct, silver.progress!.met], [50, 100, false]);
    assert.equal(r.ladder.find((l) => l.rank === 'DIAMOND')!.requirement, null, 'no requirement published for it');
    assert.equal((await Member.findById(root._id))!.rank, 'ASSOCIATE', 'viewing progress never changes the rank');
  });
});
