## What this adds

`fjcqv/dsh-cronops` — a sidebar console for self-hosted task panels (**青龙面板 / Qinglong 2.x** and **呆呆面板 / Daidai 3.x**). Published on npm as [`dsh-cronops`](https://www.npmjs.com/package/dsh-cronops) (latest `0.1.3`).

- Three tabs: **hosts** (panel connections), **environment variables**, **scheduled tasks**.
- Talks to each panel's OpenAPI with an application credential: Qinglong `/open/*` (`client_id`/`client_secret`, 30-day token) and Daidai `/api/v1/*` (`app_key`/`app_secret`, 24-hour token).
- Permission probing is read-only and **persisted per panel**; the hosts table renders the result as Chinese scope chips, so opening the page never re-queries the panel.
- Four agent tools: `cronops_panels`, `cronops_envs`, `cronops_crons`, `cronops_api`.
- Pure JavaScript, no build step, host half depends only on `node:*`; ships `dsh.bundle` (`cordis.patch.yml`) and `dsh.client` (web).

## Accuracy notes for the reviewer

- Tools: four, as named above (`lib/tools.js`).
- Scopes probed read-only: Qinglong 9 resources, Daidai 7 — Daidai notifications is intentionally skipped because its route only accepts panel user tokens.
- In-repo verification: `node scripts/selftest.mjs` (93 assertions, mock panels for both products), `node scripts/check-tools.mjs` (66 assertions, output schemas validated with the harness' own validator).
- Also exercised against real panels: Qinglong 2.24.0 and Daidai 3.4.4 (probe, then an env-var and task create/update/run/log/delete cycle, cleaned up afterwards).

## Entry

Adds only `data/plugins/fjcqv__dsh-cronops.yml` (category `tools`).
