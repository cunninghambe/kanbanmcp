import { describe, it, expect } from 'vitest'
import { isAllowedMime, shapeArtifact, MAX_ARTIFACT_BYTES } from '../../src/lib/artifacts'
import type { Artifact, User, AiReview } from '@prisma/client'

describe('isAllowedMime', () => {
  it.each([
    ['application/pdf', true],
    ['application/json', true],
    ['application/x-yaml', true],
    ['text/markdown', true],
    ['image/png', true],
    ['image/jpeg', true],
    ['image/webp', true],
    ['text/plain', true],
    ['text/csv', true],
    ['text/html', false],
    ['application/zip', false],
    ['application/octet-stream', false],
    ['video/mp4', false],
    ['audio/mpeg', false],
    ['application/x-executable', false],
  ])('%s → %s', (mime, expected) => {
    expect(isAllowedMime(mime)).toBe(expected)
  })
})

describe('MAX_ARTIFACT_BYTES', () => {
  it('is 25 MB', () => {
    expect(MAX_ARTIFACT_BYTES).toBe(25 * 1024 * 1024)
  })
})

describe('shapeArtifact', () => {
  it('produces the expected response shape', () => {
    const now = new Date('2024-01-01T00:00:00.000Z')
    const artifact = {
      id: 'art-1',
      cardId: 'card-1',
      uploaderId: 'user-1',
      filename: 'report.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1024,
      storageKey: 'art-1',
      source: 'UPLOAD',
      createdAt: now,
      uploader: {
        id: 'user-1',
        email: 'user@example.com',
        name: 'Alice',
        passwordHash: 'hash',
        isAgent: false,
        createdAt: now,
      } as User,
      reviews: [
        {
          id: 'rev-1',
          artifactId: 'art-1',
          status: 'done',
          model: 'claude-opus-4-7',
          rubricSnapshot: 'rubric',
          instructions: null,
          output: 'looks good',
          errorMessage: null,
          inputTokens: 100,
          outputTokens: 50,
          startedAt: now,
          finishedAt: now,
          createdAt: now,
        } as AiReview,
      ],
    } as Artifact & { uploader: User; reviews: AiReview[] }

    const shaped = shapeArtifact(artifact)

    expect(shaped).toEqual({
      id: 'art-1',
      filename: 'report.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1024,
      source: 'UPLOAD',
      createdAt: now.toISOString(),
      uploader: { id: 'user-1', name: 'Alice', email: 'user@example.com' },
      reviews: [
        {
          id: 'rev-1',
          status: 'done',
          model: 'claude-opus-4-7',
          createdAt: now.toISOString(),
          startedAt: now.toISOString(),
          finishedAt: now.toISOString(),
        },
      ],
    })
  })

  it('handles empty reviews array', () => {
    const now = new Date()
    const artifact = {
      id: 'art-2',
      cardId: 'card-1',
      uploaderId: 'user-1',
      filename: 'doc.txt',
      mimeType: 'text/plain',
      sizeBytes: 10,
      storageKey: 'art-2',
      source: 'UPLOAD',
      createdAt: now,
      uploader: {
        id: 'user-1',
        name: 'Bob',
        email: 'bob@example.com',
        passwordHash: 'h',
        isAgent: false,
        createdAt: now,
      } as User,
      reviews: [] as AiReview[],
    } as Artifact & { uploader: User; reviews: AiReview[] }

    expect(shapeArtifact(artifact).reviews).toEqual([])
  })
})
