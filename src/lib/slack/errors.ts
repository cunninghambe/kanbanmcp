/**
 * Slack error classes (spec §4.7). Mirrors the shape of src/lib/google/errors.ts
 * so route handlers can map failures without inspecting messages.
 */

export class SlackAuthError extends Error {
  readonly code = 'SLACK_AUTH' as const
  constructor(message = 'Slack is not connected for this user') {
    super(message)
    this.name = 'SlackAuthError'
  }
}

export class SlackApiError extends Error {
  readonly code = 'SLACK_API' as const
  constructor(
    public readonly slackError: string,
    message?: string
  ) {
    super(message ?? `Slack API error: ${slackError}`)
    this.name = 'SlackApiError'
  }
}

export class SlackHttpError extends Error {
  readonly code = 'SLACK_HTTP' as const
  constructor(
    public readonly status: number,
    public readonly body: string
  ) {
    super(`Slack HTTP ${status}`)
    this.name = 'SlackHttpError'
  }
}

export class SlackInsufficientScopesError extends Error {
  readonly code = 'SLACK_INSUFFICIENT_SCOPES' as const
  constructor(public readonly missing: string[]) {
    super(`Missing Slack scopes: ${missing.join(', ')}`)
    this.name = 'SlackInsufficientScopesError'
  }
}
