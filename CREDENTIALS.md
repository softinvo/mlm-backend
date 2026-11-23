# Dev Credentials (dummy data — local development only)

Created by `npm run seed`. Never use these in production; the seed refuses to run when `NODE_ENV=production`.

**Password for every account:** `Demo@1234`

## Accounts

| Role | Name | Email | Phone | Notes |
|---|---|---|---|---|
| SUPER_ADMIN | Super Admin | admin@demo.com | 9000000001 | |
| ZONAL_FRANCHISE | Zonal Owner | zonal@demo.com | 9000000002 | Owns `ZF-WEST-01` |
| REMOTE_FRANCHISE | Remote Owner | remote@demo.com | 9000000003 | Owns `RF-PUN-01` (parent: `ZF-WEST-01`) |
| REMOTE_FRANCHISE | Remote Owner Mumbai | remote2@demo.com | 9000000004 | Owns `RF-MUM-01`; sees only its own member (Gita Shah) |
| MEMBER | Gita Shah | gita@demo.com | 9000000017 | `MDEMO0007`, belongs to the Mumbai franchise |
| MEMBER | Demo Member | member@demo.com | 9000000011 | `MDEMO0001`, has sample dashboard data |
| MEMBER | Root Member | root@demo.com | 9000000010 | `MROOT0001`, top of the tree |
| MEMBER | Asha Verma | asha@demo.com | 9000000012 | `MDEMO0002`, sponsor: MDEMO0001 |
| MEMBER | Bilal Khan | bilal@demo.com | 9000000013 | `MDEMO0003`, sponsor: MDEMO0001 |
| MEMBER | Chitra Rao | chitra@demo.com | 9000000014 | `MDEMO0004`, sponsor: MDEMO0002 (level 2 under Demo) |
| MEMBER | Dev Patel | dev@demo.com | 9000000015 | `MDEMO0005`, sponsor: MDEMO0001, **non-active** (no orders) |
| MEMBER | Esha Nair | esha@demo.com | 9000000016 | `MDEMO0006`, sponsor: MDEMO0004 (level 3 under Demo), **non-active** |

## Test codes for signup (`POST /api/auth/register`)

- Sponsor code: `MROOT0001`
- Franchise code: `RF-PUN-01`

## Hierarchy

```
Super Admin (HQ)
└── West Zonal HQ (ZF-WEST-01)
    └── Pune Remote Point (RF-PUN-01)

MROOT0001 (Root)
└── MDEMO0001 (Demo Member)
    ├── MDEMO0002 (Asha)
    │   └── MDEMO0004 (Chitra)
    │       └── MDEMO0006 (Esha, inactive)
    ├── MDEMO0003 (Bilal)
    └── MDEMO0005 (Dev, inactive)
```

## Quick start

```bash
cp .env.example .env     # or use the generated .env (set MONGODB_URI and JWT_SECRET)
npm run dev:db           # optional: throwaway local MongoDB *replica set* on :27017 (no install needed; data in .mongo-data)
                         #   then use MONGODB_URI=mongodb://127.0.0.1:27017/mlm?replicaSet=rs0
npm run seed             # dummy users + orders/commissions through the real services (safe to re-run)
npm run seed -- --fresh  # same, but wipes orders, commissions and wallet history first
npm test                 # integration tests for the order/commission engine (own in-memory DB)
npm run dev              # API on http://localhost:4000

# Try it
curl -X POST localhost:4000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"member@demo.com","password":"Demo@1234"}'

curl localhost:4000/api/member/dashboard -H "Authorization: Bearer <token>"
```

## Member API (all require a MEMBER token)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/member/dashboard` | dashboard summary |
| GET / PATCH | `/api/member/profile` | read / update profile (name, mobile, DOB, gender, address) |
| POST | `/api/member/password` | change password `{currentPassword, newPassword}` |
| GET | `/api/member/team/direct` | level-1 members |
| GET | `/api/member/team/levels` | whole downline + per-level summary (`?level=`) |
| GET | `/api/member/team/levels/export` | same filters as a CSV download (max 10,000 rows) |
| GET | `/api/member/team/non-active` | downline with no paid/delivered order in the last 30 days |

Team endpoints accept `page`, `limit` (max 100), `search` (name or member ID) `status` (`all|active|inactive`), `sort` (`joined|level|name|status`) and `dir` (`asc|desc`). Rows include the sponsor's name and member ID.

Shipping (all scoped to the signed-in member):

| Method | Path | Purpose |
|---|---|---|
| GET / POST | `/api/member/shipping-addresses` | list / add an address (max 10; the first one becomes default) |
| PUT / DELETE | `/api/member/shipping-addresses/:id` | edit / delete (deleting the default promotes the newest remaining) |
| POST | `/api/member/shipping-addresses/:id/default` | make this the default |
| GET | `/api/member/shipping-history` | the member's orders with shipment status, courier, tracking and timeline (`page`, `limit`, `status`) |

