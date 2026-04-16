# Liga Login - Vibecode alert

Simple Node/Express web app for a paragliding XC league:

- Pilots scan a task QR code.
- They enter only their participant number.
- They check in for that task; admins can allow QR-code check-in while requiring
  GPS presence within a configured radius for non-QR check-ins.
- They upload one validated `.igc` file for that task.
- They can delete that upload and replace it if needed.
- Admins create tasks, download QR codes, export checked-in pilots as `.csv`,
  and export all logs for a task as a `.zip`.

## What the app validates

The backend performs basic structural IGC validation:

- `.igc` extension is required
- header `A` record must exist
- `HFDTE` date record must exist and parse correctly
- at least 3 valid `B` fix records must exist

This is practical server-side validation, not full cryptographic validation of manufacturer signatures.

## Local Run

1. Install dependencies:

```bash
npm install
```

2. Ensure runtime tools are available:

```bash
qrencode --version
zip -v
```

3. Set environment variables if you want values other than the defaults:

```bash
cp .env.example .env
```

The app loads `.env` from the project root on startup. Real environment
variables still take precedence over values in `.env`.

4. Start the app:

```bash
npm start
```

5. Open:

- `http://localhost:3000/admin`
- admin default username: `admin`
- admin default password: `change-me`

Change the admin password before deploying anywhere public.

## Storage Layout

- metadata: `data/state.json`
- task logs: `storage/tasks/<task-id>/logs/<participant_id>.igc`
- task QR: `storage/tasks/<task-id>/qr/task.svg`
- temporary ZIP exports: `storage/exports`

## Check-in Modes

When creating a task, admins can choose one of two check-in modes:

- `QR/link alapján, helyellenőrzés nélkül`: any pilot who opens the task link can
  check in without GPS.
- `QR-kód vagy GPS hely alapján`: the task QR code contains a private check-in
  proof token, so pilots who scan that QR can check in without GPS. Pilots who
  open the task without that QR token must pass the configured GPS radius check.

The normal public task URL does not include the QR proof token. Only the
downloaded QR code URL includes it. Because the token is embedded in the QR URL,
anyone who receives that full QR URL can also use the QR path, so treat printed
QR codes and screenshots as check-in access.

After deploying this feature, re-download and reprint QR codes for GPS-enabled
tasks. Old QR codes that only contain `/task/<token>` do not contain the QR
proof token and will require GPS like any other non-QR link.

## VPS Notes

This app is meant to run well on a small Hetzner VPS without a database.

### Ubuntu packages

```bash
sudo apt update
sudo apt install -y nodejs npm qrencode zip caddy
sudo npm install -g pm2
```

### Environment

Create `/srv/liga_login/.env` and set these at minimum:

- `PORT=3000`
- `BASE_URL=https://your-domain.example`
- `ADMIN_USERNAME=admin`
- `ADMIN_PASSWORD_HASH=scrypt$...`
- `SECURE_COOKIES=true`
- `TRUST_PROXY=true`

Generate the admin password hash on the server:

```bash
cd /srv/liga_login
npm run hash-password
```

Enter the password when prompted. The script prints a line like:

```bash
ADMIN_PASSWORD_HASH=scrypt$16384$8$1$64$...
```

Put that full line in `/srv/liga_login/.env`. Do not put `ADMIN_PASSWORD` in
the production `.env`.

When `NODE_ENV=production`, the app refuses to start unless
`ADMIN_PASSWORD_HASH` is a valid scrypt hash. The plain `ADMIN_PASSWORD`
fallback exists only for local development. PM2 loads the root `.env` because
the app reads that file on startup, so restart PM2 after changing the hash.

Optional rate-limit settings:

- `ADMIN_LOGIN_RATE_LIMIT_MAX=10`
- `ADMIN_LOGIN_RATE_LIMIT_WINDOW_MS=900000`
- `PUBLIC_WRITE_RATE_LIMIT_MAX=120`
- `PUBLIC_WRITE_RATE_LIMIT_WINDOW_MS=60000`
- `PUBLIC_UPLOAD_RATE_LIMIT_MAX=30`
- `PUBLIC_UPLOAD_RATE_LIMIT_WINDOW_MS=900000`

These defaults limit admin login attempts per IP, public check-in/delete
requests per IP, and public upload attempts per IP plus task token.

### PM2

Start the app from the deploy directory:

```bash
cd /srv/liga_login
NODE_ENV=production pm2 start server.js --name liga-login
pm2 startup
pm2 save
```

`pm2 startup` prints a `sudo ...` command. Run that printed command once so PM2
starts again after a reboot.

After changing `.env` or deploying new code, restart the app:

```bash
pm2 restart liga-login
```

Useful checks:

```bash
pm2 status
pm2 logs liga-login
```

### Caddy

Example `/etc/caddy/Caddyfile`:

```caddyfile
your-domain.example {
    reverse_proxy 127.0.0.1:3000
}
```

Reload Caddy after changing the Caddyfile:

```bash
sudo caddy reload --config /etc/caddy/Caddyfile
```

Caddy terminates HTTPS and proxies to the local Node process. Keep these values
enabled in `/srv/liga_login/.env` when running behind Caddy:

- `SECURE_COOKIES=true`
- `TRUST_PROXY=true`

The app sends CSP, frame protection, content sniffing, referrer, permissions,
and HSTS headers itself. HSTS is only sent when `SECURE_COOKIES=true`, which is
the expected production setting behind Caddy HTTPS.

## Testing

Run:

```bash
npm test
```

The test covers task creation, check-in, upload rules, and delete/re-upload flow.
It exercises the business logic directly so it can run in restricted environments without opening a local port.
