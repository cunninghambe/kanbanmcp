/**
 * Tests for auth API routes: login, register, logout, me
 * Mocks prisma, iron-session, and next/headers
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// ─── Mock iron-session ────────────────────────────────────────────────────────
const mockSession = {
  userId: '',
  orgId: '',
  save: vi.fn().mockResolvedValue(undefined),
  destroy: vi.fn().mockResolvedValue(undefined),
}

vi.mock('iron-session', () => ({
  getIronSession: vi.fn().mockResolvedValue(mockSession),
}))

vi.mock('next/headers', () => ({
  cookies: vi.fn().mockReturnValue({}),
}))

// ─── Mock prisma ──────────────────────────────────────────────────────────────
const mockPrisma = {
  user: {
    findUnique: vi.fn(),
    create: vi.fn(),
  },
  organization: {
    create: vi.fn(),
  },
  orgMember: {
    create: vi.fn(),
  },
  $transaction: vi.fn(),
}

vi.mock('../src/lib/db', () => ({
  prisma: mockPrisma,
  default: mockPrisma,
}))

function makeRequest(url: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(url, {
    method,
    body: body ? JSON.stringify(body) : undefined,
    headers: { 'Content-Type': 'application/json' },
  })
}

// ─── Login route ──────────────────────────────────────────────────────────────
describe('POST /api/auth/login', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSession.userId = ''
    mockSession.orgId = ''
  })

  it('returns 400 for missing email', async () => {
    const { POST } = await import('../src/app/api/auth/login/route')
    const req = makeRequest('http://localhost/api/auth/login', 'POST', {
      password: 'password123',
    })
    const res = await POST(req)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('Validation failed')
  })

  it('returns 400 for invalid email format', async () => {
    const { POST } = await import('../src/app/api/auth/login/route')
    const req = makeRequest('http://localhost/api/auth/login', 'POST', {
      email: 'not-an-email',
      password: 'password123',
    })
    const res = await POST(req)
    expect(res.status).toBe(400)
  })

  it('returns 400 for missing password', async () => {
    const { POST } = await import('../src/app/api/auth/login/route')
    const req = makeRequest('http://localhost/api/auth/login', 'POST', {
      email: 'user@example.com',
    })
    const res = await POST(req)
    expect(res.status).toBe(400)
  })

  it('returns 401 for non-existent user', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null)
    const { POST } = await import('../src/app/api/auth/login/route')
    const req = makeRequest('http://localhost/api/auth/login', 'POST', {
      email: 'nobody@example.com',
      password: 'password123',
    })
    const res = await POST(req)
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toBe('Invalid email or password')
  })

  it('returns 401 for wrong password', async () => {
    // Return a real bcrypt hash that does NOT match 'wrongpass'
    const { hashPassword } = await import('../src/lib/auth')
    const passwordHash = await hashPassword('correctpass')
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      email: 'user@example.com',
      name: 'Test User',
      passwordHash,
      orgMembers: [{ orgId: 'org-1', org: { id: 'org-1', name: 'Test Org', slug: 'test-org' } }],
    })
    const { POST } = await import('../src/app/api/auth/login/route')
    const req = makeRequest('http://localhost/api/auth/login', 'POST', {
      email: 'user@example.com',
      password: 'wrongpass',
    })
    const res = await POST(req)
    expect(res.status).toBe(401)
  })

  it('returns 403 when user has no org membership', async () => {
    const { hashPassword } = await import('../src/lib/auth')
    const passwordHash = await hashPassword('password123')
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      email: 'user@example.com',
      name: 'Test User',
      passwordHash,
      orgMembers: [],
    })
    const { POST } = await import('../src/app/api/auth/login/route')
    const req = makeRequest('http://localhost/api/auth/login', 'POST', {
      email: 'user@example.com',
      password: 'password123',
    })
    const res = await POST(req)
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error).toBe('User has no organization membership')
  })

  it('returns 200 with user and org on successful login', async () => {
    const { hashPassword } = await import('../src/lib/auth')
    const passwordHash = await hashPassword('password123')
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      email: 'user@example.com',
      name: 'Test User',
      passwordHash,
      orgMembers: [{ orgId: 'org-1', org: { id: 'org-1', name: 'Test Org', slug: 'test-org' } }],
    })
    const { POST } = await import('../src/app/api/auth/login/route')
    const req = makeRequest('http://localhost/api/auth/login', 'POST', {
      email: 'user@example.com',
      password: 'password123',
    })
    const res = await POST(req)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.user.id).toBe('user-1')
    expect(body.user.email).toBe('user@example.com')
    expect(body.org.id).toBe('org-1')
  })
})

// ─── Register route ───────────────────────────────────────────────────────────
describe('POST /api/auth/register', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSession.userId = ''
    mockSession.orgId = ''
  })

  it('returns 400 for missing name', async () => {
    const { POST } = await import('../src/app/api/auth/register/route')
    const req = makeRequest('http://localhost/api/auth/register', 'POST', {
      email: 'user@example.com',
      password: 'password123',
      orgName: 'My Org',
    })
    const res = await POST(req)
    expect(res.status).toBe(400)
  })

  it('returns 400 for password too short', async () => {
    const { POST } = await import('../src/app/api/auth/register/route')
    const req = makeRequest('http://localhost/api/auth/register', 'POST', {
      name: 'Test User',
      email: 'user@example.com',
      password: 'short',
      orgName: 'My Org',
    })
    const res = await POST(req)
    expect(res.status).toBe(400)
  })

  it('returns 409 when email already exists', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'existing-user' })
    const { POST } = await import('../src/app/api/auth/register/route')
    const req = makeRequest('http://localhost/api/auth/register', 'POST', {
      name: 'Test User',
      email: 'existing@example.com',
      password: 'password123',
      orgName: 'My Org',
    })
    const res = await POST(req)
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toContain('already exists')
  })

  it('returns 201 on successful registration', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null)
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
      return fn({
        user: { create: vi.fn().mockResolvedValue({ id: 'new-user', email: 'new@example.com', name: 'New User' }) },
        organization: { create: vi.fn().mockResolvedValue({ id: 'new-org', name: 'New Org', slug: 'new-org-123' }) },
        orgMember: { create: vi.fn().mockResolvedValue({}) },
      } as unknown as typeof mockPrisma)
    })
    const { POST } = await import('../src/app/api/auth/register/route')
    const req = makeRequest('http://localhost/api/auth/register', 'POST', {
      name: 'New User',
      email: 'new@example.com',
      password: 'password123',
      orgName: 'New Org',
    })
    const res = await POST(req)
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.user.email).toBe('new@example.com')
  })

  it('returns 400 when orgName is empty', async () => {
    const { POST } = await import('../src/app/api/auth/register/route')
    const req = makeRequest('http://localhost/api/auth/register', 'POST', {
      name: 'Test User',
      email: 'user@example.com',
      password: 'password123',
      orgName: '',
    })
    const res = await POST(req)
    expect(res.status).toBe(400)
  })
})

// ─── Logout route ─────────────────────────────────────────────────────────────
describe('POST /api/auth/logout', () => {
  beforeEach(() => vi.clearAllMocks())

  it('destroys session and returns 200', async () => {
    const { POST } = await import('../src/app/api/auth/logout/route')
    const req = makeRequest('http://localhost/api/auth/logout', 'POST')
    const res = await POST(req)
    expect(res.status).toBe(200)
    expect(mockSession.destroy).toHaveBeenCalled()
  })
})

// ─── Me route ─────────────────────────────────────────────────────────────────
describe('GET /api/auth/me', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSession.userId = ''
    mockSession.orgId = ''
  })

  it('returns 401 when not authenticated', async () => {
    const { GET } = await import('../src/app/api/auth/me/route')
    const res = await GET()
    expect(res.status).toBe(401)
  })

  it('returns 401 when user not found in DB', async () => {
    mockSession.userId = 'ghost-user'
    mockPrisma.user.findUnique.mockResolvedValue(null)
    const { GET } = await import('../src/app/api/auth/me/route')
    const res = await GET()
    expect(res.status).toBe(401)
  })

  it('returns user data when authenticated', async () => {
    mockSession.userId = 'user-1'
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      email: 'user@example.com',
      name: 'Test User',
      createdAt: new Date('2024-01-01'),
      orgMembers: [
        {
          orgId: 'org-1',
          role: 'ADMIN',
          org: { id: 'org-1', name: 'Test Org', slug: 'test-org' },
        },
      ],
    })
    const { GET } = await import('../src/app/api/auth/me/route')
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.user.id).toBe('user-1')
    expect(body.orgMemberships[0].role).toBe('ADMIN')
  })
})
