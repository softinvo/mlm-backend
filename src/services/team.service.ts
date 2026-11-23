import { PipelineStage, Types } from 'mongoose';
import { Member, Order, User } from '../models';
import { HttpError } from '../utils/http';

/** A team member is "active" if they have a paid/delivered order within this many days. */
export const ACTIVE_WINDOW_DAYS = 30;
const ACTIVE_ORDER_STATUSES = ['PAID', 'DELIVERED'];
const MIN_LEVELS = 10;
export const EXPORT_MAX_ROWS = 10_000;

export type StatusFilter = 'all' | 'active' | 'inactive';
export const SORT_KEYS = ['joined', 'level', 'name', 'status'] as const;
export type SortKey = (typeof SORT_KEYS)[number];
const SORT_FIELD: Record<SortKey, string> = { joined: 'joinedAt', level: 'level', name: 'user.name', status: 'active' };

export interface TeamFilter {
  memberId: Types.ObjectId;
  level?: number;
  status: StatusFilter;
  search?: string;
  sort: SortKey;
  dir: 'asc' | 'desc';
}
export interface TeamQuery extends TeamFilter { page: number; limit: number }

export async function getMemberId(userId: string): Promise<Types.ObjectId> {
  const member = await Member.findOne({ userId }).select('_id').lean();
  if (!member) throw new HttpError(404, 'Member profile not found');
  return member._id;
}

