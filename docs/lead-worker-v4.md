# V4 multi-Lead durable supervisor

V4 is the default Lead workflow. It moves process supervision, feature ownership, scheduling, launch reconciliation, and event retention out of interactive Pi sessions into one detached local supervisor. Pi Lead sessions become thin, attachable clients.

A fresh ordinary `pi` process selects V4 before any V2 timer, event claim, launch, topology reconciliation, or retirement path initializes.

## Start and roll back

Start a Lead in a trusted Git checkout inside cmux:

```bash
pi
```

`PI_LEAD_V4=1 pi` remains accepted for compatibility. A Lead started by V4 and every V4 worker export `PI_LEAD_V4=1` automatically, so their workflow remains explicitly fenced.

V2 remains available as an explicit compatibility and rollback path:

```bash
PI_LEAD_V4=0 pi
```

Before rolling back, ask the V4 Lead to run the internal `lead_v4_rollback_check` tool. It refuses while a worker generation is launching, live, `unknown`, or quarantined. Only after it reports safe, close/detach **every** V4 Lead for the project and start a **fresh** process with `PI_LEAD_V4=0 pi`. Do not reuse or reload a V4 Lead as the rollback process. Never run V2 and V4 mutation paths concurrently for the same project. Rollback does not delete state, worktrees, sessions, or retained surfaces.

New V2 launch scripts export `PI_LEAD_V4=0`. For upgrade safety, a legacy or resumed V2 worker carrying both durable `PI_LEAD_TASK_ID` and `PI_LEAD_PROJECT_ID` stays on V2 even if its older launch script has no selector.

## Architecture

### Durable single instance

A lazy detached Node process serves all local V4 projects through a private AF_UNIX socket:

```text
/tmp/pi-lead-v4-<uid>/          mode 0700; deliberately short for AF_UNIX
  supervisor.sock              mode 0600
  transport.token              mode 0600

~/.pi/lead-orchestration/      mode 0700; separate durable state
  projects/<project-id>/v4/
    state.json                 mode 0600
```

The checked-in `extensions/lead-v4/runtime/supervisor.mjs` is the production runtime; it does not depend on `tsx` or development dependencies. `npm run build:v4-supervisor` regenerates it.

Bootstrap is connect-first. Only `ENOENT`/`ECONNREFUSED` enters an `O_EXCL` bootstrap election, followed by another handshake. A stale pathname is removed only by the elected bootstrapper after both probes fail. Kernel bind ownership is authoritative; V4 never unlinks/retries `EADDRINUSE` and never replaces a protocol/build mismatch. Every bounded JSON-RPC request carries protocol/build/schema identity, the private token, and the current supervisor fencing epoch.

The daemon is the only V4 state writer. A restart increments the project supervisor generation and turns incomplete launch sagas into `unknown`; it does not repeat them.

### Lead attachments and feature tracks

A Lead identity is:

- Pi session ID;
- client incarnation and session generation;
- process ID;
- random attachment ownership token;
- stable cmux window/workspace/pane/surface UUID tuple.

At least three Lead sessions can attach concurrently (subject to `maxConcurrentLeads`). Each feature track has a canonical identity, an ownership token, an owner attachment, and a fenced owner generation. Exact `(repository, issue key)` duplicates reuse the existing track. Natural-language goals cannot be safely deduplicated; possible matches are surfaced and the caller must choose the existing track or explicitly create a separate one.

Owner leases do not own workers. Lead death or detach leaves all workers untouched. Only after lease expiry can another attached Lead claim the feature using the expected owner generation. The replacement receives one bounded retained digest.

Use plain language. Internal model tools cover:

- creating/reusing a feature (`lead_v4_feature`);
- spawning a non-focused Lead (`lead_v4_spawn_lead`);
- creating implementation/research/review work (`lead_v4_worker`);
- claiming an unowned feature (`lead_v4_claim_feature`);
- native status and exact record inspection (`lead_v4_status`, `lead_v4_inspect`);
- exact worker stop (`lead_v4_stop`);
- rollback safety (`lead_v4_rollback_check`).

`/workers` remains only a compatibility diagnostic. It is not the routine control plane.

### Dedicated Agents workspace and scheduling

Workers live in one stable `Agents · <project>` cmux workspace, independent of every Lead workspace. Creation always uses `--focus false`. Feature Leads get their own non-focused workspaces.

Scheduling has separate bounds:

- `maxConcurrentLeads` counts attached and in-flight Lead processes;
- `maxConcurrentWorkerProcesses` counts `launching`, `running`, `unknown`, and quarantined worker generations.

Retained terminal tabs do not consume worker-process capacity. Queued workers are selected round-robin across feature tracks, then FIFO within a track. Implementation tasks get distinct IDs, branches, and worktrees. Research may use the repository root; reviews intentionally share the exact parent implementation worktree and remain separately identified.

A durable launch saga records generation/token/intent before cmux creation, records exact UUID results before sending launch text, and becomes live only after the worker hello. Fault uncertainty becomes `unknown`, which forbids duplicate launch, resume, reuse, close, or cleanup.

