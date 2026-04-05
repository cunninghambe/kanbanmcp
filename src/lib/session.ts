import { IronSessionOptions } from 'iron-session'

if (!process.env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET env var is required')
}

export const sessionOptions: IronSessionOptions = {
  cookieName: 'kanban-session',
  password: process.env.SESSION_SECRET,
  cookieOptions: {
    secure: process.env.COOKIE_SECURE === "true",
    httpOnly: true,
    sameSite: 'strict' as const,
  },
}

export interface SessionData {
  userId: string
  orgId: string
  /** Set to true when the request was authenticated via an API key (Bearer token). */
  isApiKeyAuth?: boolean
  /** The agent name from the API key record, when isApiKeyAuth is true. */
  agentName?: string
}

declare module 'iron-session' {
  interface IronSessionData extends SessionData {}
}
