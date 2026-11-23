import { Request, Response } from 'express';
import { z } from 'zod';
import { exportTeamCsv, getMemberId, listTeam, SORT_KEYS, teamSummary } from '../services/team.service';

const query = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(50).optional(),
  status: z.enum(['all', 'active', 'inactive']).default('all'),
  level: z.coerce.number().int().min(1).max(50).optional(),
  sort: z.enum(SORT_KEYS).default('joined'),
  dir: z.enum(['asc', 'desc']).default('desc'),
});

/** Level 1 only. */
export const myDirects = async (req: Request, res: Response) => {
  const q = query.parse(req.query);
  const memberId = await getMemberId(req.auth!.userId);
  res.json(await listTeam({ ...q, memberId, level: 1 }));
};

/** Whole downline, optionally one level; includes per-level summary for the overview. */
export const levelTeam = async (req: Request, res: Response) => {
  const q = query.parse(req.query);
  const memberId = await getMemberId(req.auth!.userId);
  const [list, summary] = await Promise.all([listTeam({ ...q, memberId }), teamSummary(memberId)]);
  res.json({ ...list, summary });
};

/** Same filters as the level list, returned as a CSV download. */
export const levelTeamCsv = async (req: Request, res: Response) => {
  const q = query.parse(req.query);
  const memberId = await getMemberId(req.auth!.userId);
  const csv = await exportTeamCsv({ ...q, memberId });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="level-team.csv"');
  res.send(csv);
};

/** Downline members with no recent paid/delivered order. */
export const nonActiveTeam = async (req: Request, res: Response) => {
  const q = query.parse(req.query);
  const memberId = await getMemberId(req.auth!.userId);
  const [list, summary] = await Promise.all([
    listTeam({ ...q, memberId, status: 'inactive' }),
    teamSummary(memberId),
  ]);
  res.json({ ...list, windowDays: summary.windowDays, inactiveTotal: summary.inactive });
};
