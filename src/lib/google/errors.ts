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

export class DriveNotFoundError extends Error {
  readonly code = 'DRIVE_NOT_FOUND' as const
  constructor(message = 'Drive file not found') {
    super(message)
    this.name = 'DriveNotFoundError'
  }
}

export class DriveForbiddenError extends Error {
  readonly code = 'DRIVE_FORBIDDEN' as const
  constructor(message = 'Drive access forbidden') {
    super(message)
    this.name = 'DriveForbiddenError'
  }
}

export class DriveTrashedError extends Error {
  readonly code = 'DRIVE_TRASHED' as const
  constructor(message = 'Drive file is in trash') {
    super(message)
    this.name = 'DriveTrashedError'
  }
}

export class RateLimitExceededError extends Error {
  readonly code = 'RATE_LIMIT_EXCEEDED' as const
  constructor(message = 'Rate limit exceeded: request would exceed maxWaitMs') {
    super(message)
    this.name = 'RateLimitExceededError'
  }
}
