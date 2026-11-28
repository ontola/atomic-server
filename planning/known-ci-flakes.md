# Resolve known CI/browser flakes

Task: Merger, user request 2026-11-27.
Owned worktree: /Users/michieldejong/.codex/worktrees/ci-canvas-setup-followup/atomic-server.
Branch: codex/tablepage-2673-integration. Base candidate732156c47c7beb05bf8d215475adf98305f8a0cc includes currentdevelop3ef8de35a7e439261851f7965075812da749b336.

- [x] Review raw failures, openissues and applicable instructions.
- [x] Reproduce and fix website preview slow-read window; preserve automatic recovery assertion.
- [x] Add explicit connection/outbox readiness and a controlled delayed-acknowledgement regression for #2667 with proven save/acknowledgement boundary.
- [x] Resolve GettingStarted hover registration race (#2679) with red/green mounted regression.
- [x] Diagnose shared HTTP408 startup/request failures (#2680, website-inline-rte); isolated Actix regression and patch preserved outside this PR.
- [ ] Optional upstream/fork publication and dependency integration await an explicit user choice.
- [x] Reproduce and fix #2668 missing hydrated Loro base; 1858 library tests passed, one existing skip.
- [x] Map historical #1095 cases to presentcoverage; do not claim obsolete/unreproduced cases fixed.
- [x] Repeated focused native browser runs: 7/7 then 35/35, zero retries/skips/global errors; optimized matching frontend/server.
- [ ] Document evidence and limitations, reviewdiff, publish updatedPR2674.

Acceptance: known active cases remain enabled, strict browser diagnostics retained, no blanket sleeps/timeout increases/retry allowances used to hide failures. Product fixes need controlled regression reproduction. Fresh warm DO campaign authorized: three 64-vCPU workers, one hour and $7.50 maximum, independent cloud controller and automatic cleanup. Shared GitHub CI is not dispatched.

Ownership: parent coordinates and owns tests/test-utils.ts plus HTTP/server investigation and docs; websiteagent owns website-errors/versions specs and related websiteproduct files only after coordination; hoveragent owns GettingStarted/Uihint files and get-started spec. Planningagent read-only architecture review. Single build/extraction writer parent. Agents do not commit/push or startVite/builds without coordination.

## HTTP408 investigation

Exact actix-http3.12.1 realTCP diagnostic reproduces false408 after a paused worker even though the complete head is confirmed in the kernel buffer beforedeadline. Five normal controls200, ten idle/partial controls408, five timely complete requests incorrectly408. This proves a framework mechanism, not the original Atomic Server blocking path. Isolated dispatcherpatch is being reviewed outside the repository before any dependency decision. No timeout relaxation.

## Validation

Library 1865 passed/1 existing skip; hint+GettingStarted 9 passed; E2E helper 10 passed; Rust populate 5 passed. Focused native browser checks: 7 passed in 38.4 seconds, followed by 35 passed in 108.3 seconds (five repetitions, four workers, zero retries/skips). Positive hover screenshot reviewed. Four CI controller regression suites: 211 passed. Independent review found no actionable resource-cursor/fixture changes. Website specs retain their existing plainPlaywright fixture, so strictdiagnostic coverage is not claimed for those two files.
