'use client'

import { useEffect, useRef } from 'react'
import { mutate } from 'swr'

interface UseRealtimeOptions {
  boardId: string | null
  enabled?: boolean
}

/**
 * Opens an EventSource connection to /api/realtime?boardId=X and updates
 * the SWR board cache when card events arrive.
 * Cleans up the EventSource on unmount or when boardId changes.
 */
export function useRealtime({ boardId, enabled = true }: UseRealtimeOptions) {
  const eventSourceRef = useRef<EventSource | null>(null)

  useEffect(() => {
    if (!boardId || !enabled) return

    // Close any existing connection before opening a new one
    if (eventSourceRef.current) {
      eventSourceRef.current.close()
      eventSourceRef.current = null
    }

    const url = `/api/realtime?boardId=${encodeURIComponent(boardId)}`
    const es = new EventSource(url)
    eventSourceRef.current = es

    function handleCardEvent() {
      // Revalidate the board SWR cache so the UI reflects the latest data
      mutate(`/api/boards/${boardId}`)
    }

    es.addEventListener('card_created', handleCardEvent)
    es.addEventListener('card_updated', handleCardEvent)
    es.addEventListener('card_moved', handleCardEvent)

    es.onerror = () => {
      // EventSource auto-reconnects on error; we just let it do its thing.
      // If the connection has been permanently closed, clean up.
      if (es.readyState === EventSource.CLOSED) {
        eventSourceRef.current = null
      }
    }

    return () => {
      es.removeEventListener('card_created', handleCardEvent)
      es.removeEventListener('card_updated', handleCardEvent)
      es.removeEventListener('card_moved', handleCardEvent)
      es.close()
      eventSourceRef.current = null
    }
  }, [boardId, enabled])
}
