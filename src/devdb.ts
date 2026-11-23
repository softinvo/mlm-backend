// Local dev convenience: a throwaway single-node MongoDB *replica set* on :27017 (no install needed).
// Transactions (orders/commissions) require a replica set, same as Atlas.
// Use MONGODB_URI=mongodb://127.0.0.1:27017/mlm?replicaSet=rs0. Data persists in ./.mongo-data.
import { mkdirSync } from 'fs';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

async function main() {
  mkdirSync('.mongo-data', { recursive: true });
  const rs = await MongoMemoryReplSet.create({
    replSet: { count: 1, name: 'rs0', storageEngine: 'wiredTiger' },
    instanceOpts: [{ port: 27017, dbPath: '.mongo-data' }],
  });
  console.log('MongoDB ready at', rs.getUri());
  const stop = async () => { await rs.stop(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
main();
