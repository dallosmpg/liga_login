# Liga Login

Simple Node/Express web app for a paragliding XC league:

- Pilots scan a task QR code.
- They enter only their participant number.
- They check in for that task.
- They upload one validated `.igc` file for that task.
- They can delete that upload and replace it if needed.
- Admins create tasks, download QR codes, and export all logs for a task as a `.zip`.

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
- `ADMIN_PASSWORD=use-a-real-password`
- `SECURE_COOKIES=true`
- `TRUST_PROXY=true`

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

## Testing

Run:

```bash
npm test
```

The test covers task creation, check-in, upload rules, and delete/re-upload flow.
It exercises the business logic directly so it can run in restricted environments without opening a local port.
