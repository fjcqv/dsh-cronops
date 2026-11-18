## What this adds

`fjcqv/dsh-cronops` — a sidebar console for self-hosted task panels (青龙 panel / Qinglong 2.x and 呆呆 panel / Daidai 3.x).

- Three tabs: **hosts** (panel connections), **environment variables**, **scheduled tasks**.
- Connects over each panel's OpenAPI app credential: Qinglong `/open/*` (`client_id`/`client_secret`, 30-day token) and Daidai `/api/v1/*` (`app_key`/`app_secret`, 24-hour token).
- Permission probing is read-only and persisted per panel (`panel.test`); the hosts table renders the result as Chinese scope chips, so a page load never re-queries the panel.
- Four agent tools: `cronops_panels`, `cronops_envs`, `cronops_crons`, `cronops_api`.
- Ships `dsh.bundle` (`cordis.patch.yml`) + `dsh.client` (web); pure JavaScript, no build step, no runtime dependencies outside `node:*`.

## Accuracy notes for the reviewer

- Tools: four, as named above (`lib/tools.js`).
- Scopes probed read-only: Qinglong 9 resources, Daidai 7 (notifications is intentionally skipped: its route only accepts panel user tokens).
- Verification in-repo: `node scripts/selftest.mjs` (93 assertions, mock panels for both products), `node scripts/check-tools.mjs` (66 assertions, tool output schemas validated with the harness' own validator).
- Also exercised against real panels: Qinglong 2.24.0 and Daidai 3.4.4 (probe + env var and task create/update/run/log/delete cycle, then cleaned up).

## Entry

Adds only `data/plugins/fjcqv__dsh-cronops.yml` (category `tools`).
