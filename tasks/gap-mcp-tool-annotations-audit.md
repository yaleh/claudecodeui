---
id: gap-mcp-tool-annotations-audit
title: "CloudCLI MCP tools/list: audit
  readOnlyHint/destructiveHint/openWorldHint annotations for accuracy"
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: proposal
---
## Proposal

ChatGPT's custom-MCP / developer-mode "app" permission framework is a DIFFERENT layer from CloudCLI's own OAuth and from Claude Code's `permissionMode` (tracked separately in `gap-mcp-session-create-permissionmode-race` — related context only, not a dependency; these two tasks are independent and can land in either order). Observed host-side behavior (informational background, not a CloudCLI bug): ChatGPT currently shows CloudCLI's app-specific permission as "Use my default", with the global default set to "Allow low-risk actions" / `review_important_actions`; attempting to set the CloudCLI dev-mode app to `full_access` via ChatGPT's own `update_app_permissions` action returns `404 Action not found`, and CloudCLI's own "Manage app" page has no Permissions UI — both of those are ChatGPT host-side capability/limitations, NOT something this task can or should fix in CloudCLI's API. Per OpenAI's custom MCP documentation: write actions default to requiring per-call user confirmation on the host side; any tool that lacks `readOnlyHint` is treated as a write by the host. MCP annotations (`readOnlyHint`, `destructiveHint`, `openWorldHint`, optionally `idempotentHint`) influence host confirmation UX but are declarative metadata ONLY — they are NOT an authorization mechanism, and must never be set inaccurately (e.g. marking a write tool as `readOnlyHint: true`) merely to suppress a host confirmation prompt. OpenAI's Responses/Realtime remote-MCP API separately exposes `require_approval: always|never`, which shows that per-call confirmation is host policy, not a hard MCP protocol constraint — reinforcing that CloudCLI's job here is correctness of its own declared annotations, not working around host policy.

Goal: audit every tool in CloudCLI's MCP `tools/list` response for annotation accuracy/completeness, so that continuous voice-driven control of CloudCLI via ChatGPT's custom-MCP host triggers fewer UNNECESSARY confirmations — strictly by fixing any WRONG or MISSING annotations, never by mislabeling a write operation as read-only or non-destructive to dodge confirmation.

Dedup note: searched task_list for "readOnlyHint", "destructiveHint", "openWorldHint", "idempotentHint", "tools/list annotation" across the full task store (which includes an exhaustive MCP-gateway AC series, GOAL-020/GOAL-022, covering transport/auth/scope/audit/self-target-guard/read-tools/write-tools/reconfigure/production-wiring in detail) — zero hits on any of those terms. No existing task owns tool-annotation accuracy. This is net-new.

EXPLICITLY OUT OF SCOPE: the session_create permissionMode race (tracked in `gap-mcp-session-create-permissionmode-race` — reference it by task key for context only, do not depend_on it, these are independent and can land in either order), and any resident/per-run Claude-Code-level permission-mode asymmetry (out of scope exactly as in that task, not to be investigated here either).

## AC

- [ ] AC1: Enumerate every tool currently registered in CloudCLI's MCP `tools/list` response (grep tool registrations under server/modules/mcp-gateway) and produce a table: tool name → current declared annotations (if any) → correct annotations per the tool's actual handler semantics.
- [ ] AC2: Pure read-only tools (e.g. projects_list, sessions_list, session_get, run_get, and any other read-only tool found during enumeration) declare `readOnlyHint: true`.
- [ ] AC3: Write-but-non-destructive tools (e.g. session_create, session_send, session_reconfigure, and any others found) do NOT declare `readOnlyHint: true`, and do not declare `destructiveHint: true` unless the operation is actually destructive/irreversible.
- [ ] AC4: Tools with genuinely destructive/irreversible semantics (e.g. session_interrupt, any delete-style session/host-control tool found during enumeration) declare `destructiveHint: true` accurately.
- [ ] AC5: `openWorldHint` (and `idempotentHint` where meaningful) reviewed per-tool against actual semantics (whether a call can affect state outside this server; whether repeating the call is idempotent).
- [ ] AC6: A review/diff confirms NO change in this task alters actual authorization/permission ENFORCEMENT for any tool — annotations are metadata-only; enforcement code paths must be provably untouched.
- [ ] AC7: A test or documented verification confirms the final `tools/list` annotation output matches the table from AC1.

## DoD

tools/list output's annotations are accurate and complete for every registered tool, with no write operation mislabeled as read-only/non-destructive to suppress host confirmations.

## Touches

- server/modules/mcp-gateway/ — exact annotation-declaring file(s) to be located during execution (likely wherever tool registration/schema objects for mcp-gateway.write-tools.ts and the read-tools equivalent live); do not guess-pin a path here if you can't confirm it exists, locate it as part of filing if feasible.
- tasks/gap-mcp-tool-annotations-audit.md
