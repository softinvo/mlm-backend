/**
 * Franchise hierarchy, decided by plan level (FranchiseTier.rank). Example: Premium 3 > Standard 2 > Mini 1.
 *   - A franchise may manage franchises on a LOWER plan only (Premium: Standard and Mini; Standard: Mini; Mini: none).
 *   - The head office can place any franchise under any franchise that outranks it, and manage everyone.
 * Because a parent always outranks its children, the tree can never loop.
 */
import { ClientSession, Types } from 'mongoose';
import { Franchise, FranchiseTier } from '../models';
import { HttpError } from '../utils/http';

export const rankOf = async (tierId?: Types.ObjectId | string | null, session?: ClientSession) => {
  if (!tierId) return 0;
  const t = await FranchiseTier.findById(tierId).select('rank').session(session ?? null);
  return t ? t.rank ?? 1 : 0;
};

/** Every franchise below the given ones, at any depth (BFS over parentId). */
export async function descendantsOf(rootIds: Types.ObjectId[], opts: { activeOnly?: boolean } = {}) {
  const found: InstanceType<typeof Franchise>[] = [];
  const seen = new Set(rootIds.map(String));
  let frontier = rootIds;
  while (frontier.length) {
    const kids = await Franchise.find({ parentId: { $in: frontier }, ...(opts.activeOnly ? { active: true } : {}) });
    frontier = [];
    for (const k of kids) if (!seen.has(String(k._id))) { seen.add(String(k._id)); found.push(k); frontier.push(k._id); }
  }
  return found;
}

/**
 * Checks a franchise (new, or existing when `childId` is given) can sit under `parentId` with plan `childTierId`.
 * Throws 400 with a clear reason otherwise. Returns the parent.
 */
export async function assertCanManage(parentId: string, childTierId: Types.ObjectId | string | null | undefined, childId?: Types.ObjectId | string) {
  const parent = await Franchise.findOne({ _id: parentId, active: true });
  if (!parent) throw new HttpError(400, 'Choose an active franchise to report to');
  if (childId && String(parent._id) === String(childId)) throw new HttpError(400, 'A franchise cannot report to itself');
  const [pt, ct] = await Promise.all([FranchiseTier.findById(parent.tierId).select('name rank'), FranchiseTier.findById(childTierId ?? null).select('name rank')]);
  if (!pt || !ct) throw new HttpError(400, 'Both franchises need a plan before one can manage the other');
  if ((pt.rank ?? 1) <= (ct.rank ?? 1)) {
    throw new HttpError(400, (pt.rank ?? 1) <= 1
      ? `${parent.code} is on the ${pt.name} plan and cannot manage other franchises`
      : `A ${pt.name} franchise can only manage franchises on a lower plan than ${pt.name} (this one is ${ct.name})`);
  }
  return parent;
}

/** A plan change must keep the tree valid: below its parent's plan and above every franchise it manages. */
export async function assertTierChangeAllowed(f: { _id: Types.ObjectId; parentId?: Types.ObjectId | null }, newTierId: string) {
  const newRank = await rankOf(newTierId);
  if (!newRank) throw new HttpError(400, 'Choose an active plan');
  if (f.parentId) await assertCanManage(String(f.parentId), newTierId, f._id).catch((e) => { throw new HttpError(400, `${e.message}. Detach it from its parent first, or choose a lower plan.`); });
  const kids = await Franchise.find({ parentId: f._id }).select('tierId code');
  for (const k of kids) {
    if ((await rankOf(k.tierId)) >= newRank) throw new HttpError(400, `${k.code} reports to this franchise, so it must stay on a higher plan than ${k.code}. Move ${k.code} first.`);
  }
}
