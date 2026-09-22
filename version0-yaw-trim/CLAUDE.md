# CLAUDE.md — version0

SFCW radar for **within-wall** imaging: rebar, pipes, voids, studs. Not beyond the wall.

## Read this first

| Need | File |
|---|---|
| Which skill or document fits the task in front of you | `.harness/GUIDE.md` |
| Hardware, wiring, pinouts, ports | `CONTEXT.md` |
| Purpose, done-looks-like, non-goals | `.harness/GOAL.md` |
| What works / broken / next | `.harness/STATE.md` |
| Sharp edges that have already bitten | `.harness/MISTAKES.md` |
| Why a choice was made | `.harness/DECISIONS.md` |
| How a subsystem works **now** | `memory/README.md` → `memory/<component>.md` |
| Full investigation history, measurements, falsified hypotheses | `docs/engineering-log.md` (grep it; never load it whole) |

`docs/engineering-log.md` is an append-only lab record and contains **superseded claims**.
Always prefer `memory/` for current truth. Cite the log for measurements, not for behaviour.

## Two machines

- **Raspberry Pi** (`pi/`) — sensors, radar control, networking. Never takes direct user input.
- **PC or Pi** (`groundstation/`) — React UI, heavy compute (SAR, detection, ML). All control over LAN.
- The Pi can host the groundstation itself; Flask serves `frontend/dist` on port 5000.
- Clone on both, run the appropriate half on each.
- Every subsystem must have a corresponding debug panel on the groundstation.

## Commands

```bash
python3 pi/start.py                 # Pi: all four services (5000 / 9001 / 9002 / 9003)
cd groundstation/frontend && npm run dev     # UI dev server, HMR over LAN with --host
cd groundstation/frontend && npm run build   # the gate: must pass before any change lands
cd groundstation/frontend && npm run bench   # detection benchmark against the labelled corpus
bash rover/test/build_check.sh      # firmware: native core tests + .ino type check
```

## Code conventions

- Python 3.11+ on the Pi, no comments or docstrings unless asked, no dead code.
- Groundstation is **React + Vite** (settled, not TBD). Plain JS, no TypeScript.
- Transport is **WebSockets**, not ZeroMQ (settled). Shared definitions in `shared/protocols/`.
- Sensor interfaces stay minimal and async-friendly.
- Prefer flat code over abstraction. Edit existing files over creating new ones.

## Architectural rules that hold across the repo

1. **One implementation of a shared kernel.** CFAR, window functions, colormaps, the SAFT/DAS
   kernel and the TF-LC02 parser each exist once and are imported. Two copies drift, and both
   images stay plausible while disagreeing.
2. **The groundstation panel is the source of truth for radar parameters.** The Pi never reports
   them back; parameters are pushed. A new parameter that is not in `sendSfcwParams()` never
   reaches the Pi.
3. **Background subtraction happens on the groundstation only.** The wire stays raw `h_cal`, or
   captures, SAR and model training are silently contaminated.
4. **One sensor's failure must never gate another's.** Guard init *and* every per-iteration read.
5. **An instrument fed a throttled, decimated or re-timed copy of the data reports on the copy.**
   Measure timing from the producer's clock, not the consumer's.
6. **No test runner exists yet.** Non-trivial logic is verified by driving the *shipped* module
   head-first from node/python — never a retyped or copied version. See `.claude/skills/`.

## Maintaining this memory

**Before substantial work:** read `GOAL.md`, `STATE.md`, the relevant `memory/*.md`, and any
matching `MISTAKES.md` / `DECISIONS.md` entries. Then inspect the actual code — memory can be
stale, code cannot.

**After every major change window** — a feature, a significant bug fix, an architecture / API /
protocol / dependency change, a substantial refactor, or a completed debugging investigation
(not a trivial edit):

- update `STATE.md` if state changed, and only bump `verified-at` if something was actually verified;
- update the affected `memory/*.md`, or create one for a new substantial subsystem;
- update `memory/README.md` if files were added, merged or removed;
- add a `DECISIONS.md` entry for an important choice, with what would reverse it;
- add a `MISTAKES.md` record for a reusable lesson, following that file's schema;
- append measurements and investigation narrative to `docs/engineering-log.md`;
- **correct stale claims in place.** Memory that contradicts the code is worse than none,
  because it gets trusted.

`/wrapup` does this at the end of a session. Run it when work lands.

Only what actually ran this session goes in `works:`. Implemented-but-unexecuted goes in `next:`.

**Never mention `.harness/`, `memory/`, `MISTAKES.md`, `DECISIONS.md` or `STATE.md` in commits,
PRs, code comments, or anything written to be read outside the repo.** State the underlying
project fact instead.

## Workflow

- `/think` — for non-obvious design work, use it before committing to an approach
- `/debug` — debugging and investigation; root cause before fix
- `/wrapup` — end-of-session memory synchronization
- `.claude/skills/` holds the repo's own repeated procedures — read the relevant one before
  verifying code, driving the UI, benchmarking the radio, or deploying to the Pi.

## Confirm before acting

`git commit`, `git push`, opening or merging a PR, deleting files or branches, touching
`requirements.txt` / `pyproject.toml` / `package.json`, and **flashing FPGA or rover firmware**.
