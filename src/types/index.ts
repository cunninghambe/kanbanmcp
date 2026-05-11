import type {
  User,
  Organization,
  OrgMember,
  Team,
  TeamMember,
  Board,
  Column,
  Sprint,
  Card,
  Label,
  CardLabel,
  Comment,
  ApiKey,
  AgentActivity,
  Webhook,
} from '@prisma/client'

// Re-export Prisma model types
export type {
  User,
  Organization,
  OrgMember,
  Team,
  TeamMember,
  Board,
  Column,
  Sprint,
  Card,
  Label,
  CardLabel,
  Comment,
  ApiKey,
  AgentActivity,
  Webhook,
}

// String literal unions replacing removed Prisma enums (schema uses String fields)
export type OrgMemberRole = 'OWNER' | 'ADMIN' | 'MEMBER'
export type SprintStatus = 'PLANNING' | 'ACTIVE' | 'COMPLETED'

// Composite types
export type BoardWithColumns = Board & {
  columns: ColumnWithCards[]
}

export type ColumnWithCards = Column & {
  cards: Card[]
}

export type CardWithDetails = Card & {
  labels: Label[]
  comments: Comment[]
  assignee: User | null
}

export type OrgMemberWithUser = OrgMember & {
  user: User
}

export interface AgentContext {
  orgId: string
  agentName: string
  keyId: string
  permissions: string[]
}
