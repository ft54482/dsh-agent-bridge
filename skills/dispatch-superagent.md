---
name: dispatch-superagent
description: Plan a long-running DSH SuperAgent development task using the official GitHub Issue workflow, not Web Session MCP tools.
---

# Dispatch SuperAgent honestly

The bridge exposes 12 Web Session tools and **no SuperAgent issue/job tool**. Do not invent one, use private orchestrator HTTP APIs, or imply a Web Session is a SuperAgent job.

Before external writes, require explicit applicable authorization to create the specific Issue in the specified repository. Otherwise prepare an Issue draft for the supervising agent; create nothing. Verify target repository read/write access, official dsh-superagent polling configuration, agent-login, isolated work directory and no duplicate task. A 404 or scope mismatch is a blocker, not permission to bypass.

Issue body template:

```text
@<agent-login> <request>
Baseline branch/SHA: <baseline>
Existing patches and missing tests: <references>
Allowed scope: <paths and edits>
Acceptance criteria: <unchanged original criteria plus required evidence>
Forbidden: unapproved merges, deployments, business restarts, credential reads, permission expansion
Deliverables: PR/commit SHA, changed files, test commands and full outcomes, unresolved risks
```

The official plugin polls GitHub. Track via the Issue/PR and official UI, not an internal HTTP endpoint. CI green alone is not acceptance. Report whether dispatch actually happened, its authorized repository/Issue reference, evidence bound to SHA, remaining blockers, and any explicitly authorized temporary configuration that must be restored. Do not switch repository or restart a service without separate authorization.

For a short investigation or verification use ../skills/deepseek-harness-mcp.md instead. Details: ../docs/superagent.md.
