import { Schema, model } from 'mongoose';
import { Ranks } from './enums';

/** What a member needs to reach each rank, set by the head office. Empty until the head office publishes it. */
const criteriaSchema = new Schema(
  {
    key: { type: String, default: 'ranks', unique: true },
    ranks: [
      {
        _id: false,
        rank: { type: String, enum: Ranks, required: true },
        minTeamVolumePaise: { type: Number, default: 0, min: 0 }, // delivered purchases by the whole team, net of refunds
        minActiveDirects: { type: Number, default: 0, min: 0 },   // direct members who bought in the last 30 days
      },
    ],
  },
  { timestamps: true },
);
export const RankCriteria = model('RankCriteria', criteriaSchema);
