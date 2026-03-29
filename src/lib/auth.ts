import * as bcrypt from 'bcryptjs'
import { getIronSession } from 'iron-session'
import { cookies } from 'next/headers'
import { sessionOptions, SessionData } from './session'
import { prisma } from './db'

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12)
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash)
}

export async function getSessionUser() {
  const session = await getIronSession<SessionData>(cookies(), sessionOptions)

  if (!session.userId) {
    return null
  }

  return prisma.user.findUnique({
    where: { id: session.userId },
    include: {
      orgMembers: {
        include: { org: true },
      },
    },
  })
}
