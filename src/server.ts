import mongoose from 'mongoose';
import { app } from './app';
import { env } from './config/env';
import { migrate } from './migrate';
import { approveDueCommissions } from './services/commission.service';
import { payDueCashback } from './services/cashback.service';

async function main() {
  await mongoose.connect(env.MONGODB_URI);

  await migrate(); // idempotent upgrades for older databases

  app.listen(env.PORT, () => console.log(`API listening on :${env.PORT}`));

  // Releases commissions whose cooling-off window has ended. Safe if several instances run it at once.
  if (env.COMMISSION_JOB_MINUTES > 0) {
    const run = () => approveDueCommissions()
      .then((r) => { if (r.commissions || r.franchiseEarnings) console.log('Approved commissions:', r); })
      .catch((e) => console.error('Commission approval job failed:', e));
    const cashback = () => payDueCashback()
      .then((r) => { if (r.credits) console.log('Cashback credited:', r); })
      .catch((e) => console.error('Cashback job failed:', e));
    cashback();
    setInterval(cashback, env.COMMISSION_JOB_MINUTES * 60_000).unref();
    run();
    setInterval(run, env.COMMISSION_JOB_MINUTES * 60_000).unref();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
