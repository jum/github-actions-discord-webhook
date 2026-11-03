# Discord Webhook Action (GitHub + Gitea, Node/JS rewrite)

A Node.js rewrite of [DiscordHooks/github-actions-discord-webhook](https://github.com/DiscordHooks/github-actions-discord-webhook)
(the bash + Ruby original), packaged as a proper JavaScript Action using `@actions/core`
and `@actions/exec` instead of `git clone`-ing a helper repo into your workflow at run time.

It sends a Discord embed describing the job status, commit, and branch/PR — and works
unmodified on both **GitHub Actions** and **Gitea Actions** (via `act_runner`), auto-detecting
which platform it's running on from `GITHUB_SERVER_URL`.

## Why this exists

The original script:
- Required `git clone`-ing the whole action repo into the workflow at run time.
- Built JSON via bash string concatenation (fragile, easy to break with special characters).
- Used a Ruby script + `actions/setup-ruby` just to fetch a PR title from the GitHub API.
- Hardcoded `github.com` / `api.github.com` URLs, which breaks on Gitea (this is what
  [jum's fork](https://github.com/jum/github-actions-discord-webhook) patched, via
  [DiscordHooks#18](https://github.com/DiscordHooks/github-actions-discord-webhook/pull/18)).

This version fixes all of that: it's a real `action.yml` (`runs: using: node20`), builds the
payload as a plain JS object (`JSON.stringify`d, no escaping bugs), uses the Actions toolkit
for logging/inputs, and branches its URL-building logic for GitHub vs. Gitea explicitly.

## Usage

### GitHub Actions

```yaml
- name: Send Discord webhook
  if: always()
  uses: your-org/discord-webhook-action@v1
  with:
    status: ${{ job.status }}
    webhook_url: ${{ secrets.WEBHOOK_URL }}
    token: ${{ secrets.GITHUB_TOKEN }}   # optional, enables PR-title lookup
```

### Gitea Actions

Identical usage — the action auto-detects Gitea from `GITHUB_SERVER_URL`. Modern Gitea
versions automatically inject a job-scoped token as `secrets.GITEA_TOKEN`, so in most
cases you don't need to create one manually — just make sure the job has `pull-requests: read`
permission (or your instance's default token permissions already allow it):

```yaml
- name: Send Discord webhook
  if: always()
  uses: your-org/discord-webhook-action@v1
  with:
    status: ${{ job.status }}
    webhook_url: ${{ secrets.WEBHOOK_URL }}
    token: ${{ secrets.GITEA_TOKEN }}
    platform: gitea                     # optional override, default: auto
```

If your instance doesn't auto-inject a token, or you want to call across repos the job
token can't reach, generate a personal/repo access token (Settings → Applications →
Generate Token) with `pull-requests: read`, store it as a repo secret, and reference that
secret instead.

> **Note:** this action reads commit author/subject/body via `git log`, so it must run
> *after* a checkout step (`actions/checkout` on GitHub, or the equivalent on Gitea) in the
> same job.

## Inputs

| Input         | Required | Default                              | Description |
|---------------|----------|---------------------------------------|-------------|
| `status`      | yes      | —                                     | Job status, e.g. `${{ job.status }}` (`success`, `failure`, `cancelled`). |
| `webhook_url` | yes      | —                                     | Discord webhook URL. Space-separate multiple URLs to notify several channels. |
| `token`       | no       | —                                     | API token used only to look up the PR title on pull-request events. On GitHub use `secrets.GITHUB_TOKEN`; on modern Gitea use the auto-injected `secrets.GITEA_TOKEN`. Omit to fall back to the merge commit's own subject line. |
| `platform`    | no       | `auto`                                | `auto`, `github`, or `gitea`. |
| `username`    | no       | —                                     | Override the webhook bot's display name. |
| `avatar_url`  | no       | `https://github.com/actions.png`      | Override the avatar shown in Discord. |

## Development

```bash
npm install
npm run build   # bundles src/index.js -> dist/index.js via @vercel/ncc
```

`dist/index.js` is the file `action.yml` actually runs (it's a self-contained bundle, no
`node_modules` needed at runtime) — rebuild and commit it whenever you change `src/index.js`.
