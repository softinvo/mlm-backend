import { Request, Response } from 'express';
import { getMemberDashboard } from '../services/dashboard.service';

export const memberDashboard = async (req: Request, res: Response) => {
  res.json(await getMemberDashboard(req.auth!.userId));
};
