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
sudo apt install -y nodejs npm qrencode zip nginx
```

### Environment

Set these at minimum:

- `PORT=3000`
- `BASE_URL=https://your-domain.example`
- `ADMIN_USERNAME=admin`
- `ADMIN_PASSWORD=use-a-real-password`
- `SECURE_COOKIES=true`
- `TRUST_PROXY=true`

### systemd

Example service file: [deploy/liga-login.service](/Users/martin/liga_login/deploy/liga-login.service)

### nginx

Example reverse proxy config: [deploy/nginx.conf](/Users/martin/liga_login/deploy/nginx.conf)

## Testing

Run:

```bash
npm test
```

The test covers task creation, check-in, upload rules, and delete/re-upload flow.
It exercises the business logic directly so it can run in restricted environments without opening a local port.
