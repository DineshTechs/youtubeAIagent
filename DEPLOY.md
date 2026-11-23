# Hosting the YouTube AI Agent (MilesWeb / cPanel "Setup Node.js App")

This puts the public home page, the dashboard and the API on one address, e.g.
`https://aividman.store` (home page) and `https://aividman.store/app/` (dashboard, behind a login).
Product name, contact details and policies are edited in the dashboard: Settings → Home page. Your PC setup (`start-app.bat`) keeps working exactly as before.

## What changes on a server

| | On your PC | On the server |
|---|---|---|
| Login | none | admin username + password (required) |
| Dashboard | Vite on :5173 | built files served by the API (same address) |
| Database | local MongoDB | MongoDB Atlas |
| HTTPS | no | yes (cPanel AutoSSL) |
| Other websites calling the API | allowed from localhost | refused |

Security that is switched on automatically with `NODE_ENV=production`:
- every `/api` and `/storage` (video) request needs the login cookie
  (only `/api/health`, the login itself and Google's YouTube callback are open);
- if no admin password is set, the API **stays locked** instead of running open;
- passwords are checked with scrypt; 5 wrong tries from one address block it for 15 min;
- the session cookie is `HttpOnly`, `Secure`, `SameSite=Strict`, signed, expires after 7 days,
  and changing the password logs everyone out;
- changes (POST/PUT/DELETE) from other websites are refused;
- security headers: Content-Security-Policy, HSTS, no framing, no-sniff, `no-store` on the API;
- API keys and YouTube tokens stay encrypted in the database (AES-256-GCM).

## 1. Before you start — read this

Shared Node.js hosting (cPanel + Passenger) has limits that matter for this app:

1. **The app is stopped when nobody visits it.** Then the video worker, Autopilot and
   the Telegram bot stop too. Step 7 adds a cron "ping" every 5 minutes to keep it awake.
2. **CPU / memory limits.** Rendering (FFmpeg) and the text check on images (OCR) are heavy.
   If videos fail with "killed", "out of memory" or time out, the plan is too small —
   ask MilesWeb for higher limits or move to a VPS (the same code runs there).
3. **One app process only.** In Setup Node.js App keep a single instance; two copies would
   both poll Telegram and both run Autopilot.

## 2. MongoDB Atlas

1. Create a free cluster at <https://cloud.mongodb.com>.
2. **Database Access** → add a user with a long password (role: read and write).
3. **Network Access** → add your server's IP address (ask MilesWeb for the outgoing IP
   of your account). Avoid `0.0.0.0/0` if you can.
4. **Connect → Drivers** → copy the `mongodb+srv://…` address and put the database name
   in it, e.g. `…mongodb.net/youtube_agent?retryWrites=true&w=majority`.

Moving your existing videos/profiles (optional): on your PC run
`mongodump --db kids_youtube_agent` and then
`mongorestore --uri "<atlas uri>" --nsFrom "kids_youtube_agent.*" --nsTo "youtube_agent.*" dump/`.
If you move the data, also copy `server/storage/.keys/app-secret.key` to the same place on the
server (and **do not** set `APP_SECRET_KEY`), otherwise saved keys cannot be decrypted —
just re-enter them in Settings in that case.

## 3. Build the dashboard (on your PC)

```bat
cd D:\WebApps\youtubeAIagent
npm install
npm run build
```
This creates `client\dist`. Upload it together with the rest of the project.

## 4. Upload

Upload the project folder (for example to `/home/<cpanel-user>/youtubeAIagent`) **without**
`node_modules`, `server/storage` and `.env`. You need at least:
`server/` (with `eng.traineddata` and `hin.traineddata`), `client/dist/` and `client/landing/`.
Git: cPanel → Git Version Control can clone your GitHub repo instead; then upload only `client/dist`.

## 5. Create the Node.js app (cPanel → Setup Node.js App → Create Application)

- **Node.js version:** 20 or newer
- **Application mode:** Production
- **Application root:** `youtubeAIagent/server`
- **Application URL:** your domain / subdomain
- **Application startup file:** `app.cjs`
- **Environment variables** — see `server/.env.example`. The essential ones:

