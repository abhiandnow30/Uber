import { useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { io, type Socket } from 'socket.io-client';
import { useAuth } from './auth';
import { useToast } from '../components/ui';

type RealtimeCtx = { connected: boolean; socket: Socket | null };
const Ctx = createContext<RealtimeCtx>({ connected: false, socket: null });

/** Several changes in quick succession (e.g. assigning a shared cab) refresh the screen once. */
const REFRESH_DELAY_MS = 300;

/**
 * Socket.IO connection authenticated by the session cookie. Whenever anyone changes something,
 * the server says so and every open screen refreshes what it shows, so all roles stay in step.
 * On (re)connect everything is refreshed too, so nothing is missed while offline.
 */
export function RealtimeProvider({ children }: { children: ReactNode }) {
  const { me } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [connected, setConnected] = useState(false);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    if (!me) return;
    // Default transports: starts over plain HTTP and upgrades to WebSocket when the proxy allows it,
    // so live updates also work behind a proxy without WebSocket support.
    const socket = io({ path: '/socket.io', withCredentials: true });
    socketRef.current = socket;

    // Refetches what is on screen now; everything else is marked stale and refetches when opened.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refreshAll = () => {
      clearTimeout(timer);
      timer = setTimeout(() => qc.invalidateQueries(), REFRESH_DELAY_MS);
    };

    socket.on('connect', () => {
      setConnected(true);
      refreshAll();
    });
    socket.on('disconnect', () => setConnected(false));
    socket.on('notification', (n: { title: string; body: string }) => {
      refreshAll();
      toast.info(n.title, n.body);
    });
    socket.on('data:changed', refreshAll);
    socket.on('booking:updated', refreshAll);
    socket.on('assignment:created', refreshAll);
    return () => {
      clearTimeout(timer);
      socket.close();
      socketRef.current = null;
      setConnected(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me?.user.id]);

  return <Ctx.Provider value={{ connected, socket: socketRef.current }}>{children}</Ctx.Provider>;
}

export const useRealtime = () => useContext(Ctx);