## Model and thinking resolution

V4 resolves model and thinking independently in this order:

1. explicit operator choice;
2. spawning Lead choice;
3. feature preset;
4. role/project policy;
5. inherited Lead choice.

The record stores the exact canonical `provider/model`, requested thinking (including `off`), and the source for each. A Lead registry snapshot validates exact IDs. A model suffix is accepted only when it has one unique provider match. Missing or ambiguous models fail visibly; V4 never silently falls back.

Worker hello persists the actual model and actual thinking separately. Pi may capability-clamp thinking, so requested `xhigh` and actual `high` can both be true and visible. An actual model mismatch quarantines the generation. A worker model/thinking change requires a durable handoff and a visible new generation. Authentication or remote-provider failure may still happen at launch and remains a visible failure.

Implementation, research, and review tasks may select different models. Reviewer provider/model diversity is supported only when explicitly selected or configured; V4 does not silently require it. Duplicate review calls reuse the exact prior task; after implementation evidence changes, request an explicit new review generation.

V4 never modifies global `models.json`.

## cmux and process safety

Only stable UUIDs are authoritative. Short refs are display-only and are never mutation targets.

`surface-health.in_window` is **not liveness**. A healthy background or non-selected workspace reports `in_window:false`. Exact UUID topology membership means the surface is present regardless of selection.

Worker liveness is a separate generation-scoped hello/heartbeat containing task ID, random token, Pi session ID, process incarnation, PID, and the observed cmux UUID tuple. Topology/process reconciliation uses cmux process attribution for that UUID. Malformed or partial topology, cmux outage/restart, UUID tuple mismatch, stale heartbeat, or absent process attestation is `unknown`, not absent.

Replacement requires all of:

1. proven old generation exit;
2. the old UUID tuple absent in two fresh complete snapshots;
3. a higher persisted generation.

Anything else remains quarantined.

There is no V4 cleanup path for Lead attachments. Automatic worker-surface retirement defaults off. Terminal worker reports may request shutdown of only their exact worker Pi process; the surface remains. Stop accepts task IDs, never Lead attachment IDs. V4 does not call `ctx.shutdown()` for a Lead.

## Digests and recovery

Events remain durable when no Lead is attached. Actionable events prefer the owning Lead. One claim atomically covers every currently pending owned event and produces one bounded digest. Delivery is idempotent at-least-once: a Lead killed between claim and acknowledgement may see the digest again after claim expiry. V4 does not claim impossible exactly-once delivery.

Routine completion/CI telemetry updates native status and stays in the retained digest; it does not force an LLM turn. The daemon polls pending PRs on a bounded cadence and only records changed observations. Green/merged classification requires a clean matching HEAD/diff plus check-bound independent approval; it never merges. Blockers, crashes, ownership loss, and requested changes can trigger one owning-Lead digest when idle.

All timer, socket, and callback work is extension-instance fenced. `/reload`, `/new`, `/resume`, and `/fork` tear down old callbacks. Workers cannot switch/fork/clone in place because their Pi session ID is generation-fenced.

V2 task files are imported once as a read-only SHA-256 descriptor snapshot. V4 never executes their stored launch scripts and never adopts/resumes a V2 worker without a fresh V4 generation/token/session/UUID/process attestation.

## Configuration

Private V4 project state can carry:

```json
{
  "config": {
    "maxConcurrentLeads": 3,
    "maxConcurrentWorkerProcesses": 4,
    "attachmentLeaseSeconds": 20,
    "processHeartbeatSeconds": 20,
    "digestLimit": 50,
    "automaticWorkerSurfaceRetirement": false,
    "project": { "model": "openai/gpt-5.6-sol", "thinking": "high" },
    "roles": {
      "implementation": { "model": "openai/gpt-5.6-sol", "thinking": "xhigh" },
      "research": { "model": "google/gemini-3-pro", "thinking": "medium" },
      "review": { "model": "anthropic/claude-opus-4-6", "thinking": "high" }
    }
  }
}
```

Use internal tools rather than hand-editing live state. The daemon normalizes bounds and remains the sole writer.

## Operational caveats

- Workers survive a Lead closure while the cmux app and dedicated Agents workspace remain alive.
- `unknown` consumes capacity conservatively and requires inspection rather than automatic duplication.
- Reviews share the parent worktree; research may use the repository root.
- Provider authentication cannot be guaranteed from a registry snapshot alone.
- Natural-language duplicate and ambiguous model aliases require a choice.
- V4 stops before merge/deployment and preserves V2 safety boundaries.

## Validation

```bash
npm run build:v4-supervisor
npm test
npm run typecheck
git diff --check
```

The deterministic suite covers concurrent daemon bootstrap/restart/stale sockets, three Leads, duplicate initiation, ownership failover, fair scheduling, digest claim/ack, background-workspace health, UUID ref reuse, malformed topology, conservative launch recovery, model resolution/mismatch, blocked-worker baseline behavior, and no Lead cleanup target.
