# GUIDE — which skill, when

Routing table for this repo. If the work matches a row, load that skill **before** starting, not
after getting stuck.

---

## Start of any session

Read `CLAUDE.md`, then `.harness/STATE.md`. Then the `memory/*.md` for whatever you are about to
touch — `memory/README.md` is the index. **Then look at the code**, because memory can be stale
and code cannot.

## By what you are doing

| Situation | Use | Why |
|---|---|---|
| Changed a pure lib, a worker, or engine logic | `verify-lib` | No test runner here; this is what verification means |
| Changed a React panel, canvas, import, or window | `ui-drive` | Only a browser can check it, and the dev server finds bugs `dist` does not |
| About to change a gain, settle, dwell, FLUSH/ACCUM, buffer size, sweep mode or FPGA image | `rf-bench` | Two regressions shipped because a change was validated with a metric that could not see the failure |
| Asked "did that change help?" on the radio | `rf-bench` | The bench will score the experiment for you unless you interleave |
| Pi code changed, or something that worked yesterday does not | `pi-deploy` | Four services, no supervision, and the FPGA silently reverts on a power cycle |
| Symptom with no known cause | `debug` | Root cause before fix; the repo's history is full of confident wrong fixes |
| Non-obvious design decision, more than one reasonable approach | `think` | Answering directly is indistinguishable from doing the work, so this gets skipped silently |
| Work landed and the session is ending | `wrapup` | Memory that is not updated the same session does not get updated |
| Memory is wrong, missing, or contradicts the code | `harness` | Refresh and audit, not a rescaffold |

## By symptom

| Symptom | Read first |
|---|---|
| Sweep rate is ~18 Hz, or `dsp` mode fails every sweep | `memory/fpga-images.md` — the rate is the diagnosis |
| Standoff reads `—` | `memory/lidar.md` — the IMU Hz tile tells the two cases apart |
| Corrupted or garbled sweeps | `memory/sfcw-engine.md` — check `SFCW_DIAG` before touching `settle_count` |
| Sweep-to-sweep noise, or a target that will not appear | `memory/bladerf-rf.md` — check ADC headroom on **both** channels |
| Background subtraction makes things worse | `memory/bg-subtraction.md` — first check whether the query is outside the model's span |
| Red crosses or holes in a C-scan | `memory/cscan.md`, then `memory/lidar.md` |
| Detection finds nothing, or finds too much | `memory/detection.md` — and check whether an empty reference is loaded |
| Rover drops off the network and will not come back | `memory/rover-firmware.md` — the recovery ladder |
| Throughput collapsed, or a client went dark | `memory/websockets.md` — three rules, all violated once |
| Something works in `dist` and not in `npm run dev` | `memory/projector.md` — StrictMode |
| A number on screen disagrees with the hardware | `.harness/MISTAKES.md` — an instrument fed a copy reports on the copy |

## What can be run here, and what needs the bench

**No hardware needed:**

```bash
bash rover/test/build_check.sh              # 166 checks + .ino type check (needs g++)
cd groundstation/frontend && npm run build  # the gate
cd groundstation/frontend && npm run bench  # detection corpus — NEEDS the scan files, see below
python -m py_compile pi/**/*.py
python pi/rover/rover_sim.py                # exercises rover_server end to end, no rig
```

**Needs the Pi and the radio:** `pi/radar/test_dsp_path.py`, `test_bandwidth_char.py`,
`probe_wobble.py`, `measure_settle.py`, `check_bit6.py`, and anything in `rf-bench`.

**`npm run bench` needs scan files that are not in the repo** (~9 MB each). `bench/corpus.json`
names the directories; pass `--dir` to point elsewhere. Without them the repo has no data-driven
regression test at all, so a detection change cannot be scored on the machine that makes it.
Getting those files onto a shared location is the single biggest gap in testability here.

## Rules that outrank a skill

- **Code is the source of truth.** Correct memory in place; never bend code to match it.
- **Confirm before** committing, pushing, opening or merging a PR, deleting anything, touching
  a dependency manifest, or **flashing FPGA or rover firmware**.
- **Never mention `.harness/`, `memory/`, `MISTAKES.md`, `DECISIONS.md` or `STATE.md`** in
  commits, PRs, code comments, or anything read outside the repo. State the project fact instead.
- **`vite build` must pass** before a frontend change lands.
- Only what actually ran this session goes in `works:`. Implemented-but-unexecuted goes in
  `next:`. Never bump `verified-at:` without verifying something.
