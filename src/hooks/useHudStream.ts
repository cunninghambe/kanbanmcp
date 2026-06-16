'use client'

import { useEffect, useRef } from 'react'
import { mutate } from 'swr'

interface UseHudStreamOptions {
  sessionId: string | null
  enabled?: boolean
}

/**
 * Opens an EventSource to /api/hud/[id]/events and revalidates the session's
 * dispatch SWR cache whenever a `dispatch_updated` event arrives. Mirrors
 * useRealtime — same SSE-over-polling transport, cleaned up on unmount.
 */
export function useHudStream({ sessionId, enabled = true }: UseHudStreamOptions) {
  const esRef = useRef<EventSource | null>(null)

  useEffect(() => {
    if (!sessionId || !enabled) return

    if (esRef.current) {
      esRef.current.close()
      esRef.current = null
    }

    const es = new EventSource(`/api/hud/${encodeURIComponent(sessionId)}/events`)
    esRef.current = es

    function handle() {
      mutate(`/api/hud/${sessionId}`)
    }

    es.addEventListener('dispatch_updated', handle)
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) esRef.current = null
    }

    return () => {
      es.removeEventListener('dispatch_updated', handle)
      es.close()
      esRef.current = null
    }
  }, [sessionId, enabled])
}
