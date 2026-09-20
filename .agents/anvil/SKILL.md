# Anvil MCP Skill

Use the Anvil MCP server to delegate repository work to persistent, isolated
OpenCode development sessions running on Kubernetes Agent Sandbox.

## Availability Guard

Use this skill only when the Anvil MCP server exposes the required `anvil_*`
tools. If those tools are unavailable, do not use direct Kubernetes APIs,
`kubectl`, or Anvil's internal HTTP API to manage sessions.

## When To Use Anvil

Use Anvil when work should happen in a separate repository checkout, needs to
continue across messages, or benefits from an isolated development environment.
Each Anvil session has its own workspace, working tree, OpenCode conversation,
logs, and session state. Provider configuration and credentials are managed by
Anvil's shared profile; do not request or handle provider credentials.

## Session Workflow

1. Call `anvil_create_session` with:
   - `project`: a stable, human-readable project name.
   - `repository`: a public Git repository URL.
   - `ref`: the branch, tag, or revision to check out.
   - `prompt`: a complete task for the sandboxed OpenCode agent, including
     acceptance criteria and requested verification.
   - `model`: optional model override; omit it unless a specific model is
     required. When supplied, Anvil uses that exact model for every generation.
2. Save the returned `session_id`; it identifies the persistent session for all
   later calls.
3. Poll `anvil_get_status` until the task is no longer running. Use
   `anvil_get_messages` to understand progress, questions, failures, and the
   final result.
4. If follow-up work is needed, call `anvil_send_message` with the same
   `session_id`. Give precise instructions that refer to the existing checkout
   and prior work.
5. Call `anvil_get_diff` to inspect uncommitted changes before reporting the
   result or requesting further changes.

Anvil verifies the stored OpenCode conversation ID after startup, resume, and
before session operations. If the native conversation still exists, the same
ID is retained. If it is genuinely absent, Anvil automatically creates a
replacement, preserves the old and new IDs in operator activity, and records
that exact conversation continuity was lost. Do not expose or invent a routine
rebind workflow for users.

## Monitoring And Control

- Use `anvil_list_sessions` to discover available sessions.
- Use `anvil_get_session` for session metadata and lifecycle details.
- Use `anvil_get_status` for the current execution state; do not assume a task
  is complete merely because it has been started.
- Use `anvil_get_messages` for the OpenCode conversation transcript.
- Use `anvil_abort` only to stop the active task. The session and workspace are
  retained, so it can receive a revised prompt afterward.
- Use `anvil_suspend` to pause a session while preserving its workspace and
  conversation. Call `anvil_resume` before sending work that requires it to run.
- Use `anvil_delete_session` only when the work is finished or explicitly
  discarded. Deletion permanently removes the workspace and conversation.
- Do not call `anvil_rebind_session` during routine recovery. It is an
  exceptional operator escape hatch and intentionally loses continuity.

## Previews

When the sandbox agent starts a web service, call `anvil_get_preview` with the
session ID and listening port. Treat the returned URL as the browser-accessible
preview endpoint. Ask the sandbox agent to state its port if it is not clear
from the conversation.

## Prompting Guidance

Give the sandbox agent enough context to work independently:

- State the requested change, expected behavior, and any relevant constraints.
- Ask it to inspect existing conventions before editing.
- Specify the commands or checks it should run, when known.
- Ask it to summarize changes, tests, and unresolved risks when complete.
- For follow-ups, identify the exact issue to correct rather than restarting a
  new session unnecessarily.

Before relying on a session's output, inspect the status, recent messages, and
diff. Report only completed work; distinguish failed or unverified work clearly.
