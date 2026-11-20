# Scope Guard Lite

A free GitHub Action that checks pull requests written by AI coding agents (Cursor, Claude Code, Copilot, Codex and the like) and leaves **one comment** with anything risky it finds. It warns only. It never blocks a merge.

Free checks:

- **Committed secrets**: known credential formats (AWS, GitHub, Stripe, Slack, Google, npm, PyPI, SendGrid, private keys, JWTs) and database URLs with an embedded password. Values are redacted in the comment.
- **Destructive SQL**: `DROP TABLE`, `DROP COLUMN` and `ALTER TABLE ... DROP COLUMN` on added lines.
- **Files outside `allowed-paths`**: list the paths a change is supposed to touch and anything else is flagged.

It reads the PR diff through the GitHub API, so it needs no checkout step and no API key, and it sends nothing to any third party.

## Quick start

Add `.github/workflows/scope-guard-lite.yml`:

```yaml
name: Scope Guard Lite
on: pull_request
permissions: { contents: read, pull-requests: write }
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: gillardlogan/scope-guard-lite@v1
```

The step is the last two lines. To flag edits outside certain folders, add:

```yaml
        with:
          allowed-paths: |
            src/billing/**
            tests/billing/**
```

## Inputs

| Input | Default | Meaning |
| --- | --- | --- |
| `allowed-paths` | none | Glob patterns (one per line or comma-separated). Files outside them are flagged. Leave empty to skip this check. |
| `task` | PR title and body | Task description. Shown in the comment. Lite does not compare it with the diff (the full version does). |
| `comment` | `true` | Set to `false` to skip the PR comment. Findings still go to the job summary. |
| `github-token` | `github.token` | Needs `pull-requests: write` to comment. |

Fork PRs get a read-only token from GitHub, so the comment cannot be posted there. Lite writes the findings to the job summary instead.

## Sample comment

SAMPLE_COMMENT

## Free vs paid

Scope Guard Lite is the free subset of [Scope Guard](https://gillardlogan.gumroad.com/l/scope-guard), a paid merge gate for AI-agent changes.

| | Lite (free) | Scope Guard (paid) |
| --- | --- | --- |
| Committed secrets | Known key formats and database URLs | Also high-entropy secret assignments |
| Destructive SQL | `DROP TABLE`, `DROP COLUMN` | Also Rails, Django and Prisma drops, and any changed migration |
| Files outside an allowed list | Yes (`allowed-paths`) | Yes, plus `blocked_patterns` with your own severity and reason |
| Blocks the merge | No, warns only | Yes: fails the job at the severity threshold you set, so it can be a required check |
| Other rules | None | 20 rules in total: major dependency bumps, added or removed dependencies, deleted files and jobs, auth, payment, secrets and config paths, CI workflow edits, lockfile changes, paths the task never mentions |
| Task vs diff | Task is shown only | Checks which changed paths the task never mentions; optional model pass with your own API key |
| Config | Action inputs | `scope.yml`: threshold, per-rule severity, allowlist entries with reasons, allowed and blocked paths |
| Where it runs | GitHub Action | GitHub Action, command line, pre-commit hook, plus skill files for Cursor and Claude Code |
| Output | PR comment | Text, JSON and Markdown reports and a PR comment |
| Price | Free, MIT | $49 personal, $149 for one team or organization (up to 10 people) |

The paid version is a separate product with its own source and licence. This repository only contains the free checks above.

- Try the checks in your browser, with no install: https://scope-guard-demo.netlify.app/
- Get the full version: https://gillardlogan.gumroad.com/l/scope-guard (code `LAUNCH20` takes 20% off until 26 Nov 2026)

## Limits

- It scans added lines in the PR diff. A secret that was already in the repository is not found.
- Very large diffs (over about 20,000 lines) are not returned by the GitHub API. Lite skips the check with a warning.
- Pattern matching finds common formats. It does not find every secret, and it is not a replacement for a secret scanner or a code review.
- Ignored paths: `node_modules/`, `vendor/`, `third_party/`, `dist/`, `build/`, `.next/`, `coverage/`, minified JavaScript and source maps.

## License

MIT. See [LICENSE](LICENSE).
