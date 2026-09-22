---
name: wrapup
description: Close a work session by writing what actually happened into `.harness/` and `memory/` — update STATE.md, append reusable lessons to MISTAKES.md, record choices in DECISIONS.md, refresh changed memory files, and discharge open carryover obligations. Use when the user says "/wrapup", "wrap up", "close out this session", "update the memory before I stop", "end of session", or when substantial work has landed and the harness has not been updated since.
---

# wrapup — session close

`/harness` builds the memory system. `/wrapup` closes the loop at the end of a
work session, so the next cold session reads facts rather than a stale snapshot.

The failure this prevents: `STATE.md` says `verified-at: 2026-08-29` while the
code moved three sessions ago. A cold session trusts it and works from a lie.
Stale memory is worse than no memory.

Runs against the current repo's `.harness/` and `memory/`. No harness present →
say so and offer `/harness`. Do not scaffold one here.

---

## The one rule

**Nothing enters `works:` this session that was not run this session.**

Carrying an existing `works:` line forward is fine — it was verified when it was
written. Leaving it untouched is fine; re-running its check and noting that you
did is better. *Adding* a line is not fine, unless a command ran and produced
output you read. Anything implemented but not executed, anything asserted but
unverified, goes to `next:`, marked unverified.

The tempting case is code you just wrote and are sure about. Sureness is not
execution. If a new claim cannot be traced to a command and its output, it is
not state. This is the whole point of the skill; everything below is mechanics.

---

## Steps

Each step is skippable when nothing changed. Skipping is normal — a session that
fixed one typo should touch nothing. Say what you skipped.

### 1. Establish what actually happened

Before writing anything, gather from this session:

- commands that ran and their exit status
- files created, modified, deleted
- tests run and their result
- what was decided
- what broke, and whether it was fixed or merely diagnosed

Read the current `.harness/STATE.md` before rewriting it. Compare against the
above. Do not write from recollection of intent — write from evidence.

### 2. `.harness/STATE.md`

Rewrite in place, preserving the existing `works:` / `broken:` / `next:` /
`verified-at:` / `notes:` shape.

- `works:` — two kinds of entry, and nothing else. Something **run and verified
  this session**. Or an **existing** line carried forward — untouched, or with
  a note that you re-ran its check. A line that was neither run this
  session nor already in `works:` does not go here, however confident you are
  that it works — write it in `next:` instead, saying it is unverified.
  Delete entries the code no longer supports; never leave a correct line beside
  a stale one.
- `broken:` — known-broken with enough detail to resume. `none known` if clean.
- `next:` — the actual next action, specific enough to start cold.
- `verified-at:` — today, **only** if something was verified today. Otherwise
  leave the old date; bumping it without verification is the lie this file exists
  to prevent.

Past ~150 lines, consolidate rather than append.

### 3. `.harness/MISTAKES.md`

Append only mistakes with a **reusable trigger** — a future session in a
different context would benefit. A one-off typo does not qualify. A wrong
assumption that cost a re-run does.

Use the schema `/carryover` validates mechanically (invalid records are silently
never injected):

```markdown
## short imperative title

TRIGGER: before <the situation, never task wording>
RULE: <the imperative>
CONSEQUENCE: <what actually breaks>
SCOPE: global-rule | project-incident
EVIDENCE: <what happened, the causal chain, with a concrete referent>
MATCH: <optional regex over a tool call>
```

`SCOPE: global-rule` is injected into every future session and costs context
forever — be sparing. Default to `project-incident` unless the lesson genuinely
generalises beyond this repo.

Append-only. Retire with `STATUS: retired` and a reason; never delete.

### 4. `.harness/DECISIONS.md`

Append choices made this session that a future session could otherwise
unknowingly reverse. Each entry: the choice, `REASON:`, `REVERSED BY:` (what
evidence would justify changing it, or `nothing foreseeable`).

Not every choice — only ones where the reasoning is not recoverable from the
code. Mark superseded entries as superseded; never delete them.

### 5. `memory/<component>.md`

Touch only files whose subsystem changed **architecture, interfaces, or
behavior**. A bug fix inside an unchanged interface usually changes nothing here.

Correct stale statements in place. Update `memory/README.md` if a file was added,
renamed, merged, or removed.

`DECISIONS.md` explains *why*; `memory/` explains *what exists now*;
`MISTAKES.md` is the reusable lesson from getting it wrong. Do not log the same
fact in two of them.

### 6. Discharge open carryover obligations

The Stop hook raises an obligation whenever it detects a correction, abandonment,
decision, or failure with no memory written. Anything still open at session end
blocks the next turn.

```text
python "C:\Users\sriva\.claude\hooks\carryover_hook.py" --discharge <id> <how> <reason>
```

`<how>`: `record` (a MISTAKES.md entry was written) or `no-capture` (nothing
reusable — give a one-line reason). Run from the repo root; the ledger is keyed
to the current directory.

Never hand-edit `.harness/ledger.json`.

### 7. Report the diff, do not narrate the session

Print what changed in memory, and nothing else:

```text
STATE.md    works: +2 -1 | next: rewritten | verified-at: 2026-08-29 -> 2026-09-05
MISTAKES.md +1  "detector scanned its own explanation" (project-incident)
DECISIONS.md    unchanged
memory/     gpt-bridge.md updated (CDP reconnect path)
ledger      discharged correction:abf50ffa275a (record)
```

Then stop. The user reviews and vetoes. Do not summarise what was built — they
were there.

---

## Rules

1. **Evidence over intent.** Written memory reflects what ran, not what was meant.
2. **Correct in place.** Never append a fact beside a contradictory one.
3. **Skipping is the common case.** Do not manufacture entries to look thorough.
4. **Nothing leaves the repo.** No Obsidian, no external notes, no commits.
5. **Never mention harness internals externally** — not in commits, PRs, code
   comments, or anything client-facing. State the underlying project fact instead.
6. **Do not fix code during wrapup.** Found a bug? It goes in `broken:` or
   `next:`. Fixing it starts a new work session, which then needs its own wrapup.

The test for every line written: *would a cold session make a better decision
after reading this?* If not, do not write it.
