import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { useBlocker } from 'react-router-dom';
import { Alert, Button, Modal } from '../components/ui';
import { errorMessage } from './api';

/**
 * Unsaved changes, app-wide. Forms register whether they have unsaved edits and how to save them;
 * leaving the page (links, back button, sign out) or closing a popup with unsaved edits asks first:
 * Save, Discard or Keep editing. Refreshing or closing the tab gets the browser's own warning
 * (browsers don't allow custom text there).
 */

/** Saves the form; resolves false (or throws) when it couldn't, e.g. a field needs fixing. */
type Save = () => Promise<boolean>;
type Entry = { dirty: boolean; save?: Save };
type Ask = { ids: string[] | null; proceed: () => void; cancel: () => void };

const UnsavedContext = createContext<{
  set: (id: string, entry: Entry | null) => void;
  ask: (ids: string[] | null, proceed: () => void, cancel?: () => void) => void;
} | null>(null);

export function UnsavedChangesProvider({ children }: { children: ReactNode }) {
  const entries = useRef(new Map<string, Entry>());
  const [asking, setAsking] = useState<Ask | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const dirtyIds = (ids: string[] | null) => [...entries.current].filter(([id, e]) => e.dirty && (!ids || ids.includes(id))).map(([id]) => id);

  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirtyIds(null).length > 0 && (currentLocation.pathname !== nextLocation.pathname || currentLocation.search !== nextLocation.search));

  useEffect(() => {
    // Only once per blocked navigation (the blocker object changes on every render).
    if (blocker.state === 'blocked') setAsking((a) => a ?? { ids: null, proceed: () => blocker.proceed(), cancel: () => blocker.reset() });
  }, [blocker]);

  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => {
      if (!dirtyIds(null).length) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, []);

  const set = useCallback((id: string, entry: Entry | null) => {
    if (entry) entries.current.set(id, entry);
    else entries.current.delete(id);
  }, []);
  const ask = useCallback((ids: string[] | null, proceed: () => void, cancel = () => {}) => {
    setAsking((a) => a ?? { ids, proceed, cancel });
  }, []);

  const close = (then: () => void) => {
    setAsking(null);
    setError('');
    then();
  };
  const ids = asking ? dirtyIds(asking.ids) : [];
  const saves = ids.map((id) => entries.current.get(id)?.save);
  const canSave = saves.length > 0 && saves.every(Boolean);

  const saveAll = async () => {
    setBusy(true);
    setError('');
    try {
      for (const s of saves) {
        if (!(await s!())) {
          setError('Some changes could not be saved. Keep editing to fix the highlighted fields, or discard them.');
          return;
        }
      }
      close(asking!.proceed);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <UnsavedContext.Provider value={{ set, ask }}>
      {children}
      <Modal
        open={!!asking}
        onClose={() => !busy && close(asking!.cancel)}
        title="You have unsaved changes"
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => close(asking!.cancel)} disabled={busy}>
              Keep editing
            </Button>
            <Button variant="secondary" className="text-red-700" onClick={() => close(asking!.proceed)} disabled={busy}>
              Discard changes
            </Button>
            {canSave && (
              <Button onClick={saveAll} loading={busy}>
                Save changes
              </Button>
            )}
          </>
        }
      >
        <p className="text-sm text-slate-700">The changes you made haven&apos;t been saved yet. Save them before you go, or discard them?</p>
        {error && (
          <div className="mt-3">
            <Alert tone="error">{error}</Alert>
          </div>
        )}
      </Modal>
    </UnsavedContext.Provider>
  );
}

/**
 * Registers a form's unsaved edits. Returns `guard(action)`: runs the action (e.g. closing a popup)
 * straight away when nothing is unsaved, otherwise after the person saves or discards.
 * `guard.release()` marks the form saved at once, for a form that navigates right after saving.
 */
export function useUnsavedChanges(dirty: boolean, save?: Save): ((action: () => void) => void) & { release: () => void } {
  const ctx = useContext(UnsavedContext);
  const id = useId();
  const saveRef = useRef(save);
  saveRef.current = save;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const hasSave = !!save;

  useEffect(() => {
    ctx?.set(id, { dirty, save: hasSave ? () => saveRef.current!() : undefined });
  }, [ctx, id, dirty, hasSave]);
  useEffect(() => () => ctx?.set(id, null), [ctx, id]);

  return useMemo(() => {
    const guard = (action: () => void) => {
      if (!dirtyRef.current || !ctx) action();
      else ctx.ask([id], action);
    };
    const release = () => {
      dirtyRef.current = false;
      ctx?.set(id, { dirty: false });
    };
    return Object.assign(guard, { release });
  }, [ctx, id]);
}

/** True when a form's values differ from where they started. */
export const changed = (value: unknown, initial: unknown) => JSON.stringify(value) !== JSON.stringify(initial);