| Name | Value |
|---|---|
| `NODE_ENV` | `production` |
| `PUBLIC_URL` | `https://aividman.store` |
| `MONGODB_URI` | the Atlas address |
| `APP_SECRET_KEY` | a long random text (keep a copy somewhere safe) |
| `ADMIN_USERNAME` | `admin` (or your choice) |
| `ADMIN_PASSWORD_HASH` | from `npm run hash-password -- "your long password"` (run in `server` on your PC) |

Then **Run NPM Install**, and **Restart**. Open your domain: you should see the home page;
`/app/` shows the login page.

`ffmpeg` comes with the app (`ffmpeg-static`). If renders fail with "FFmpeg executable was not
found" or "permission denied", ask MilesWeb whether ffmpeg is installed and set `FFMPEG_PATH`.

## If your panel asks for a "command" and a "port" (no startup file)

Some MilesWeb plans run Node apps with a start **command** behind a proxy **port** (the log
shows `PersistentApp … port: 3000, command: "npm start"`). Then:

- **Command:** `npm start` (runs only the server — it serves the home page, the built dashboard and the API).
- **Port:** the server must listen on the port the panel proxies to. Set the environment
  variable `PORT=3000` (or the port your panel shows), or put `PORT=3000` in `server/.env`.
- **Working directory:** the project folder that contains `package.json`, `server/` and `client/`.
- Build the dashboard first (`npm run build`, on your PC before uploading, or once on the server).
- Put the environment variables from step 5 in the panel, or in `server/.env` (never inside a folder the
  web server shows directly). Afterwards open `https://aividman.store/server/.env` — it must **not** download anything.

## 6. HTTPS

cPanel → **SSL/TLS Status** → run AutoSSL for the domain (free certificate).
Optional: cPanel → Domains → "Force HTTPS Redirect".

## 7. Keep it awake (cron)

cPanel → **Cron Jobs** → every 5 minutes (`*/5 * * * *`):
```
curl -fsS https://aividman.store/api/health > /dev/null
```

## 8. YouTube connection

Google Cloud Console → your OAuth client (type **Web application**) → **Authorized redirect URIs**:
add `https://aividman.store/api/youtube/callback`. Then in each profile's YouTube tab,
clear the old `127.0.0.1` redirect address (leave it empty to use the default) and connect again.
Keep the `http://127.0.0.1:4000/api/youtube/callback` address too if you still use the app on your PC.

## 9. Telegram

Nothing to change: the bot polls Telegram from the server. Stop the app on your PC (or turn
off its bots) — the same bot token can only be polled by one copy at a time.

## Updating later

Build again on your PC (`npm run build`), upload the changed files, then **Restart** in
Setup Node.js App (run NPM Install again only when `package.json` changed). The dashboard
shows a "restart" bar when new code is waiting.

## Useful checks

- `https://aividman.store/api/health` → `{"ok":true,"authRequired":true}`
- Logs: `server/storage/logs/backend-lifecycle.log` and `backend-crash.log`, plus the app's
  `stderr.log` / Passenger log in the application root.
- Locked out? Set a new `ADMIN_PASSWORD_HASH` and restart (this also logs out every session).

## Search engines (SEO) after going live

The home page already has: title and description, canonical address, social-sharing image
(`/og-image.png`), icons, structured data (product with the four prices, FAQ), `robots.txt`
(the dashboard, API and videos are excluded) and `sitemap.xml`. Both use `PUBLIC_URL`.

1. **Google Search Console** (<https://search.google.com/search-console>) → Add property →
   Domain `aividman.store` → verify with the DNS TXT record (cPanel → Zone Editor).
2. Sitemaps → submit `https://aividman.store/sitemap.xml`.
3. URL inspection → `https://aividman.store/` → Request indexing.
4. **Bing Webmaster Tools** → import from Google Search Console.
5. Check sharing: paste the address into <https://www.opengraph.xyz> (or WhatsApp/Telegram) — the
   red "AI Video Manager" card should appear. Check structured data with
   <https://search.google.com/test/rich-results>.
6. Make `www.aividman.store` redirect to `aividman.store` (cPanel → Domains → Redirects, 301),
   so Google sees one address.