The seed gives `member@demo.com` two addresses and 14 shipments in different states (packed, shipped, out for delivery, cancelled, delivered).

## Orders and commissions

> **Shop:** the member panel has no shop, cart or checkout pages; shopping lives in a separate app. That app uses the same API: `GET /api/member/catalog`, `POST /api/member/orders` (and `/orders/:id`, `/pay`, `/cancel`) below. The member panel still shows the shopping wallet, top-ups and Shipping History.

**Money flow:** order placed → paid → packed → shipped → delivered. On delivery the engine creates **PENDING** commissions;
after the cooling-off window (`COOLING_OFF_DAYS`, default 7) a job (every `COMMISSION_JOB_MINUTES`, default 15) marks them **APPROVED**
and credits the wallet. Refunds claw commission back in proportion (pending: reduced; approved: debited from the wallet).
Total payout per order (members + franchises) is capped by the plan's `maxPayoutPercentOfVolume`. Nothing is paid for enrollment.
Transactions need a replica set (Atlas has one; locally use `npm run dev:db`).

| Method | Path | Who | Purpose |
|---|---|---|---|
| GET | `/api/member/catalog` | member | active packages and prices |
| POST | `/api/member/orders` | member | place an order `{items:[{packageId,quantity}], addressId, payWith?, clientKey?}`. Prices come from the catalog; `addressId` (one of your saved addresses) is required; `payWith:"SHOPPING_WALLET"` pays instantly, otherwise the order is reserved until the head office confirms payment; the same `clientKey` always returns the same order (retry-safe) |
| GET | `/api/member/orders/:id` | member | order summary for the confirmation page (404 for other members' orders) |
| POST | `/api/member/orders/:id/pay` | member | pay a reserved order from the shopping wallet `{payWith:"SHOPPING_WALLET"}` |
| POST | `/api/member/orders/:id/cancel` | member | cancel an order that is still unpaid (paid orders go through the admin refund) |
| GET | `/api/member/commissions` | member | commission list + summary (`type=direct|level|all`, `status`, `page`, `limit`) |
| POST | `/api/admin/orders/:id/pay` | super admin | confirm payment `{gatewayRef, gateway?}` (idempotent per ref) |
| POST | `/api/admin/orders/:id/shipment` | super admin | `{status: PACKED|SHIPPED|OUT_FOR_DELIVERY|DELIVERED, courier?, trackingId?}` (SHIPPED needs courier + tracking) |
| POST | `/api/admin/orders/:id/cancel` | super admin | cancel an unshipped order (a paid one is refunded) |
| POST | `/api/admin/orders/:id/refund` | super admin | `{amountPaise, reason}` full or partial |
| POST | `/api/admin/jobs/approve-commissions` | super admin | run the approval job now |
| GET / POST | `/api/admin/commission-plan(s)` | super admin | read the active plan / create the next version |

**The seeded plan is a placeholder:** from `plan.md`: 8 levels = 40 / 1 / 1 / 1 / 1 / 1 / 0.5 / 0.5 % (46 % in all) of commissionable volume, payout cap 50 %, franchises 2 % (remote) + 1 % (zonal).
Set the real numbers with `POST /api/admin/commission-plans` after legal review. A new version applies only to orders delivered after its `effectiveFrom`.

## Wallets and withdrawals

Each member has two wallets: **INCOME** (commissions, withdrawable) and **SHOPPING** (spendable on products only; created on first transfer).
Every balance change goes through one ledger function that updates the balance and appends an entry (with the balance after it) in a transaction,
with an idempotency key so retries can never double-post. Withdrawing debits the wallet immediately; rejecting or cancelling returns the money.

| Method | Path | Who | Purpose |
|---|---|---|---|
| GET | `/api/member/wallet` | member | balances, withdrawn / in-process totals, payout account status, fee config |
| PUT | `/api/member/wallet/payout-account` | member | submit bank details + PAN (goes to PENDING; any change needs re-verification) |
| GET | `/api/member/wallet/entries` | member | passbook: `wallet=income\|shopping`, `type`, `page`, `limit` |
| POST | `/api/member/wallet/transfer` | member | move income to shopping wallet (one-way) |
| POST | `/api/member/withdrawals/quote` | member | fee / TDS / net for an amount |
| POST / GET | `/api/member/withdrawals` | member | request (needs VERIFIED payout account, minimum, balance) / history |
| POST | `/api/member/withdrawals/:id/cancel` | member | cancel while still REQUESTED |
| POST | `/api/member/orders` with `"payWith":"SHOPPING_WALLET"` | member | pay an order from the shopping wallet (refunds go back to it) |
| GET | `/api/admin/withdrawals` | super admin | payout queue incl. decrypted account number |
| POST | `/api/admin/withdrawals/:id/approve`, `/pay`, `/reject` | super admin | `pay` needs `{payoutRef}`, `reject` needs `{reason}` (refunds the wallet) |
| POST | `/api/admin/users/:userId/kyc` | super admin | `{status: VERIFIED\|REJECTED, note?}` |

Config (env): `WITHDRAWAL_MIN_PAISE` (default ₹100), `WITHDRAWAL_FEE_PERCENT` (default 15, the plan's withdrawal deduction) and `WITHDRAWAL_TDS_PERCENT` (default 0, set with your accountant),
`KYC_ENC_KEY` (required in production). The seed verifies the demo member's payout account and gives it a paid, a rejected and a waiting withdrawal.
**Existing databases:** on startup the server tags old wallets as INCOME and replaces the old unique(userId) index with unique(userId, type).
**Member-to-member transfers (P2P)** move *shopping-wallet* credit only, never withdrawable income, so they can't be used to cash out.
Safeguards: recipient must be an active member (looked up by member ID, name shown masked, e.g. "Bilal K."), no sending to yourself, a rolling 24-hour limit
(`P2P_DAILY_LIMIT_PAISE`, default ₹10,000), balance-checked debit, retry-safe `clientKey`, ledger entries for both sides, audit log, rate-limited lookups.
Even so, a transferable wallet may count as a regulated payment instrument, so get legal advice before launch.

| Method | Path | Who | Purpose |
|---|---|---|---|
| GET | `/api/member/transfers/lookup?code=` | member | check a member ID before sending (masked name) |
| POST | `/api/member/transfers` | member | `{toMemberCode, amountPaise, note?, clientKey?}` |
| GET | `/api/member/transfers` | member | sent/received history + today's total and the limit (`direction`, `page`, `limit`) |

## Deposits / top-ups (manual until a payment gateway exists)

A member pays the company's bank account or UPI, then submits the bank reference. The head office checks the bank statement and approves, which credits the
member's **SHOPPING** wallet (never the withdrawable income wallet, so deposits cannot be cashed out). The same reference can't be used twice (case, spaces and dashes
ignored) until a request using it is rejected or cancelled. Members can have at most `FUND_MAX_OPEN` (3) requests waiting. An admin may approve less than was claimed, never more.
Where to pay comes from env (`PAYMENT_ACCOUNT_NAME`, `PAYMENT_ACCOUNT_NUMBER`, `PAYMENT_IFSC`, `PAYMENT_BANK`, `PAYMENT_UPI_ID`); if unset, the page tells members not to pay yet.

| Method | Path | Who | Purpose |
|---|---|---|---|
| GET | `/api/member/fund-requests/info` | member | company payment details, limits, shopping balance |
| POST | `/api/member/fund-requests` | member | `{amountPaise, mode: UPI\|IMPS\|NEFT\|RTGS\|CASH_DEPOSIT, reference, paidOn, note?}` |
| GET | `/api/member/fund-requests` | member | own requests + summary (`status`, `page`, `limit`) |
| POST | `/api/member/fund-requests/:id/cancel` | member | cancel while pending |
| GET | `/api/admin/fund-requests` | super admin | review queue (`status`, `page`) |
| POST | `/api/admin/fund-requests/:id/approve` | super admin | `{approvedPaise?, note?}` credits the shopping wallet once |
| POST | `/api/admin/fund-requests/:id/reject` | super admin | `{reason}` |

The seed gives the demo member one credited, one rejected and one pending request.

## Franchise panel and head office

Two front-end apps share this one backend: **member app** (`main-frontend`, :5173; members only) and **Franchise & Admin app** (`franchiese`, :5174) with two dashboards: **Admin** at `/admin` (head office, 1 to 2 logins) and **Franchise** at `/`. Each app only accepts its own kind of account and points anyone else to the right place.
**Head office has one or two logins only** (`ADMIN_MAX`, default 2). There is no API to create an admin; add one on the server with
`npm run create-admin -- --email you@company.com --name "Your Name" --phone 9876543210` (refuses beyond the limit, prints a temporary password once).
Franchise owners are created by the head office in **Admin → Franchises**; each gets a login to their own panel.

**Who does what.** Franchises (zonal and remote) work only on their own members; a zonal franchise also covers its remote franchises, and nobody sees another zone.

| | Franchise | Head office |
|---|---|---|
| Verify members' bank details (PAN/account) | yes (full number shown, every view logged) | yes |
| Top-ups | reviews and **recommends** approve/reject | **approves** and credits the shopping wallet |
| Withdrawals | **recommends**; once approved, pays and records the bank reference | **approves** or rejects (rejecting refunds the wallet) |
| Order payments | records that cash/UPI/bank payment was received | **confirms** it (order becomes PAID) |
| Shipping | packs, ships (courier + tracking), marks delivered, cancels unpaid orders | can cancel/refund |
| Franchises, commission plan, refunds | no | yes |

A franchise can never credit a wallet, approve a withdrawal or mark an order paid: those endpoints refuse franchise tokens, and a recommendation moves no money.

| Method | Path | Who | Purpose |
|---|---|---|---|
| GET | `/api/account/me` | any signed-in role | name, role, franchises |
| POST | `/api/account/password` | any signed-in role | change own password |
| GET | `/api/franchise/overview`, `/members` | franchise | counts and own members |
| GET / POST | `/api/franchise/kyc`, `/kyc/:userId`, `/kyc/:userId/review` | franchise | bank-detail queue, detail, verify/reject |
| GET / POST | `/api/franchise/fund-requests`, `/:id/recommend` | franchise | top-up queue and recommendation |
| GET / POST | `/api/franchise/withdrawals`, `/:id/recommend`, `/:id/pay` | franchise | withdrawal queue; pay only after admin approval |
| GET / POST | `/api/franchise/orders`, `/:id/payment-received`, `/:id/shipment`, `/:id/cancel` | franchise | order tabs (awaiting, toship, transit, done) and actions |
| GET | `/api/admin/overview`, `/orders`, `/kyc`, `/kyc/:userId`, `/franchises` | admin | head-office views |
| POST | `/api/admin/franchises`, PATCH `/api/admin/franchises/:id` | admin | create a franchise with its owner login; edit share / activate |

The staff panels need the real backend; demo mode (`VITE_DEMO=1`) only simulates the member panel.

## Franchise tiers, catalog, members and franchise sales

- **Tiers (admin-defined sizes).** Admin creates tiers (seed: Mini 1%, Standard 2%, Premium 3%). A tier sets the franchise's **share of the sales it fulfils**, a **member cap** (registration is refused past it) and a **daily limit on shopping-wallet sales**. Every franchise has one tier; changing it applies to orders delivered afterwards. (Zonal/Remote is the hierarchy; the tier is the size.)
- **Catalog.** Admin owns it: **joining packages** and **repurchase products**, with prices and tax. Franchises sell them and cannot change prices. A price change never alters past orders.
- **Members.** Admin sees every member: search, open details (franchise, sponsor, wallets, team, orders), **suspend** (locks them out immediately, on every request), reactivate, reset password.
- **Franchise sales.** A franchise looks a member up by member ID and sells packages/products from the catalog:
  - **Paid at the counter** (cash/UPI/bank): the franchise records the payment, the head office confirms it, then the franchise hands it over.
  - **Member's shopping wallet:** the franchise bills the member and the **member is sent a one-time code** (SMS or email, their choice) that unlocks the bill for **5 minutes** (`PAYMENT_REQUEST_MINUTES`, default 5). The member reads it out and the shop types it in. Nothing is charged without the right code; the tier's daily limit is enforced even with simultaneous confirmations. Members have no payment-requests screen or API any more.

| Method | Path | Who | Purpose |
|---|---|---|---|
| GET / POST / PATCH | `/api/admin/tiers`, `/:id` | admin | franchise size tiers |
| GET | `/api/admin/catalog` | admin | packages (kind JOINING) and products (kind REPURCHASE) |
| POST / PATCH | `/api/admin/packages`, `/api/admin/products` (+ `/:id`) | admin | manage the catalog |
| GET | `/api/admin/members`, `/members/:userId` | admin | list/search all members, member details |
| PATCH / POST | `/api/admin/members/:userId/status`, `/reset-password` | admin | suspend/reactivate (reason required to suspend), reset password |
| GET | `/api/franchise/catalog` | franchise | items on sale |
| GET | `/api/franchise/members/lookup?code=` | franchise | find a member by ID before selling |
| POST | `/api/franchise/sales` | franchise | `{memberCode, items:[{packageId\|productId, quantity}], payment:{type:"WALLET"} \| {type:"COUNTER", method, reference}, clientKey?}` |
| GET / POST | `/api/franchise/payment-requests`, `/:id/cancel`, `/:id/confirm {otp}`, `/:id/resend-otp` | franchise | wallet bills it has sent, and the code that unlocks each one |

Registering a franchise now requires a tier (`tierId`). Older franchises without a tier keep their previous share until you assign one. Suspended users are now rejected on every request, not only at login.

## Notes

- "Active" = at least one PAID/DELIVERED order in the last 30 days (`ACTIVE_WINDOW_DAYS` in `team.service.ts`).
- Team lists show masked mobile numbers (e.g. `90XXXXXX12`); email is never exposed to the upline.

- Only MEMBER accounts can call `/api/member/dashboard`; other roles get 403 until their dashboards exist.
- Real secrets (`JWT_SECRET`, DB URI) live in `.env`, which is git-ignored. They are intentionally not documented here.

## Franchise prepaid model

Franchises pay the company in advance and sell from that balance. A franchise's **type** (tier) sets its discount, for example Mini 3%, Standard 5%, Premium 8%. A sale costs the retail price less the discount; the franchise keeps the difference. There are no settlements or credit limits.

| Method | Path | Who | What |
|---|---|---|---|
| GET | `/api/franchise/prepaid` | franchise | balance, type/discount, pending recharges, limits |
| GET | `/api/franchise/prepaid/entries` | franchise | ledger |
| GET/POST | `/api/franchise/recharges` | franchise | list / submit a recharge (amount, mode, UTR, date) |
| POST | `/api/franchise/recharges/:id/cancel` | franchise | cancel a waiting recharge |
| GET | `/api/admin/prepaid` | admin | all balances |
| GET | `/api/admin/prepaid/:franchiseId` | admin | one franchise's statement and ledger |
| POST | `/api/admin/prepaid/:franchiseId/adjust` | admin | correction with a reason |
| GET | `/api/admin/recharges` | admin | recharge requests |
| POST | `/api/admin/recharges/:id/confirm` / `reject` | admin | credit (can be less than claimed) / refuse |
| GET/PATCH | `/api/account/profile` | any signed-in user | profile; edit name and mobile |
| PATCH | `/api/franchise/profile/:id` | franchise owner | edit address and GSTIN |

- The balance pays for **stock**: when the head office supplies products, the franchise is charged retail price less its plan discount.
- Counter sale: paid at once. The sale takes the items out of the franchise's stock; the balance does not move.
- Wallet sale: the member gives the shop their one-time code; the franchise is credited the full price. A refund takes it back.
- Demo data: Standard (Pune) and Mini (Mumbai) franchises are recharged; one recharge is waiting for the admin.

## Franchise hierarchy (by plan level)

Plans have a level: Mini 1, Standard 2, Premium 3. A franchise can manage franchises on a **lower** plan only.

- **Premium** can manage Standard and Mini, **Standard** can manage Mini, **Mini** cannot manage anyone.
- The head office manages everyone and can place any franchise under any eligible parent (`PATCH /api/admin/franchises/:id` with `parentId`, or `null` to report to the head office) or change its plan. Changes that would break the rule are refused.
- A franchise sees the members, orders, top-ups and withdrawals of everything below it, at any depth. Money stays separate: a parent cannot sell from, recharge or see the prepaid balance of a franchise below it.
- Demo: West Zonal HQ (Premium) → Pune Remote Point (Standard) → Mumbai Remote Point (Mini).
- The first recharge of each franchise must be at least its plan's investment (Mini ₹25,000, Standard ₹1,00,000, Premium ₹5,00,000).

## Stock and supply (how products reach members)

1. The admin adds joining kits (packages) and repurchase products to the catalog.
2. The admin **supplies** stock to a franchise: `POST /api/admin/supplies` (preview with `/supplies/preview`). The franchise's prepaid balance is charged retail less its plan discount; if it can't cover it the supply is refused. This is how a plan's investment (Mini ₹25,000, Standard ₹1,00,000, Premium ₹5,00,000) turns into stock.
3. The franchise sees what it holds (`GET /api/franchise/stock`, `/stock/movements`, `/supplies`) and can only sell what is there. Making a sale takes the items out of stock in the same transaction, so a unit can never be sold twice.
4. A cancelled unpaid sale, or a **full** refund, puts the items back. A partial refund does not restock; the admin can correct stock with a reason.
5. The franchise keeps the customer's money (counter) or is credited the retail price (wallet sale), so its margin is the plan discount.

| Method | Path | Who | What |
|---|---|---|---|
| GET | `/api/admin/stock` | admin | stock held by every franchise |
| GET | `/api/admin/stock/:franchiseId` | admin | one franchise's stock and movements |
| POST | `/api/admin/stock/:franchiseId/adjust` | admin | correct stock (reason required, no money moves) |
| POST | `/api/admin/supplies/preview` / `supplies` | admin | price / create a supply |
| GET | `/api/admin/supplies` | admin | supply history |
| GET | `/api/franchise/stock`, `/stock/movements`, `/supplies` | franchise | own stock, history, deliveries |

Demo: each franchise is supplied opening stock in the seed. Parents cannot see or use a sub-franchise's stock.

### Franchise-to-franchise supply

A franchise can supply stock it holds to the franchises it manages (lower plans below it, at any depth): Premium to Standard and Mini, Standard to Mini, Mini to nobody.

- The stock moves out of the supplier's stock into the receiver's.
- The receiver is charged retail less **its own** plan discount, and exactly that amount is credited to the supplier's prepaid balance (an internal transfer: both balances are held by the company). The supplier earns the difference between its own discount and the receiver's.
- It is refused if the supplier doesn't hold enough, or the receiver's balance can't cover it. A parent is never shown a sub-franchise's balance.

| Method | Path | What |
|---|---|---|
| GET | `/api/franchise/network` | franchises you can supply |
| POST | `/api/franchise/supplies/preview` / `supplies` | price / make a supply (`franchiseId` = receiver) |
| GET | `/api/franchise/supplies` | supplies you received and sent (`direction` IN / OUT) |

## Product and package pictures (image upload)

The admin can add a picture to every joining package and repurchase product (Catalog page). Pictures are stored in a Cloudflare R2 (or any S3-compatible) bucket and shown in the catalog, New Sale, and My Stock.

1. `POST /api/admin/uploads/url` with `{ "extension": "png", "type": "package" | "product" }` returns `{ uploadUrl, downloadUrl, key, contentType }`. The URL is signed for 10 minutes and for that exact content type.
2. The browser `PUT`s the file to `uploadUrl` with header `Content-Type: <contentType>`.
3. Save `downloadUrl` as `imageUrl` when creating or editing the package or product. Only addresses inside your own bucket are accepted; an empty value removes the picture.

Set these in `backend/.env` (leave blank to switch uploads off; the endpoint then answers 503):

```
R2_S3_API_URL=https://<account-id>.r2.cloudflarestorage.com
R2_API_KEY_ID=...
R2_API_ACCESS_TOKEN=...
BUCKET_NAME=...
STORAGE_URL=https://<your public bucket domain>
```

The bucket's CORS rules must allow `PUT` with a `Content-Type` header from the franchise app's origin (for example `http://localhost:5174`). PNG, JPG and WEBP only, up to 5 MB (checked by the app; the signed URL itself cannot enforce a size).

## Member purchase history

`GET /api/member/purchases?status=all|paid|awaiting|cancelled|refunded&type=all|joining|repurchase&page&limit` (member only). Returns the member's own orders with each product (picture, quantity, unit and line price), the shop, how it was paid, refunds, and a summary (`spentPaise` after refunds, paid `orders`, `units`, last purchase). Shown in the member app under Profile → Purchase History. Delivery tracking stays in Shipping History.

## Help & support (tickets)

Members and franchise owners raise tickets; the head office answers them. It replaces the old Telegram links.

**Requester (member app and franchise app)**: `GET/POST /api/member/support/tickets` and `/api/franchise/support/tickets`, then `GET /tickets/:id`, `POST /tickets/:id/reply`, `/close`, `/reopen`, `/rate`, and `GET /support/summary` (badge counts). A person sees only their own tickets and never the admins' private notes. Limits: 5 open tickets per person, 4,000 characters per message. Only the head office can mark a ticket URGENT. A solved or closed ticket can be reopened within 14 days.

**Head office (`/api/admin/support/*`)**: `GET /tickets` (filters: `status`, `category`, `priority`, `who=member|franchise`, `assigned=me|unassigned`, `search`, `sort`), `GET /tickets/:id` (requester details, private notes, their other tickets), `POST /tickets/:id/reply` (`internal: true` for a private note; `status` to mark solved), `PATCH /tickets/:id` (status, priority, topic, `assign: me|none`), `GET /summary` (waiting, unassigned, urgent, overdue over 24 hours, satisfaction).

Status flow: OPEN → (admin replies) WAITING_ON_USER → (user replies) OPEN → RESOLVED → CLOSED. The first admin to reply takes the ticket. Every admin action is written to the audit log.

In the apps: member portal → Help & Support (My Tickets, New Ticket); franchise portal → Help & Support; admin → Support Desk. Sidebar badges show tickets waiting for the requester's reply (members, franchises) or for the head office (admin).

**Photos on tickets.** Members, franchise owners and admins can attach up to 4 photos (PNG, JPG or WEBP, 5 MB each) to a new ticket or any reply, and a reply can be photos only. The app asks `POST /api/member|franchise|admin/support/upload-url` for a signed URL, uploads the photo straight to the bucket (`support/` folder), then sends the returned addresses as `attachments` when creating or replying. Only addresses from that folder of your own bucket are accepted. It needs the same R2 settings and CORS rule as catalog pictures. Photos are served from the bucket's public address under an unguessable name, so treat them as visible to anyone who has the link.

## Public website (member app, signed-out visitors)

`main-frontend` now serves a public website before sign-in: **Home** `/`, **About us** `/about`, **Products** `/products`, **Opportunity** `/opportunity`, **Photo Gallery** `/gallery`, **Contact us** `/contact`, with **Sign in** `/login` and **Sign up** `/register` in the top bar, and a footer on every page. Signed-in members see a Dashboard button instead of Sign in / Sign up.

- Company name, tagline, email, phone, address and hours: set the `VITE_*` values in `main-frontend/.env` (see `.env.example`).
- Products and the commission levels shown on Opportunity come live from `GET /api/public/catalog` (active items only, no sign-in needed). Pictures are the ones uploaded in the admin Catalog.
- Photo Gallery shows the photos the head office manages in the admin app (**Website Gallery**), then any listed in `main-frontend/src/site/config.ts`, then every product picture.
- The Contact form posts to `POST /api/public/contact` (5 messages per hour per device, with a hidden spam trap). Admins read them under Support Desk → Website enquiries (`GET /api/admin/support/enquiries`, `POST .../:id/handled`).

**Terms and Privacy.** `/terms` and `/privacy` on the public website (text in `main-frontend/src/site/pages/Terms.tsx` and `Privacy.tsx`, date in `site/config.ts` → `LEGAL_UPDATED`). They are linked from the footer and from the sign-up form. They describe how this system actually behaves (cooling-off, commission reversal on refund, wallet approval, KYC encryption, who can see what), so update them whenever those rules change. They are a starting draft and should be reviewed by your lawyer before launch.

**Website Gallery (admin).** Admin → Website Gallery: add photos (several at once; PNG, JPG or WEBP up to 5 MB), caption them, hide or show, reorder with the arrows, and delete (this also removes the file from the bucket). API: `GET/POST /api/admin/gallery`, `PATCH/DELETE /api/admin/gallery/:id`, `PUT /api/admin/gallery/order`; public `GET /api/public/gallery` returns the visible photos in order. Uploads use `POST /api/admin/uploads/url` with `type: "gallery"` and need the same R2 settings and CORS rule as catalog pictures.

## Website Content (admin-managed public website)

Admin → **Website Content** controls the whole public website. Until you save, it shows built-in content about this platform (products sold through franchises, how members earn, franchise plans, FAQ, enquiry form; no certificates or figures, so nothing to correct), in a forest-green, cream and gold look (forest green `#123b2b`, cream `#f7f5ee`, gold `#b89153`) and fonts (Fraunces headings, Manrope text).

- **Pages** (each an ordered list of blocks you can add, edit, reorder, hide and remove): Home `/`, About `/about`, Products `/products`, Franchise `/franchise`, Opportunity `/opportunity`, Photo Gallery `/gallery`, Contact `/contact` (with an enquiry form at `/contact#enquire`). Sign in `/login`, Sign up `/register`, Terms `/terms` and Privacy `/privacy` are separate.
- **Block types:** page banner, hero, highlights strip, cards (with small labels, status badges, bullet lists and pictures), big numbers, tag list, highlight panel (e.g. lot code), text with picture, numbered steps, questions and answers, commission levels, products (live catalog), franchise plans (live from Franchise Types), photo gallery (can show just the latest few), contact form, enquiry form, call-to-action band and plain text.
- **Settings:** company name, tagline, logo, email, phone, WhatsApp number (adds a WhatsApp button to every page), address, hours, footer text and small print, earnings disclaimer, the **menu** (header and footer links; the first six show in the header, the rest under “More”), and eight colours with a live preview.
- Writing `{{name}}` in any website text shows the company name from Settings, so one change renames the whole site. The default text uses it instead of a brand name.
- Pictures upload to the `site/` folder of your bucket (same R2 settings and CORS rule as the catalog). Products, commission levels and gallery photos inside blocks still come live from the Catalog, Commission Plan and Website Gallery pages. Quote and contact requests arrive under Support Desk → Website enquiries.

API: `GET /api/public/site` (public), `GET/PUT /api/admin/site`, `POST /api/admin/site/reset`. Edits are validated (colours must be `#rrggbb`, links must start with `/`, `#`, `https://`, `mailto:` or `tel:`, pictures must come from your bucket, at most 30 blocks per page) so a bad edit cannot break the site, and are written to the audit log. Content saved before a newer field existed still loads; missing pieces fall back to the defaults.


## Purchase cashback (daily)

Admin → **Commission Plan → Purchase cashback**. **Off until you switch it on.** Rules, as in `plan.md`: the buyer gets a % of the net eligible product value of a delivered order **each day**, for at most N days and never more than a total % (default **1% a day, max 30 days, max 30%**). Credits go to the buyer's **income wallet** (so withdrawal rules apply), start the day after delivery, and stop after the last day: nothing is paid for life and no repurchase is needed to keep what was earned.

- **Eligible:** product lines only. Joining kits / packages are excluded unless "Also pay on joining kits / packages" is ticked.
- **Rules are snapshotted** per order when it is delivered; changing the settings later does not alter existing orders.
- **Refunds:** the daily amount shrinks in proportion to what is still kept, and the part already paid that the refund covers is taken back (`CASHBACK_REVERSAL`). A full refund cancels the rest.
- **Not part of the payout cap:** it is paid on top of the level commissions (the plan's 46% + up to 30% = up to 76% of eligible value), so check it against your margin.
- **Daily job:** runs with the commission job (`COMMISSION_JOB_MINUTES`); catches up missed days; safe to run on several servers. `POST /api/admin/jobs/pay-cashback` runs it now.
- **API:** member `GET /api/member/cashback` (totals + each purchase); admin `GET/PUT /api/admin/cashback` `{enabled, percentPerDay, maxDays, maxTotalPercent, includePackages}`.
- **Demo seed:** cashback is ON with packages included (the seeded orders are packages) so the member **Income → CashBack Reward** page has data. Turn it off in the admin if you don't want it.


## Repurchase royalty (10 levels on product purchases)

Admin → **Commission Plan → Create new version → Repurchase royalty (optional)**. A second level table paid on **product (non-package) purchases**, calculated on the **net product value** (after discount, excluding GST and shipping). The plan's example: **L1 4%, L2–L6 1% each, L7–L10 0.5% each = 11%** (₹2,200 net pays ₹88 / ₹22 each / ₹11 each = ₹242). The editor has a "Use the 10-level royalty" shortcut, and the seeded plan already has it.

- **Split:** once a repurchase table exists, the main level table pays **joining packages only** and the royalty pays **products only** (a mixed order pays each part from its own table). With no repurchase table, the main table covers every purchase as before.
- **Same rules as other commission:** delivered orders only, held through the cooling-off period, reversed in proportion on refund, inactive earners skipped, counts toward the payout cap. No fixed repurchase package and no minimum monthly purchase.
- **Member app:** Income → **Repurchase Royalty Income** (levels 1–10, status, release date). Direct Sponsor / Level income pages show joining-package commission only.
- **Public site:** the Levels block shows both tables with the royalty total.
- **API:** `GET /api/member/commissions?type=repurchase`; plan create accepts `repurchaseLevels` (must total ≤ the payout cap); `GET /api/public/catalog` returns `plan.repurchaseLevels`. Commissions now carry `kind` (JOINING | REPURCHASE); the unique index and old rows are migrated on start.
- **Not built (from the same plan):** the 25% direct sponsor income, Team Passive (3% + 2%), Global Magic and Global Rank & Royalty. The doc's 25% direct sponsor figure differs from the 40% level 1 already in the plan, so confirm which is right.


## My Team: Global Purchase Status and Rewards & Awards Status

Two read-only member pages (nothing is paid and no rank changes from them).

- **Global Purchase Status** (`GET /api/member/team/purchases`): the whole downline's buying: team size, who has bought, who bought in the last 30 days, orders and purchase value (net of refunds, cancelled orders left out), a per-level table (levels 1 to 10) and the latest 10 team purchases tagged Joining package / Repurchase.
- **Rewards & Awards Status** (`GET /api/member/rewards`): the member's rank, their team purchases (delivered, net of refunds) and active direct members, and progress bars towards the next rank. **Ranks stay manual:** the head office sets them. Until requirements are published the page says so.
- **Admin → Commission Plan → Rank requirements** (`GET/PUT /api/admin/rank-criteria`): tick Silver / Gold / Diamond and enter the team purchases (₹) and active direct members needed. Empty by default, so nothing is promised until you publish it. No reward amounts exist yet.
- **Still "not active" pages** (rules not defined in `plan.md`): Global Magic, Global Rank Royalty, Team Passive, Rank Rewards. They explain this to members instead of showing made-up figures.


## One-time codes (OTP) by SMS and email

Set in `backend/.env` (see `.env.example`): `APITXT_AUTH_KEY` (SMS through APITxT), `ZEPTOMAIL_URL`, `ZEPTOMAIL_TOKEN`, `ZEPTOMAIL_FROM_ADDRESS`, `ZEPTOMAIL_FROM_NAME` (email through ZeptoMail), optional `OTP_TTL_MINUTES` (default 10) and `COMPANY_NAME` (shown in the email). Both are plain HTTPS calls, so no extra npm packages. **With `NODE_ENV=development` every code is `123456` and nothing is sent** (no SMS or email, so no credits used; the server log shows the line). Never in production, never in tests. Without credentials, outside production, the code is printed in the server log (`[dev] SMS to …`). **In production a missing credential is an error**, never a silent drop. The test runner never reaches the real gateways, and `OTP_DELIVERY=log` (e.g. `OTP_DELIVERY=log npm run dev`) prints codes in the server log instead of sending anything, whatever credentials are set.

Codes are 6 digits, stored only as a salted hash, valid 10 minutes, **5 wrong tries then locked**, one use, a new code cancels the old one, **30 seconds between sends**, at most 4 sends per code per 15 minutes (20 wallet-sale codes), and a code only works for the thing it was issued for.

| Flow | How |
|---|---|
| **Forgot password** (member and franchise/admin apps) | Sign-in page → "Forgot your password?" → email or mobile, choose SMS or email → code + new password. `POST /api/auth/forgot-password`, `POST /api/auth/forgot-password/reset`. Always answers the same, so it never reveals who has an account. |
| **Withdrawal** | The member chooses SMS or email, gets a code, and must enter it to confirm. `POST /api/member/withdrawals/otp {channel}` then `POST /api/member/withdrawals {amountPaise, otp}`. |
| **Franchise sale from the shopping wallet** | The sale sends the **member** a code (their saved preference). The member reads it out; the shop types it in and the payment completes. `POST /api/franchise/payment-requests/:id/confirm {otp}`, `…/resend-otp {channel}`. The code is never shown to the shop. The code works for 5 minutes. If the code cannot be delivered the sale is cancelled and the stock goes back. |

Members choose where shop-payment codes go in **Profile Setting → One-time codes** (`PUT /api/member/otp-channel`, default SMS). SMS goes to the account's 10-digit mobile as `91XXXXXXXXXX`.
