import type {
  User,
  Organization,
  OrgMember,
  OrgMemberRole,
  Team,
  TeamMember,
  Board,
  Column,
  Sprint,
  SprintStatus,
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
  OrgMemberRole,
  Team,
  TeamMember,
  Board,
  Column,
  Sprint,
  SprintStatus,
  Card,
  Label,
  CardLabel,
  Comment,
  ApiKey,
  AgentActivity,
  Webhook,
}

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
