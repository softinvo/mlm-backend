import './upload-env';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Franchise, FranchiseTier, Package, Product, User, Wallet, Zone } from '../models';
import { signToken } from '../utils/jwt';

const STORAGE = 'https://files.example.com';
let rs: MongoMemoryReplSet;
let server: import('node:http').Server;
let base = '';
before(async () => {
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  process.env.MONGODB_URI = rs.getUri();
  process.env.JWT_SECRET = 'test-secret-test-secret-123456';
  await mongoose.connect(rs.getUri());
  await Promise.all(mongoose.modelNames().map((n) => mongoose.model(n).init()));
  const { app } = await import('../app');
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});
after(async () => { server.close(); await mongoose.disconnect(); await rs.stop(); });

interface Acct { userId: string; token: string }
let admin: Acct, shop: Acct;
const mkUser = async (role: any, name: string): Promise<Acct> => {
  const u = await User.create({ role, status: 'ACTIVE', name, email: `${name}@t.com`, phone: String(9700000000 + Math.floor(Math.random() * 9999999)), passwordHash: await bcrypt.hash('Passw0rd!', 4) });
  await Wallet.create({ userId: u._id, type: 'INCOME' });
  return { userId: u._id.toString(), token: signToken({ userId: u._id.toString(), role }) };
};
const call = async (who: Acct | null, method: string, path: string, body?: unknown) => {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(who ? { Authorization: `Bearer ${who.token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
beforeEach(async () => {
  await Promise.all(mongoose.modelNames().map((n) => mongoose.model(n).deleteMany({})));
  admin = await mkUser('SUPER_ADMIN', 'admin'); shop = await mkUser('REMOTE_FRANCHISE', 'shop');
  const zone = await Zone.create({ name: 'Z', states: [] });
  await Franchise.create({ type: 'ZONAL', code: 'F1', name: 'Shop', zoneId: zone._id, ownerUserId: shop.userId, address: 'x' });
});

describe('image uploads', () => {
  it('gives the admin a short-lived signed URL for an image, and refuses everything else', async () => {
    assert.equal((await call(null, 'POST', '/admin/uploads/url', { extension: 'png', type: 'product' })).status, 401);
    assert.equal((await call(shop, 'POST', '/admin/uploads/url', { extension: 'png', type: 'product' })).status, 403, 'franchises cannot upload catalog images');

    const r = await call(admin, 'POST', '/admin/uploads/url', { extension: 'PNG', type: 'product' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.match(r.body.key, /^product\/[0-9a-f-]{36}\.png$/);
    assert.equal(r.body.downloadUrl, `${STORAGE}/${r.body.key}`);
    assert.equal(r.body.contentType, 'image/png');
    const u = new URL(r.body.uploadUrl);
    assert.equal(u.host, 'acct.r2.cloudflarestorage.com');
    assert.equal(u.pathname, `/media/${r.body.key}`, 'bucket and key are in the path');
    assert.ok(u.searchParams.get('X-Amz-Signature'), 'the URL is signed');
    assert.equal(u.searchParams.get('X-Amz-Expires'), '600');
    assert.doesNotMatch(r.body.uploadUrl, /secret-token-value/, 'the secret never leaves the server');
    const again = await call(admin, 'POST', '/admin/uploads/url', { extension: 'png', type: 'product' });
    assert.notEqual(again.body.key, r.body.key, 'every upload gets its own name');

    for (const bad of [{ extension: 'svg', type: 'product' }, { extension: 'mp4', type: 'product' }, { extension: 'exe', type: 'package' }, { extension: 'png', type: 'avatar' }, { extension: 'png' }, { type: 'product' }, { extension: '../x', type: 'product' }]) {
      assert.equal((await call(admin, 'POST', '/admin/uploads/url', bad)).status, 400, JSON.stringify(bad));
    }
  });

  it('only accepts pictures from our own bucket on a package or product, and a PATCH never wipes other fields', async () => {
    const img = `${STORAGE}/package/abc.png`;
    assert.equal((await call(admin, 'POST', '/admin/packages', { name: 'Kit', pricePaise: 100000, imageUrl: 'https://evil.example.com/x.png' })).status, 400, 'a link to somebody else’s site is refused');
    const c = await call(admin, 'POST', '/admin/packages', { name: 'Kit', description: 'Starter', pricePaise: 100000, taxPercent: 12, imageUrl: img });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    const id = c.body.id;
    assert.equal((await call(admin, 'PATCH', `/admin/packages/${id}`, { active: false })).status, 200);
    const kept = await Package.findById(id);
    assert.deepEqual([kept!.description, kept!.taxPercent, kept!.imageUrl, kept!.active], ['Starter', 12, img, false], 'changing one field leaves the rest alone');
    assert.equal((await call(admin, 'PATCH', `/admin/packages/${id}`, { imageUrl: '' })).status, 200);
    assert.equal((await Package.findById(id))!.imageUrl, '', 'an empty value removes the picture');

    const p = await call(admin, 'POST', '/admin/products', { sku: 'rp-9', name: 'Oil', description: 'd', pricePaise: 20000, imageUrl: `${STORAGE}/product/o.jpg` });
    assert.equal(p.status, 201, JSON.stringify(p.body));
    await call(admin, 'PATCH', `/admin/products/${p.body.id}`, { pricePaise: 25000 });
    const prod = await Product.findById(p.body.id);
    assert.deepEqual([prod!.mrpPaise, prod!.commissionable, prod!.imageUrl], [25000, true, `${STORAGE}/product/o.jpg`]);

    const cat = (await call(shop, 'GET', '/franchise/catalog')).body;
    assert.equal(cat.products[0].imageUrl, `${STORAGE}/product/o.jpg`, 'franchises see the picture');
    assert.equal((await call(admin, 'GET', '/admin/catalog')).body.products[0].imageUrl, `${STORAGE}/product/o.jpg`);
  });

  it('changing one field of a franchise plan leaves its level, investment and limits alone', async () => {
    const t = await call(admin, 'POST', '/admin/tiers', { name: 'Premium', discountPercent: 8, rank: 3, investmentPaise: 50_000_000, maxMembers: 0, dailyWalletSalesLimitPaise: 100000, description: 'Big' });
    await call(admin, 'PATCH', `/admin/tiers/${t.body.id}`, { active: false });
    const kept = await FranchiseTier.findById(t.body.id);
    assert.deepEqual([kept!.rank, kept!.investmentPaise, kept!.dailyWalletSalesLimitPaise, kept!.description, kept!.discountPercent, kept!.active], [3, 50_000_000, 100000, 'Big', 8, false]);
  });
});

describe('photos on support tickets', () => {
  const photo = (n = 1) => `${STORAGE}/support/${'a'.repeat(8)}-${n}.png`;
  it('lets members, franchises and admins get an upload URL, and attach photos that came from our bucket', async () => {
    const member = await mkUser('MEMBER', 'mem');
    for (const [who, path] of [[member, '/member/support/upload-url'], [shop, '/franchise/support/upload-url'], [admin, '/admin/support/upload-url']] as const) {
      const r = await call(who, 'POST', path, { extension: 'jpg' });
      assert.equal(r.status, 200, path + ' ' + JSON.stringify(r.body));
      assert.match(r.body.key, /^support\/[0-9a-f-]{36}\.jpg$/);
    }
    assert.equal((await call(member, 'POST', '/member/support/upload-url', { extension: 'svg' })).status, 400);
    assert.equal((await call(member, 'POST', '/admin/uploads/url', { extension: 'png', type: 'support' })).status, 403, 'the catalog endpoint stays admin-only and catalog-only');
    assert.equal((await call(admin, 'POST', '/admin/uploads/url', { extension: 'png', type: 'support' })).status, 400);

    const base = { category: 'ORDER', subject: 'Broken item received', message: 'The product arrived damaged, photos attached.' };
    assert.equal((await call(member, 'POST', '/member/support/tickets', { ...base, attachments: ['https://evil.example.com/x.png'] })).status, 400, 'not from our bucket');
    assert.equal((await call(member, 'POST', '/member/support/tickets', { ...base, attachments: [`${STORAGE}/package/x.png`] })).status, 400, 'only the support folder');
    assert.equal((await call(member, 'POST', '/member/support/tickets', { ...base, attachments: [1, 2, 3, 4, 5].map(photo) })).status, 400, 'at most 4');
    const c = await call(member, 'POST', '/member/support/tickets', { ...base, attachments: [photo(1), photo(2)] });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    assert.deepEqual(c.body.messages[0].attachments, [photo(1), photo(2)]);
    const id = c.body.id;

    // a photo alone is a valid reply; an empty one is not
    assert.equal((await call(member, 'POST', `/member/support/tickets/${id}/reply`, { message: '' })).status, 400);
    const r = await call(member, 'POST', `/member/support/tickets/${id}/reply`, { attachments: [photo(3)] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.messages.at(-1).attachments[0], photo(3));
    const desk = await call(admin, 'GET', `/admin/support/tickets/${id}`);
    assert.deepEqual(desk.body.messages.map((m: any) => m.attachments.length), [2, 1]);
    const adm = await call(admin, 'POST', `/admin/support/tickets/${id}/reply`, { message: 'Here is the return label.', attachments: [photo(4)] });
    assert.equal(adm.status, 200, JSON.stringify(adm.body));
    assert.equal((await call(member, 'GET', `/member/support/tickets/${id}`)).body.messages.at(-1).attachments[0], photo(4), 'the member sees the admin’s photo');
    assert.equal((await call(member, 'GET', '/member/support/tickets')).body.items[0].last.text.length > 0, true);
    const row = (await call(admin, 'GET', '/admin/support/tickets?status=active')).body.items.find((t: any) => t.id === id);
    assert.deepEqual([row.photos.count, row.photos.urls.length], [4, 3], 'the desk list previews the first 3 photos and counts them all');
    assert.equal(row.photos.urls[0], photo(1));
  });
});

describe('website photo gallery', () => {
  const img = (n: number) => `${STORAGE}/gallery/${'b'.repeat(8)}-${n}.jpg`;
  it('lets the admin add, caption, hide, reorder and delete photos, and shows only visible ones publicly', async () => {
    assert.equal((await call(admin, 'POST', '/admin/uploads/url', { extension: 'jpg', type: 'gallery' })).status, 200, 'the admin can upload to the gallery folder');
    assert.equal((await call(shop, 'POST', '/admin/gallery', { imageUrl: img(1) })).status, 403);
    assert.equal((await call(admin, 'POST', '/admin/gallery', { imageUrl: 'https://evil.example.com/x.jpg' })).status, 400, 'not from our bucket');
    assert.equal((await call(admin, 'POST', '/admin/gallery', { imageUrl: `${STORAGE}/product/x.jpg` })).status, 400, 'only the gallery folder');

    const a = (await call(admin, 'POST', '/admin/gallery', { imageUrl: img(1), caption: 'Annual meet' })).body;
    const b = (await call(admin, 'POST', '/admin/gallery', { imageUrl: img(2) })).body;
    const c = (await call(admin, 'POST', '/admin/gallery', { imageUrl: img(3), caption: 'Launch' })).body;
    assert.deepEqual([a.order, b.order, c.order], [1, 2, 3], 'new photos go to the end');

    assert.equal((await call(admin, 'PATCH', `/admin/gallery/${b.id}`, { caption: 'Team photo' })).body.caption, 'Team photo');
    assert.equal((await call(admin, 'PATCH', `/admin/gallery/${c.id}`, { active: false })).body.active, false);
    let pub = (await call(null, 'GET', '/public/gallery')).body.items;
    assert.deepEqual(pub.map((p: any) => p.caption), ['Annual meet', 'Team photo'], 'hidden photos are not public');
    assert.equal((await call(admin, 'GET', '/admin/gallery')).body.items.length, 3, 'but the admin still sees them');

    assert.equal((await call(admin, 'PUT', '/admin/gallery/order', { ids: [c.id, a.id] })).status, 400, 'must list every photo');
    assert.equal((await call(admin, 'PUT', '/admin/gallery/order', { ids: [b.id, c.id, a.id] })).status, 200);
    await call(admin, 'PATCH', `/admin/gallery/${c.id}`, { active: true });
    pub = (await call(null, 'GET', '/public/gallery')).body.items;
    assert.deepEqual(pub.map((p: any) => p.caption), ['Team photo', 'Launch', 'Annual meet'], 'the new order shows publicly');

    assert.equal((await call(admin, 'DELETE', `/admin/gallery/${b.id}`)).status, 200);
    assert.equal((await call(admin, 'DELETE', `/admin/gallery/${b.id}`)).status, 404);
    assert.equal((await call(null, 'GET', '/public/gallery')).body.items.length, 2);
  });
});
