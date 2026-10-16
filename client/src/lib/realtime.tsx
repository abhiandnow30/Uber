import { useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { io, type Socket } from 'socket.io-client';
import { useAuth } from './auth';
import { useToast } from '../components/ui';

type RealtimeCtx = { connected: boolean; socket: Socket | null };
const Ctx = createContext<RealtimeCtx>({ connected: false, socket: null });

/**
 * Socket.IO connection authenticated by the session cookie. Server events
 * invalidate the relevant React Query caches; on (re)connect we re-sync
 * notifications from the API so nothing is missed while offline.
 */
export function RealtimeProvider({ children }: { children: ReactNode }) {
  const { me } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [connected, setConnected] = useState(false);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    if (!me) return;
    const socket = io({ path: '/socket.io', withCredentials: true, transports: ['websocket', 'polling'] });
    socketRef.current = socket;
    socket.on('connect', () => {
      setConnected(true);
      qc.invalidateQueries({ queryKey: ['notifications'] });
    });
    socket.on('disconnect', () => setConnected(false));
    socket.on('notification', (n: { title: string; body: string }) => {
      qc.invalidateQueries({ queryKey: ['notifications'] });
      qc.invalidateQueries({ queryKey: ['driver'] });
      qc.invalidateQueries({ queryKey: ['my-bookings'] });
      qc.invalidateQueries({ queryKey: ['employee-home'] });
      toast.info(n.title, n.body);
    });
    const refreshOps = () => {
      qc.invalidateQueries({ queryKey: ['ops'] });
      qc.invalidateQueries({ queryKey: ['my-bookings'] });
      qc.invalidateQueries({ queryKey: ['employee-home'] });
      qc.invalidateQueries({ queryKey: ['admin-dashboard'] });
    };
    socket.on('booking:updated', refreshOps);
    socket.on('assignment:created', refreshOps);
    return () => {
      socket.close();
      socketRef.current = null;
      setConnected(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me?.user.id]);

  return <Ctx.Provider value={{ connected, socket: socketRef.current }}>{children}</Ctx.Provider>;
}

export const useRealtime = () => useContext(Ctx);
