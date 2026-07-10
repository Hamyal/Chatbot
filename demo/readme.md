# Stone AI Demo Runbook

Set `OPENAI_API_KEY` in `stone-ai-chat/.env.local` to use **OpenAI tool-calling**.  
If it is unset, `/api/chat` falls back to rule-based tool routing.

## 1) Start backend

```bash
cd C:\Users\hamya\Downloads\restapi\stone-api
npm install
npm run dev
```

Expected:
- Server starts on `http://localhost:3001`
- `GET http://localhost:3001/api/health` returns `ok: true`

## 2) Start frontend

```bash
cd C:\Users\hamya\Downloads\restapi\stone-ai-chat
npm install
npm run dev
```

Open:
- `http://localhost:3000`

## 3) Verify chat flow

Try these prompts in the UI:
- `Find white marble slabs`
- `show black granite stone`
- `get vietnam time`
- `product detail M742`

The flow is:
`UI -> /api/chat -> tool selection -> REST API -> response`

## 4) Verify protected endpoint

Configured key in this demo:
- `dev-local-stone-key`

Test:

```bash
curl -H "x-api-key: dev-local-stone-key" http://localhost:3001/api/aiData/get-material-content-pages
```

## 5) MySQL optional mode

By default this demo uses mock data.  
To switch to MySQL, set these in `stone-api/.env`:
- `DB_HOST`
- `DB_PORT`
- `DB_USER`
- `DB_PASSWORD`
- `DB_NAME`

Then validate schema:

```bash
cd C:\Users\hamya\Downloads\restapi\stone-api
npm run validate:schema
```

## 6) OpenAI

In `stone-ai-chat/.env.local`:

```env
OPENAI_API_KEY=sk-...
AI_DATA_API_KEY=...same as stone-api...
STONE_API_BASE_URL=http://localhost:3001/api
```

Optional: `OPENAI_MODEL=gpt-4o-mini` (default) or `gpt-4o`, etc.

Restart `npm run dev` after editing env.
