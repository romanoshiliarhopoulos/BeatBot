import { useEffect, useRef, useState, useCallback } from 'react'
import type { WsEvent } from '../types'

const WS_URL = '/ws/session'
// Exponential backoff: starts fast after uvicorn --reload drops the connection,
// caps out so we don't spam the backend if it's genuinely down.
const RECONNECT_BASE_MS = 150
const RECONNECT_MAX_MS  = 5_000

interface UseWebSocketReturn {
  isConnected: boolean
  lastEvent: WsEvent | null
  sendMessage: (msg: object) => void
}

export function useWebSocket(): UseWebSocketReturn {
  const [isConnected, setIsConnected] = useState(false)
  const [lastEvent, setLastEvent] = useState<WsEvent | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reconnectDelay = useRef(RECONNECT_BASE_MS)
  const isMounted = useRef(true)

  const connect = useCallback(() => {
    if (!isMounted.current) return

    // In development Vite proxies the WS connection, but when uvicorn
    // restarts (--reload) the proxy logs a noisy ECONNRESET that can't be
    // suppressed from vite.config.  Connecting directly to the backend port
    // avoids the proxy entirely and eliminates the noise.
    // In production both frontend and backend share the same host.
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const host = import.meta.env.DEV ? 'localhost:8000' : window.location.host
    const url = `${protocol}://${host}${WS_URL}`

    const ws = new WebSocket(url)
    wsRef.current = ws

    ws.onopen = () => {
      if (!isMounted.current) return
      reconnectDelay.current = RECONNECT_BASE_MS  // reset backoff on success
      setIsConnected(true)
    }

    ws.onmessage = (event) => {
      if (!isMounted.current) return
      try {
        const data = JSON.parse(event.data) as WsEvent
        setLastEvent(data)
      } catch {
        // ignore malformed messages
      }
    }

    ws.onclose = () => {
      if (!isMounted.current) return
      setIsConnected(false)
      wsRef.current = null
      // Exponential backoff: double on every failure, cap at max
      const delay = reconnectDelay.current
      reconnectDelay.current = Math.min(delay * 2, RECONNECT_MAX_MS)
      reconnectTimer.current = setTimeout(connect, delay)
    }

    ws.onerror = () => {
      ws.close()
    }
  }, [])

  useEffect(() => {
    isMounted.current = true
    connect()

    return () => {
      isMounted.current = false
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current)
      wsRef.current?.close()
    }
  }, [connect])

  const sendMessage = useCallback((msg: object) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg))
    }
  }, [])

  return { isConnected, lastEvent, sendMessage }
}
