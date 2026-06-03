# AGENTS.md

## Cursor Cloud specific instructions

### Overview

This is a single-service Telegram bot (Node.js / Express) that integrates with the Moyklass CRM API. The entire application is in `index.js`.

### Running the app

```
BOT_TOKEN=<token> MOYK_API_KEY=<key> npm start
```

The server listens on `PORT` (default `3000`). The webhook endpoint is `POST /bot<BOT_TOKEN>`.

### Required environment variables

| Variable | Purpose |
|---|---|
| `BOT_TOKEN` | Telegram Bot API token |
| `MOYK_API_KEY` | Moyklass API key |
| `PORT` | *(optional, default 3000)* Express listen port |

### Testing locally without external APIs

You can verify the server starts and the webhook endpoint responds by using placeholder env vars:

```
BOT_TOKEN=test_token MOYK_API_KEY=test_key npm start
```

Then send a POST to `http://localhost:3000/bottest_token` with a JSON body like `{"message":{"chat":{"id":1},"text":"/start"}}`. The server will return 200 OK. Outbound calls to Telegram and Moyklass will fail, but the Express routing and request handling can be validated this way.

### Notes

- There are no automated tests, linter, or build step in this project.
- The app uses ES Modules (`"type": "module"` in `package.json`).
- `node-fetch` and `node-cron` are declared as dependencies but the code uses the native `fetch` (Node 18+) and has no cron jobs yet.
