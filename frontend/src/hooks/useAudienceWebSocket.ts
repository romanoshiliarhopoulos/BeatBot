import { useEffect, useRef, useState, useCallback } from 'react'
import type { AudienceWsEvent } from '../types'

const RECONNECT_BASE_MS = 500
const RECONNECT_MAX_MS = 5_000

interface UseAudienceWebSocketReturn {
  isConnected: boolean
  lastEvent: AudienceWsEvent | null
}

export function useAudienceWebSocket(sessionId: string | null): UseAudienceWebSocketReturn {
  const [isConnected, setIsConnected] = useState(false)
  const [lastEvent, setLastEvent] = useState<AudienceWsEvent | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reconnectDelay = useRef(RECONNECT_BASE_MS)
  const isMounted = useRef(true)

  const listenerId = useRef(() => {
    const key = 'beatbot_listener_id'
    let id = localStorage.getItem(key)
    if (!id) {
      id = Math.random().toString(36).slice(2, 10)
      localStorage.setItem(key, id)
    }
    return id
  })

  const connect = useCallback(() => {
    if (!isMounted.current || !sessionId) return

    const apiBase = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? ''
    let url: string
    if (apiBase) {
      const wsBase = apiBase.replace(/^http/, 'ws')
      url = `${wsBase}/ws/live/${sessionId}`
    } else if (import.meta.env.DEV) {
      url = `ws://localhost:8000/ws/live/${sessionId}`
    } else {
      url = `/ws/live/${sessionId}`
    }

    const lid = typeof listenerId.current === 'function' ? listenerId.current() : listenerId.current
    url += `?listener_id=${encodeURIComponent(lid)}`

    const ws = new WebSocket(url)
    wsRef.current = ws

    ws.onopen = () => {
      if (!isMounted.current) return
      reconnectDelay.current = RECONNECT_BASE_MS
      setIsConnected(true)
    }

    ws.onmessage = (event) => {
      if (!isMounted.current) return
      try {
        const data = JSON.parse(event.data) as AudienceWsEvent
        setLastEvent(data)
      } catch {
        // ignore
      }
    }

    ws.onclose = () => {
      if (!isMounted.current) return
      setIsConnected(false)
      wsRef.current = null
      const delay = reconnectDelay.current
      reconnectDelay.current = Math.min(delay * 2, RECONNECT_MAX_MS)
      reconnectTimer.current = setTimeout(connect, delay)
    }

    ws.onerror = () => { ws.close() }
  }, [sessionId])

  useEffect(() => {
    isMounted.current = true
    
    // FIX: Debounce the connection by 10ms to survive React Strict Mode double-mounting
    let mountTimeout: ReturnType<typeof setTimeout> | null = null;
    if (sessionId) {
      mountTimeout = setTimeout(() => connect(), 10);
    }

    return () => {
      isMounted.current = false
      if (mountTimeout) clearTimeout(mountTimeout);
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current)
      
      if (wsRef.current) {
        // Neutralize the onclose handler so we don't trigger a reconnect loop on unmount
        wsRef.current.onclose = null; 
        wsRef.current.close()
      }
    }
  }, [connect, sessionId])

  return { isConnected, lastEvent }
}