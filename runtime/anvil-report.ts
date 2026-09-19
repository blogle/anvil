import { tool } from "@opencode-ai/plugin"

const schema = tool.schema

function config() {
  const base = process.env.ANVIL_CREDENTIAL_URL
  const session = process.env.ANVIL_SESSION_ID
  const credential = process.env.ANVIL_SESSION_CREDENTIAL
  if (!base || !session || !credential) {
    throw new Error("Anvil reporting is unavailable in this OpenCode process")
  }
  return { base: base.replace(/\/$/, ""), session, credential }
}

async function request(path: string, init: RequestInit = {}) {
  const { base, credential } = config()
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${credential}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  })
  const body = await response.text()
  let value: any = null
  try {
    value = body ? JSON.parse(body) : null
  } catch {
    throw new Error(`Anvil returned invalid JSON (${response.status})`)
  }
  if (!response.ok) {
    throw new Error(value?.error?.message || `Anvil rejected the report (${response.status})`)
  }
  return value
}

export const AnvilReportPlugin = async () => ({
  "experimental.chat.system.transform": async (_input: unknown, output: { system: string[] }) => {
    output.system.push(
      "At the end of each work turn, call anvil_report: use ready_for_review after completing and validating the requested work; use awaiting_input only when you cannot continue without external input.",
    )
  },
  tool: {
    anvil_report: tool({
      description:
        "Report the semantic outcome of this work turn. Use ready_for_review only after completing and validating the requested work. Use awaiting_input only when external input is required to continue. This does not complete the session.",
      args: {
        disposition: schema.enum(["ready_for_review", "awaiting_input"]),
        summary: schema.string().optional(),
      },
      async execute(args, _context) {
        const { session } = config()
        const current = await request(`/v1/sessions/${encodeURIComponent(session)}/report-context`)
        const runId = current.run_id
        const summary = args.summary?.trim().slice(0, 500)
        return await request(`/v1/sessions/${encodeURIComponent(session)}/report`, {
          method: "POST",
          body: JSON.stringify({
            run_id: runId,
            disposition: args.disposition,
            summary: summary || undefined,
          }),
        })
      },
    }),
  },
})

export default AnvilReportPlugin
