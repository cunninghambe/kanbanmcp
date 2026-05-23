export class GoogleAuthExpiredError extends Error {
  readonly code = 'GOOGLE_AUTH_EXPIRED' as const
  constructor(message = 'Google auth expired or not connected') {
    super(message)
    this.name = 'GoogleAuthExpiredError'
  }
}

export class TokenRevokedError extends Error {
  readonly code = 'TOKEN_REVOKED' as const
  constructor(message = 'Google refresh token has been revoked') {
    super(message)
    this.name = 'TokenRevokedError'
  }
}

export class InsufficientScopesError extends Error {
  readonly code = 'INSUFFICIENT_SCOPES' as const
  constructor(public readonly missing: string[]) {
    super(`Missing scopes: ${missing.join(', ')}`)
    this.name = 'InsufficientScopesError'
  }
}

export class StateMismatchError extends Error {
  readonly code = 'STATE_MISMATCH' as const
  constructor(message = 'OAuth state parameter mismatch') {
    super(message)
    this.name = 'StateMismatchError'
  }
}

export class GoogleHttpError extends Error {
  readonly code = 'GOOGLE_HTTP_ERROR' as const
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`Google HTTP ${status}`)
    this.name = 'GoogleHttpError'
  }
}