/** Everyone below `memberId`, annotated with level, user info and active flag. */
function downlinePipeline(memberId: Types.ObjectId, level?: number): PipelineStage[] {
  const cutoff = new Date(Date.now() - ACTIVE_WINDOW_DAYS * 86_400_000);
  return [
    { $match: { upline: memberId } },
    { $addFields: { level: { $add: [{ $indexOfArray: ['$upline', memberId] }, 1] } } },
    ...(level ? [{ $match: { level } } as PipelineStage] : []),
    {
      $lookup: {
        from: User.collection.name, localField: 'userId', foreignField: '_id', as: 'user',
        pipeline: [{ $project: { name: 1, phone: 1 } }],
      },
    },
    { $unwind: '$user' },
    {
      $lookup: {
        from: Order.collection.name, let: { uid: '$userId' }, as: 'recent',
        pipeline: [
          {
            $match: {
              $expr: { $eq: ['$buyerId', '$$uid'] },
              status: { $in: ACTIVE_ORDER_STATUSES },
              createdAt: { $gte: cutoff },
            },
          },
          { $limit: 1 },
          { $project: { _id: 1 } },
        ],
      },
    },
    { $addFields: { active: { $gt: [{ $size: '$recent' }, 0] } } },
  ];
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const maskPhone = (p?: string) => (p && p.length >= 4 ? `${p.slice(0, 2)}XXXXXX${p.slice(-2)}` : '');

/** Filter + sort stages shared by the list and the CSV export. */
function filterSortStages(q: TeamFilter): PipelineStage[] {
  const stages: PipelineStage[] = [];
  if (q.status !== 'all') stages.push({ $match: { active: q.status === 'active' } });
  if (q.search) {
    const rx = { $regex: escapeRegex(q.search), $options: 'i' };
    stages.push({ $match: { $or: [{ 'user.name': rx }, { memberCode: rx }] } });
  }
  const field = SORT_FIELD[q.sort];
  const d = q.dir === 'asc' ? 1 : -1;
  const sort: Record<string, 1 | -1> = { [field]: d };
  if (field !== 'joinedAt') sort.joinedAt = -1;
  sort._id = -1;
  stages.push({ $sort: sort });
  return stages;
}

/** Looks up who sponsored each row (run after pagination so it only touches one page). */
const sponsorStages = (): PipelineStage[] => [
  {
    $lookup: {
      from: Member.collection.name, localField: 'sponsorId', foreignField: '_id', as: 'sp',
      pipeline: [{ $project: { memberCode: 1, userId: 1 } }],
    },
  },
  { $unwind: { path: '$sp', preserveNullAndEmptyArrays: true } },
  {
    $lookup: {
      from: User.collection.name, localField: 'sp.userId', foreignField: '_id', as: 'spu',
      pipeline: [{ $project: { name: 1 } }],
    },
  },
  { $unwind: { path: '$spu', preserveNullAndEmptyArrays: true } },
  {
    $project: {
      _id: 0, id: { $toString: '$_id' }, memberCode: 1, name: '$user.name', phone: '$user.phone',
      rank: 1, level: 1, joinedAt: 1, active: 1,
      sponsorCode: { $ifNull: ['$sp.memberCode', null] }, sponsorName: { $ifNull: ['$spu.name', null] },
    },
  },
];

const collation = { locale: 'en', strength: 2 }; // case-insensitive name sort

export async function listTeam(q: TeamQuery) {
  const pipeline: PipelineStage[] = [
    ...downlinePipeline(q.memberId, q.level),
    ...filterSortStages(q),
    {
      $facet: {
        items: [{ $skip: (q.page - 1) * q.limit }, { $limit: q.limit }, ...(sponsorStages() as PipelineStage.FacetPipelineStage[])],
        total: [{ $count: 'n' }],
      },
    },
  ];
  const [res] = await Member.aggregate(pipeline).collation(collation);
  const total: number = res?.total[0]?.n ?? 0;
  const items = (res?.items ?? []).map((m: any) => ({ ...m, phone: maskPhone(m.phone) }));
  return { items, total, page: q.page, limit: q.limit, pages: Math.max(1, Math.ceil(total / q.limit)) };
}

/** Member counts per level, split by active/inactive. */
export async function teamSummary(memberId: Types.ObjectId) {
  const rows: { _id: { level: number; active: boolean }; n: number }[] = await Member.aggregate([
    ...downlinePipeline(memberId),
    { $group: { _id: { level: '$level', active: '$active' }, n: { $sum: 1 } } },
  ]);
  const maxLevel = Math.max(MIN_LEVELS, ...rows.map((r) => r._id.level));
  const levels = Array.from({ length: maxLevel }, (_, i) => {
    const level = i + 1;
    const active = rows.find((r) => r._id.level === level && r._id.active)?.n ?? 0;
    const inactive = rows.find((r) => r._id.level === level && !r._id.active)?.n ?? 0;
    return { level, total: active + inactive, active, inactive };
  });
  return {
    windowDays: ACTIVE_WINDOW_DAYS,
    total: levels.reduce((n, l) => n + l.total, 0),
    active: levels.reduce((n, l) => n + l.active, 0),
    inactive: levels.reduce((n, l) => n + l.inactive, 0),
    levels,
  };
}

// CSV cells starting with these characters can be executed as formulas by spreadsheet apps.
const csvCell = (v: unknown) => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Whole filtered team as CSV (mobile numbers masked, capped at EXPORT_MAX_ROWS). */
export async function exportTeamCsv(q: TeamFilter) {
  const rows = await Member.aggregate([
    ...downlinePipeline(q.memberId, q.level),
    ...filterSortStages(q),
    { $limit: EXPORT_MAX_ROWS },
    ...sponsorStages(),
  ]).collation(collation);

  const header = ['Member ID', 'Name', 'Level', 'Sponsor ID', 'Sponsor name', 'Rank', 'Joined', 'Mobile', 'Status'];
  const lines = rows.map((m: any) =>
    [
      m.memberCode, m.name, m.level, m.level === 1 ? 'You' : m.sponsorCode, m.level === 1 ? '' : m.sponsorName, m.rank,
      new Date(m.joinedAt).toISOString().slice(0, 10), maskPhone(m.phone), m.active ? 'Active' : 'Inactive',
    ].map(csvCell).join(','),
  );
  return '﻿' + [header.join(','), ...lines].join('\r\n') + '\r\n';
}
