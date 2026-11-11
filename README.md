# Work progress

A Claude Code side panel that shows what Claude is doing while it works, so you can follow along at a glance without reading the whole transcript.

## What it shows

- **Status** — working or idle, how long the task has run, and the step running now ("Editing src/app.php", "Running tests").
- **Needs you** — the status turns red when Claude waits on a permission prompt or a question, so you notice from the corner of your eye.
- **Progress** — Claude's to-do list with a done count, when it keeps one.
- **Files changed** — every file Claude added (A), edited (M) or removed (D) this session, with lines added and removed.
- **Recent steps** — the last steps of the current task, marked done, running or failed, with how long each took.
- **Estimate** — when you send a task, the smallest model (Haiku) sizes it in the background (tiny, small, medium or large) and suggests the cheapest model that fits. The panel shows a cost per model (`haiku ~$0.03 · sonnet ~$0.53 · opus ~$1.06 · fable ~$1.82`), a **Switch to …** button (runs `/model`), and the actual cost when the task ends. Estimates start rough and learn from your real tasks. Costs use API prices; on a subscription plan they show usage weight, not a bill.
- **Decisions** — Claude doesn't stop to ask. It calls a `decide` tool this mod adds:
  - *small* choices (naming, wording, styling): Claude picks its recommendation and keeps going;
  - *costly* choices (architecture, data format, push, delete): Claude parks that part, does everything else, and waits.
  Each decision shows in the panel with buttons and an "Other…" box. Change one and Claude is told at its next step, or in a new turn if it already finished; a small change gets revised, a parked one gets done.
- **Summary toast** — when a task ends: "Done in 2m 10s · 4 files +52 -7 · 1 failed step" (only for tasks that changed files or ran 30 seconds or more).

```
● Working · 1m 20s
Now: Editing resources/style/cards.scss

Files changed (3) +42 -7
A src/new-file.php   +30 -0
M cards.scss         +12 -7
D old-helper.js
```

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install work-progress --marketplace makdia/claude-code-work-progress
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every project).

From a shell:

```
claude plugin install work-progress --marketplace makdia/claude-code-work-progress
```

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `makdia/claude-code-work-progress`, then **Add plugin**.

Or clone the repository to `~/.claude/mods/work-progress` and load the folder in every session by adding this to `~/.claude/settings.json`:

```json
"env": { "CLAUDE_CODE_PLUGIN_DIRS": "~/.claude/mods/work-progress" }
```

Start a new session. The panel opens by itself in a wide terminal; run `/progress` to open it any time.

## Limits

- Only changes made through Claude's tools are tracked; your own edits and files changed by builds are not.
- Removals are read from `rm`, `git rm` and `unlink` commands; wildcards and variables are skipped.
- A sub-agent's file changes are counted; its steps are not listed.
- After you approve a permission prompt, "Needs you" stays until that step finishes; Claude Code has no event for the moment you answer.

Estimate notes: switching models restarts the prompt cache, so a switch mid-task can cost more than it saves. Only main-loop turns are counted; sub-agents are not.

## Development

Run the tests with `claude plugin test .` and check the plugin with `claude plugin validate . --strict`.

## License

MIT
