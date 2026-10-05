# BandhanJodi — Real-Time OTP Verification: Setup & Deployment Guide

This guide takes you from "static site with an OTP screen" to a live site where
users actually receive a code by SMS or email and it is verified on your server.

---

## 0. The one thing to understand first

**GitHub Pages is static hosting only. It cannot run a server.**

Your `index.html` is the *front-end* — it draws the OTP boxes and sends requests.
The thing that generates the code, sends the SMS/email, and checks the code is a
*back-end server*. That server needs a host that can run code (Node.js), which
GitHub Pages cannot do.

So your setup has **three moving parts**:

| Part | What it is | Where it lives |
|------|------------|----------------|
| Front-end | `index.html` (your site) | GitHub Pages → `bandhanjodi.com` |
| Back-end | `server.js` (the OTP API) | A code host, e.g. Render / Railway / Fly.io |
| Delivery | SMS gateway and/or email service | MSG91 / Fast2SMS / Twilio, SendGrid / Resend / SMTP |

Your GoDaddy **domain** is just the address. You point it at the front-end, and
optionally point an `api.` sub-domain at the back-end. The domain itself does not
run anything.

Your existing front-end already talks to the back-end at these two routes:

- `POST {BACKEND_URL}/send-otp`  → `{ "type": "mobile" | "email", "destination": "..." }`
- `POST {BACKEND_URL}/verify-otp` → `{ "destination": "...", "otp": "123456" }`

The `server.js` in this package implements exactly those routes.

---

## 1. What you'll need

- A GitHub account (you have one) and the repo that will hold `index.html`.
- A free account on a code host — this guide uses **Render** (free tier, easiest).
- An SMS and/or email provider account (see Section 3).
- Access to your GoDaddy DNS panel.

---

## 2. Deploy the back-end server

### 2a. Put the server in a GitHub repo

Create a new repo (e.g. `bandhanjodi-otp`) and add the files from the
`otp-server` folder:

```
server.js
package.json
.env.example
.gitignore
```

Do **not** commit a real `.env` file — `.gitignore` already excludes it.

### 2b. Deploy on Render

1. Go to render.com → **New → Web Service**.
2. Connect your GitHub and pick the `bandhanjodi-otp` repo.
3. Settings:
   - **Environment:** Node
   - **Build command:** `npm install`
   - **Start command:** `npm start`
   - **Instance type:** Free
