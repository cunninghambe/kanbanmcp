'use client'

import { useEffect, useRef } from 'react'
import { mutate } from 'swr'

interface UseHudStreamOptions {
  sessionId: string | null
  enabled?: boolean
}

const MAX_CONSECUTIVE_ERRORS = 5

/**
 * Opens an EventSource to /api/hud/[id]/events and revalidates the session's
 * dispatch SWR cache on each `dispatch_updated` event. Gated on `enabled` (caller
 * passes false until the session is confirmed to exist) and bounded: after
 * MAX_CONSECUTIVE_ERRORS reconnect failures without a successful open, it closes
 * and stops, so a 401/404/permanent failure can't spam the browser console.
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
    let errorCount = 0

    function handle() {
      mutate(`/api/hud/${sessionId}`)
    }

    es.addEventListener('dispatch_updated', handle)
    es.onopen = () => {
      errorCount = 0
    }
    es.onerror = () => {
      errorCount += 1
      if (errorCount >= MAX_CONSECUTIVE_ERRORS || es.readyState === EventSource.CLOSED) {
        es.close()
        if (esRef.current === es) esRef.current = null
      }
    }

    return () => {
      es.removeEventListener('dispatch_updated', handle)
      es.close()
      esRef.current = null
    }
  }, [sessionId, enabled])
}
