# Contributing

Use Node.js20+. Run `node --test test/unit.test.js`, `for file in scripts/*.sh examples/*.sh; do bash -n "$file" || exit; done` and `npm pack --dry-run` before requesting review. Runtime uses Node built-ins; tests need no Host or real credentials. Preserve the peer versions unless a separate Host compatibility review approves a change.

Keep tool schemas, docs/tools.md and docs/tool-schemas.json synchronized. Preserve fail-closed config, loopback binding, Bearer auth, cwd allowlists, read-path confinement and bounded resource behavior. Add negative tests for security changes. For longer changes, provide a baseline/commit SHA and evidence without implying that green CI replaces acceptance review.

Never commit real tokens, secret files, personal contact details, machine addresses, workspace/session IDs, Host source, environment dumps or production config. Use synthetic fixtures and documentation addresses. Check npm pack contents; do not add install/postinstall network hooks. Do not run included operational scripts against a live Host without separate approval.

Propose focused PRs with goal, changed files, tests, risks and compatibility notes. Do not merge/deploy on behalf of others without authorization. Vulnerabilities follow SECURITY.md, not a public exploit Issue. Contributions are under MIT; contributors must have the right to share their code.
