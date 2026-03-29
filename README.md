# Lightweight Study App

Separate Lightweight Charts prototype for stock study, kept independent from the earlier KLineChart-style study project.

## What it has

- Lightweight Charts price pane
- Volume pane
- RSI 14 pane
- Optional MACD pane
- Backend-driven NSE stock and index search
- Default symbol: `NIFTY 50`
- Production API fallback to `https://tickertap-backend-88ts.onrender.com`

## Local run

```bash
npm install
npm run dev
```

In local dev, `/api` requests are proxied to:

```text
http://localhost:8000
```

So if you want live local broker/history behavior, keep the backend running there.

## Production env

Use:

```env
VITE_API_BASE_URL=https://tickertap-backend-88ts.onrender.com
```

Reference:

- [.env.example](./.env.example)

## Deploy to Vercel

- Framework: `Vite`
- Build command: `npm run build`
- Output directory: `dist`
- Env var:
  - `VITE_API_BASE_URL=https://tickertap-backend-88ts.onrender.com`

SPA routing support is included in:

- [vercel.json](./vercel.json)