4. Under **Environment → Environment Variables**, add the variables from
   `.env.example` that you need (at minimum `OTP_SECRET` and `ALLOWED_ORIGINS`;
   plus your chosen provider's keys — see Section 3).
5. Click **Create Web Service**. When it finishes you get a URL like
   `https://bandhanjodi-otp.onrender.com`.

Test it in a browser: open `https://bandhanjodi-otp.onrender.com/api/health`.
You should see `{"ok":true,...}`.

> Render's free tier sleeps after ~15 minutes idle and takes a few seconds to
> wake. That's fine for a small site. Railway and Fly.io are good alternatives.

### 2c. (Alternative) other hosts

- **Railway** – similar flow, `npm start`, add env vars.
- **Fly.io** – needs a `Dockerfile` or `flyctl launch`; more control.
- **Vercel / Netlify Functions** – possible, but your server must be refactored
  into serverless functions. Render/Railway is a simpler fit for this code.

---

## 3. Choose and configure a delivery provider

You set two environment variables on your host:

- `SMS_PROVIDER` = `console` | `msg91` | `fast2sms` | `twilio`
- `EMAIL_PROVIDER` = `console` | `sendgrid` | `resend` | `smtp`

`console` prints the code to the server logs — perfect for testing, sends nothing.

### 3a. SMS in India — read this first (DLT)

India's telecom regulator (TRAI) requires **DLT registration** for all commercial
SMS, including OTPs. Before any Indian gateway will deliver to real numbers you
must register:

- your **entity** (business),
- a **sender ID / header** (e.g. `BNDJOD`),
- and the **message template** for the OTP.

All the Indian providers below (and Twilio, for India-bound SMS) require this.
It is a one-time paperwork step and can take a few days — plan for it. Until it's
done, use `SMS_PROVIDER=console` to test the flow end to end.

**Provider options:**

- **MSG91** (`msg91.com`) — popular in India, simple dashboard, DLT supported.
  Env: `MSG91_AUTH_KEY`, `MSG91_TEMPLATE_ID`, `MSG91_VAR_NAME`.
- **Fast2SMS** (`fast2sms.com`) — cheap, quick to start.
  Env: `FAST2SMS_API_KEY`.
- **Twilio** (`twilio.com`) — global, great docs, trial credit.
  Env: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`.

### 3b. Email OTP — no DLT needed

Email is the fastest path to "real" delivery with no telecom paperwork:

- **Resend** (`resend.com`) — easy, generous free tier. Env: `RESEND_API_KEY`.
- **SendGrid** (`sendgrid.com`) — well known. Env: `SENDGRID_API_KEY`.
- **SMTP** (Gmail app-password, Zoho, your hosting email) — Env:
  `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`. Needs `nodemailer`
  (`npm i nodemailer`).

Whichever you use, set `MAIL_FROM` to an address on your own domain (e.g.
`no-reply@bandhanjodi.com`) and verify the domain with the provider so mail
isn't marked spam.

### 3c. Set `ALLOWED_ORIGINS`

Set this to your real site origins so only your site can call the API:

```
ALLOWED_ORIGINS=https://bandhanjodi.com,https://www.bandhanjodi.com,https://yourusername.github.io
```

---

## 4. Point the front-end at the back-end

Open `index.html`, find the `BACKEND_URL` line near the top of the last
`<script>` block (it ships as `https://api.bandhanjodi.com/api`), and set it to
your real back-end URL:

```js
// If you are NOT using a custom api sub-domain:
var BACKEND_URL = 'https://bandhanjodi-otp.onrender.com/api';

// Or, after Section 6b (custom sub-domain):
var BACKEND_URL = 'https://api.bandhanjodi.com/api';
```

Note the `/api` on the end — the server's routes are `/api/send-otp` and
`/api/verify-otp`.

---

## 5. Host the front-end on GitHub Pages

1. Put `index.html` in your site repo (a repo named
   `yourusername.github.io` publishes at the root, or use any repo + Pages).
2. Repo → **Settings → Pages** → Source: **Deploy from a branch**,
   Branch: `main`, folder `/ (root)` → Save.
3. Your site goes live at `https://yourusername.github.io/` (and later at your
   domain).

---

## 6. Connect your GoDaddy domain

You have two addresses to think about: the **site** (`bandhanjodi.com`) and,
optionally, the **API** (`api.bandhanjodi.com`).

### 6a. Point the main domain at GitHub Pages

In GoDaddy → **My Products → DNS** for `bandhanjodi.com`:

1. Delete any existing `A` records for `@` and the `CNAME` for `www`.
2. Add four **A** records, Name `@`, pointing to GitHub's IPs:

   ```
   185.199.108.153
   185.199.109.153
   185.199.110.153
   185.199.111.153
   ```

3. Add a **CNAME** record, Name `www`, Value `yourusername.github.io`.
4. In your repo, create a file named `CNAME` (no extension) containing exactly
   `bandhanjodi.com`.
5. In GitHub → Settings → Pages, set **Custom domain** to `bandhanjodi.com` and
   tick **Enforce HTTPS** (wait for the certificate to be issued — can take up
   to 24 hours).

### 6b. (Optional) Give the API a clean sub-domain

1. In GoDaddy DNS add a **CNAME**: Name `api`, Value your back-end host
   (e.g. `bandhanjodi-otp.onrender.com`).
2. In Render → your service → **Settings → Custom Domains**, add
   `api.bandhanjodi.com` and follow the verification steps.
3. Now set `BACKEND_URL = 'https://api.bandhanjodi.com/api'`.

---

## 7. HTTPS and CORS — two gotchas that bite everyone

- **Mixed content:** GitHub Pages serves over HTTPS. A browser will *block*
  calls to an `http://` API. Your back-end URL must be `https://` (Render,
  Railway, Fly all give you HTTPS automatically). Never leave `localhost` in a
  live page.
- **CORS:** the browser checks that the API allows your site's origin. That's
  what `ALLOWED_ORIGINS` is for. If you see a CORS error in the browser console,
  your origin isn't in that list.

---

## 8. Test checklist (do these in order)

1. `https://<your-backend>/api/health` returns `{"ok":true}`.
2. With `SMS_PROVIDER=console`, click **Log In → Continue with Mobile**, enter a
   number, press Next. Check your back-end **logs** — the OTP should be printed
   there.
3. Type that code into the boxes and press **Verify & Proceed** → "Verified".
4. Switch `SMS_PROVIDER`/`EMAIL_PROVIDER` to your real provider, redeploy, and
   test with your own number/email.
5. Confirm the live site (`https://bandhanjodi.com`) can send and verify, with no
   errors in the browser console.

---

## 9. Security notes (please keep these)

- **Never** put provider API keys in `index.html` — the browser would expose them
  to anyone. Keys live only in the server's environment variables.
- Codes are stored **hashed**, expire in 5 minutes, allow **5 attempts**, are
  **one-time use**, and are rate-limited per number and per IP.
- The front-end no longer fakes success when the server is unreachable — it shows
  a real error, so you'll notice a misconfiguration immediately.
- For higher traffic or multiple server instances, move the OTP store from
  in-memory to **Redis** (the code marks exactly where).
- Consider adding a **CAPTCHA** (e.g. hCaptcha) to `send-otp` to stop abuse, and
  issuing a **JWT/session** after successful verification (marked as a `TODO` in
  `server.js`).

---

## 10. File map

```
otp-server/
  server.js        The OTP API (send + verify, hashing, expiry, rate limits)
  package.json     Dependencies and start script
  .env.example     Every setting you can use — copy to .env locally
  .gitignore       Keeps .env and node_modules out of git
index.html         Your front-end, with BACKEND_URL wired up
SETUP-GUIDE.md     This document
```

Run locally to try it before deploying:

```bash
cd otp-server
npm install
cp .env.example .env      # then edit .env (SMS_PROVIDER=console is fine to start)
npm start                 # server on http://localhost:5000
```

Then in `index.html` set `BACKEND_URL = 'http://localhost:5000/api'` while
testing locally.
