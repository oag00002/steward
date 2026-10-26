# Steward

A web replacement for the Membership, Attendance and Contributions modules of Shepherd's Staff. It runs entirely on **Cloudflare's free plan**: the app, its server code and its database. It works on phones, tablets and computers, so offerings can be entered while the counting happens.

- **Contributions:** envelopes (including shared envelopes for couples and "other givers" outside membership), funds, offering batches with fast envelope entry, checking entries against the counted cash and checks, posting, year-end giving statements, and renumbering envelopes for next year.
- **Membership:** households, people, membership status and church-record dates, seasonal addresses, and a directory.
- **Attendance:** events, a tick-off list by household, head counts, an option to mark givers present when you post an offering, and an absentee report.
- **Imports and backups:** CSV import from Shepherd's Staff or Excel, CSV exports, and a one-click full backup.

This repository holds only the program, never any church data. Each church that uses it keeps its data in its own Cloudflare account.

---

## Setting up a copy on Cloudflare (about 10 minutes, all in the browser)

You need a free [GitHub](https://github.com) account and a free [Cloudflare](https://dash.cloudflare.com/sign-up) account. No credit card or software is needed.

### 1. Get your own copy of this repository
On GitHub, click **Fork** at the top of this page and then **Create fork**.

### 2. Create the database
In the Cloudflare dashboard, go to **Storage & Databases → D1 SQL Database → Create database**. Name it `steward` and click **Create**. Copy the **Database ID** shown on the next page; it looks like `1a2b3c4d-…`.

### 3. Point your copy at that database
In **your fork** on GitHub, open `wrangler.jsonc`, click the pencil icon, and replace the `database_id` value with the ID you copied. Click **Commit changes**.

### 4. Connect it to Cloudflare
In the Cloudflare dashboard, go to **Workers & Pages → Create → Import a repository**. Connect GitHub if asked, then choose your fork. Keep the suggested settings:
- Project name: `steward`
- Deploy command: `npx wrangler deploy`

Click **Deploy**. Cloudflare builds it and gives it an address like `https://steward.<your-subdomain>.workers.dev`.

### 5. Choose a setup code
Open the new Worker and go to **Settings → Variables and Secrets → Add**:
- Type: **Secret**
- Name: `SETUP_CODE`
- Value: a code you make up, at least 8 characters. Write it down.

Click **Deploy**.

### 6. Open the site and create the administrator
Visit the `workers.dev` address. The first time, Steward asks for the setup code, then your name, username and password. The tables are created automatically. After the first administrator exists, the setup screen never appears again; everyone else gets a normal sign-in page.

On a phone, add it to the home screen so it opens like an app: in Safari, **Share → Add to Home Screen**; in Chrome, **⋮ → Add to Home screen**.

### Getting updates
When this repository changes, open your fork on GitHub and click **Sync fork → Update branch**. Cloudflare rebuilds and redeploys automatically within a minute or two. Your data is untouched, and any database changes are applied automatically the next time someone opens the site.

---

## What the free plan allows

| | Free plan | What a church uses |
|---|---|---|
| Workers (the app) | 100,000 requests a day | A few hundred on a busy Sunday |
| D1 (the database) | 500 MB | A few MB per decade of giving |
| D1 Time Travel | Restore to any minute in the last 7 days | — |
| Workers Builds | Automatic deploys from GitHub | A few builds a month |

Cloudflare's limits change from time to time; see [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) and [D1 limits](https://developers.cloudflare.com/d1/platform/limits/).

---

## Using it

### Entering an offering
1. Tap **Count an offering** and pick the date. It defaults to the most recent Sunday.
2. Type the envelope number. The giver's name appears on the envelope card.
3. Press **Tab, Tab**, type the amount, then press **Enter**, the same rhythm as Shepherd's Staff. On a phone, the keyboard's Next key jumps straight from the envelope to the amount, and the fund stays on the last one you used.
4. Use envelope **0** for loose offering. Turn on *Record check numbers* if you want separate cash and check totals.
5. Enter the counted cash and checks under **Check against the count**. The difference should read *Balanced*.
6. The financial secretary presses **Post**. You can also choose to mark everyone who gave as present at Sunday Worship.

Each entry is saved on the phone first and then sent to the server. If the signal drops, the top bar shows *Offline · N saved on this phone*, and the entries send themselves when the connection returns.

### Who can do what

| Access | Can |
|---|---|
| Counter | Start offerings, enter and fix entries, and take attendance. Cannot see posted giving, reports or statements. |
| Financial secretary | Everything a counter can, plus posting, people, envelopes, reports, statements, imports and settings. |
| Administrator | Everything, plus adding people who can sign in and viewing the activity log. |

Add people under **Settings → Who can sign in**. An administrator can reset anyone's password there. If the only administrator is locked out, see *Locked out* below.

### Moving over from Shepherd's Staff
Go to **Settings → Import** and pick a CSV file. Before anything is saved, Steward shows which columns it recognized and a preview.

1. **Households, people and envelopes.** Export a membership or envelope list from Shepherd's Staff and save it as CSV. Column names are matched loosely, so *Env #*, *Envelope*, *Family #*, *Household ID*, *First Name*, *Last Name*, *Family Position*, *Address*, *City*, *State*, *Zip Code*, *Home Phone*, *E-mail*, *Spouse First Name*, *Status* and *Birth Date* all work.
2. **This year's gifts so far.** The file needs the columns *Envelope*, *Date*, *Fund* (number or name) and *Amount*. Importing them means this year's statements are complete. One offering batch is created for each date.

If a column isn't recognized, rename it in Excel and import the file again.

### Year-end
**Settings → Year-end** walks through it:
1. Post every offering.
2. Print statements (*Print or save as PDF* puts one letter on each page).
3. Fill in next year's envelope numbers.
4. Download the spreadsheet for the envelope company.
5. Switch to the new numbers once the boxes are handed out.

Gifts are tied to the giver, not the number, so renumbering never changes history.

Edit the church name, address, signer and letter wording under **Settings**. The default letter includes the IRS "no goods or services" sentence.

### Backups
- **Reports → Full backup** downloads everything as one file. Save one somewhere safe every month and after year-end.
- Cloudflare also keeps 7 days of history, so you can undo a mistake like a bad import. To restore the database to an earlier minute, run this from a computer set up as described under *Locked out*:
  `npx wrangler d1 time-travel restore steward --timestamp=2026-11-01T14:00:00-05:00`

### Moving to a different Cloudflare account later
1. Set up a new copy using the steps above.
2. In the old copy, download a **Full backup**.
3. Ask whoever maintains the code to load it into the new copy, or use `wrangler d1 export` and `wrangler d1 execute --file` (see *For developers*).

### Locked out
If no administrator can sign in, someone with access to the Cloudflare account can reset a password from a computer with [Node.js](https://nodejs.org) 22 or newer:

```bash
npm install
npx wrangler login
npm run create-user -- owen admin
```

### Optional: an extra lock on the door
Steward has its own sign-in, with login throttling and HTTPS-only cookies. For a second layer, Cloudflare Access can require a one-time code sent by email before the sign-in page even loads. To turn it on, go to **Workers & Pages → steward → Access → Protect this Worker behind Access**. This needs Cloudflare Zero Trust, which has a free plan for small teams. See [Cloudflare's guide](https://developers.cloudflare.com/workers/configuration/cloudflare-access/).

---

## For developers

```bash
npm install
cp .dev.vars.example .dev.vars          # sets SETUP_CODE for local testing
npm run dev                             # http://localhost:8787 (local database, created automatically)
BASE=http://localhost:8787 USER_NAME=owen PASS=testpassword123 SETUP_CODE=choose-a-setup-code npm test   # API checks; use a throwaway local database
```

There is no build step. The front end is plain ES modules in `public/js`.

```
wrangler.jsonc         Cloudflare config (Worker + static files + D1 binding)
src/schema.js          database schema; the Worker applies missing steps itself
src/worker.js          router, security headers, errors, automatic schema updates
src/auth.js            first-run setup, sign-in, sessions (stored in D1), roles, throttling
src/password.js        PBKDF2 password hashing (Web Crypto)
src/routes/            membership, contributions, attendance, reports, imports, admin
public/js/             app shell, one file per area, offline outbox (api.js), CSV/exports (csv.js)
scripts/create-user.mjs  reset or add a sign-in from the command line
test/smoke.js          end-to-end API checks
```

**Changing the database:** append a new entry to `MIGRATIONS` in `src/schema.js`. Never edit one that is already deployed.

**Free-plan limits:** the free plan allows 10 ms of CPU and 50 database queries per request, so the heavy work is shaped to fit:
- Imports, renumbering and attendance send many rows as a single JSON parameter.
- The browser parses CSV files, builds the statement letters and assembles exports.
- Exports are fetched in pages.
- Passwords use 60,000 PBKDF2 rounds. The round count is stored with each hash, so it can be raised later.
