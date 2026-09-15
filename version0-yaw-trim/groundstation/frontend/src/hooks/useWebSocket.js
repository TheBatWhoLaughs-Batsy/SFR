import { useState, useEffect, useRef, useCallback } from 'react';

const RECONNECT_INTERVAL = 500;

// options.decodeBinary(arrayBuffer) -> message object, or null if the frame is not
// one it understands. Without it binary frames are ignored, as before.
export function useWebSocket(url, onMessage, options) {
  const [status, setStatus] = useState('disconnected');
  const wsRef = useRef(null);
  const reconnectTimer = useRef(null);
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;
  const urlRef = useRef(url);
  urlRef.current = url;
  const decodeBinaryRef = useRef(options?.decodeBinary);
  decodeBinaryRef.current = options?.decodeBinary;
  const binaryWarnedRef = useRef(false);

  const connect = useCallback(() => {
    const cur = wsRef.current;
    if (cur && (cur.readyState === WebSocket.OPEN || cur.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const target = urlRef.current;
    if (!target) return;

    clearTimeout(reconnectTimer.current);
    reconnectTimer.current = null;

    setStatus('reconnecting');
    const ws = new WebSocket(target);
    // ArrayBuffer rather than Blob so binary frames decode synchronously and stay in
    // arrival order. Text frames are unaffected.
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;

    ws.onopen = () => {
      if (wsRef.current !== ws) { ws.close(); return; }
      console.log(`[ws] connected to ${target}`);
      setStatus('connected');
    };

    ws.onmessage = (event) => {
      if (typeof event.data !== 'string') {
        const decode = decodeBinaryRef.current;
        if (!decode) return;
        let msg = null;
        try {
          msg = decode(event.data);
        } catch (err) {
          msg = null;
          if (!binaryWarnedRef.current) console.warn(`[ws] ${target}: binary frame failed to decode`, err);
        }
        if (msg) {
          onMessageRef.current?.(msg);
        } else if (!binaryWarnedRef.current) {
          // Once per hook, not per frame: at 100 Hz a per-frame warning would bury the console.
          binaryWarnedRef.current = true;
          console.warn(`[ws] ${target}: ignoring a binary frame this client does not understand`);
        }
        return;
      }
      try {
        const msg = JSON.parse(event.data);
        onMessageRef.current?.(msg);
      } catch {}
    };

    ws.onclose = (ev) => {
      if (wsRef.current === ws) {
        wsRef.current = null;
        console.warn(`[ws] disconnected from ${target} (code=${ev.code})`);
        setStatus('disconnected');
        clearTimeout(reconnectTimer.current);
        reconnectTimer.current = setTimeout(connect, RECONNECT_INTERVAL);
      }
    };

    ws.onerror = () => ws.close();
  }, []);

  const disconnect = useCallback(() => {
    const ws = wsRef.current;
    if (ws) {
      wsRef.current = null;
      clearTimeout(reconnectTimer.current);
      reconnectTimer.current = null;
      ws.close();
    }
    setStatus('disconnected');
  }, []);

  useEffect(() => {
    return () => {
      const ws = wsRef.current;
      if (ws) {
        wsRef.current = null;
        clearTimeout(reconnectTimer.current);
        reconnectTimer.current = null;
        ws.close();
      }
    };
  }, []);

  const send = useCallback((msg) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }, []);

  return { status, send, connect, disconnect };
}
