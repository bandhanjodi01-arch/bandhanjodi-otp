# BandhanJodi - OTP Verification Server

Real-time OTP verification API (email + mobile) for the BandhanJodi matrimony site.

## Endpoints

- `GET  /api/health`    -> `{ "ok": true }`
- `POST /api/send-otp`  -> body `{ "type": "mobile"|"email", "destination": "..." }`
- `POST /api/verify-otp` -> body `{ "destination": "...", "otp": "123456" }`

## Run locally

```bash
npm install
cp .env.example .env     # then edit .env (SMS_PROVIDER=console is fine to start)
npm start                # http://localhost:5000
```

## Deploy

See SETUP-GUIDE.md for the full walkthrough (hosting, SMS/email providers,
GoDaddy DNS, and pointing the front-end at this server).

## Security

Codes are stored hashed, expire in 5 minutes, allow 5 attempts, are one-time
use, and are rate-limited per number and per IP. Keep all provider credentials
in environment variables - never in the front-end.
