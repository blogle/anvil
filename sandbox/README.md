# Sandbox entrypoint

`entrypoint.sh` clones `REPOSITORY_URL` once, creates or switches to the
session branch, and then replaces itself with OpenCode. Set `WORKSPACE_DIR`,
`SESSION_ID`, `BRANCH`, `BASE_REF`, and `OPENCODE_BIN` to customize it.
