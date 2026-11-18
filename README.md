# MEGASheep

Real-time multiplayer trivia. Host on a laptop, players on phones, answers on a TV. Rarer answers score more.

## Surfaces

| Role | URL |
| --- | --- |
| Host | `/host` |
| Players | `/` |
| Projector / TV | `/display` |
| Grading | `/grading-single` (opens from the host console) |

Do not use `/game` or `/grading`. Those redirect to the live player and grading pages.

## Local

```bash
npm install
npm start
```

Open [http://localhost:3001/host](http://localhost:3001/host).

Optional `.env`:

```
PORT=3001
DATABASE_URL=
SUPABASE_URL=
SUPABASE_ANON_KEY=
```

Question source, in order:

1. **Railway Postgres** — `questions` table via `DATABASE_URL` (this replaces Supabase for shows)
2. **Show bank** — `sample-questions.txt` in the repo
3. **Demo** — five built-in prompts, only if the host picks Demo or both of the above are empty

An empty Postgres database is seeded from `sample-questions.txt` on boot. To replace the bank later:

```bash
railway run --service MEGASheep node loadQuestions.js sample-questions.txt --preview
railway run --service MEGASheep node loadQuestions.js sample-questions.txt --confirm
```

`--confirm` replaces the entire question bank. Without it, the file is only previewed.

## How to run a show

1. Host: **Create New Game** and share the 4-digit code.
2. The picker loads the show bank automatically. Select any count, then **Use Selected**, or just start — start uses that same bank.
3. Players join at `/` with the code and a name. Open `/display` on the TV.
4. **START GAME**. Players answer on their phones.
5. When time is up (or **END QUESTION NOW**), grade in the host overlay, then continue.
6. Stress test: **VIRTUAL TEST** adds fake players who join and answer.

Games live in memory on one server process. A restart wipes the current lobby.

## Deploy

Railway, one app replica plus Postgres. GitHub `master` auto-deploys. The app reads `DATABASE_URL` from the Postgres service.

**Do not deploy, restart, or scale the app during a live show.** Games live in memory on a single process. A restart, redeploy, or second replica still ends the live sockets. Recover Game can restore seats, answers, and send-backs so phones can rejoin; it cannot put the old sockets back.

Live: [https://megasheep.liquidkourage.com](https://megasheep.liquidkourage.com)
