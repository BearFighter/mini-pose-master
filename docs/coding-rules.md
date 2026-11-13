# Rules for coding agents (Sonnet / Haiku)

You are implementing **one work package** of Mini Pose Master from a brief in `docs/briefs/`.
The architect (Opus) owns every design decision.

1. **Follow `docs/contracts.md` and your brief exactly.** Do not change names, formats, formulas,
   folder layout or versions.
2. **Do not make design calls.** When something is ambiguous, missing, contradictory or seems wrong,
   stop, and list the question in your final report under `QUESTIONS`. Do not guess and do not
   silently work around it. A smaller, correct deliverable is better than a complete, guessed one.
3. **Stay in your lane.** Only create or edit the files your brief lists. If you think another file
   needs changing, say so under `QUESTIONS`.
4. **No new dependencies** beyond the pinned list in contracts §1 and your brief. No network downloads
   except `npm install` of pinned packages, when your brief says so.
5. **Engine code** runs inside Blender's Python 3.13 with numpy only (no scipy, no pip installs).
   Use `bpy`, `bmesh` and `mathutils`. Never call `bpy.ops` that need a UI context without a
   `temp_override`.
6. **No secrets, no telemetry, no hard-coded user paths.** Paths come from arguments or `app.getPath`
   equivalents.
7. **Tests are part of the deliverable.** Every acceptance check in your brief must exist as an
   automated test and pass. Run them and paste the summary in your report.
8. **License header**: every new source file starts with
   `SPDX-License-Identifier: GPL-3.0-or-later` (a `//` comment in TS/JS, `#` in Python).
9. **Do not commit, push, tag or publish.** The architect commits after review.
10. **Final report format** (your last message):
    ```
    DONE: <one line>
    FILES: <created/changed files>
    TESTS: <command + pass/fail summary>
    DEVIATIONS: <anything that differs from the brief, or "none">
    QUESTIONS: <open questions, or "none">
    ```
11. Never include third-party character assets, mocap data, or anything from outside this
    repository in the repo. Test data comes only from `fixtures/generate.py`.
