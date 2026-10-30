import { AlertCircle, CheckCircle2, ExternalLink, Link2, Loader2 } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { errorMessage, get } from '../lib/api';
import { Input, cn } from './ui';

export type LatLng = { lat: number; lng: number };
/** An exact spot and the Google Maps link (or typed coordinates) it was taken from. */
export type MapSpot = { link: string; pin: LatLng | null };

/** "17.461760, 78.348565" as copied from Google Maps (also "17.46176 78.348565" or with °N/°E). */
export function parseCoordinates(text: string): LatLng | null {
  const m = text
    .replace(/°\s*[NE]/gi, '')
    .trim()
    .match(/^(-?\d{1,2}(?:\.\d+)?)\s*[,\s]\s*(-?\d{1,3}(?:\.\d+)?)$/);
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;
const show = (p: LatLng) => `${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}`;
/**
 * What "Check in Google Maps" opens: the link that was pasted, so Google shows that same place page
 * (name, photos, address); only typed coordinates fall back to a link built from the coordinates.
 */
export const mapsHref = (s: MapSpot) => (/^https:\/\/[^\s]+$/i.test(s.link.trim()) ? s.link.trim() : `https://www.google.com/maps?q=${s.pin?.lat},${s.pin?.lng}`);

/** Same spot and same link: used by forms to tell whether the location changed. */
export const sameSpot = (a: MapSpot, b: MapSpot) => a.link.trim() === b.link.trim() && JSON.stringify(a.pin) === JSON.stringify(b.pin);

/** The home address plus its exact spot (see MapLinkField). */
export function AddressPicker({
  address,
  onAddress,
  spot,
  onSpot,
  saved,
  label = 'Present address',
  hint,
  error,
  required,
  linkPath,
  mapRequired = false,
}: {
  address: string;
  onAddress: (v: string) => void;
  spot: MapSpot;
  onSpot: (v: MapSpot) => void;
  saved: boolean;
  label?: string;
  hint?: string;
  error?: string;
  required?: boolean;
  linkPath?: string;
  /** The Google Maps link must be filled in too. */
  mapRequired?: boolean;
}) {
  return (
    <div className="space-y-3">
      <Input
        label={label}
        required={required}
        value={address}
        onChange={(e) => onAddress(e.target.value)}
        maxLength={300}
        autoComplete="street-address"
        placeholder="Flat / house no., building, street, area, city, PIN code"
        error={error}
        hint={hint}
      />
      <MapLinkField spot={spot} onSpot={onSpot} saved={saved} linkPath={linkPath} required={mapRequired} />
    </div>
  );
}

/**
 * An exact spot from a Google Maps link the person pastes (Google's own coordinates are in the link,
 * so it's exact and free) or from coordinates. The form owns the value (link + spot); `saved` says whether what's shown is already saved, so the
 * person can tell a new, unsaved location from the saved one. `linkPath` is the API that reads links
 * (people still registering use their own one).
 */
export function MapLinkField({
  spot,
  onSpot,
  saved,
  label = 'Google Maps link of the home',
  linkPath = '/geo/link',
  required = false,
}: {
  spot: MapSpot;
  onSpot: (v: MapSpot) => void;
  saved: boolean;
  label?: string;
  linkPath?: string;
  /** Must be filled in: shown with a star, and the location can be replaced but not removed. */
  required?: boolean;
}) {
  const id = useId();
  const [reading, setReading] = useState(false);
  const [linkError, setLinkError] = useState('');
  const spotRef = useRef(spot);
  spotRef.current = spot;
  const onSpotRef = useRef(onSpot);
  onSpotRef.current = onSpot;
  // The link the current spot was read from (and that spot): a link that's already been read isn't read again.
  const readFor = useRef(spot.pin ? spot.link.trim() : '');
  const readPin = useRef(spot.pin);

  useEffect(() => {
    const text = spot.link.trim();
    setLinkError('');
    if (!text || text === readFor.current) return;
    const typed = parseCoordinates(text);
    if (typed) {
      readFor.current = text;
      readPin.current = { lat: round(typed.lat), lng: round(typed.lng) };
      onSpotRef.current({ link: spotRef.current.link, pin: readPin.current });
      return;
    }
    if (!/^https?:\/\//i.test(text)) {
      setLinkError('Paste the link from Google Maps (it starts with https://), or coordinates like 17.461760, 78.348565.');
      return;
    }
    let stale = false;
    const t = setTimeout(async () => {
      setReading(true);
      try {
        const p = await get<LatLng>(`${linkPath}?url=${encodeURIComponent(text)}`);
        if (stale) return;
        readFor.current = text;
        readPin.current = { lat: round(p.lat), lng: round(p.lng) };
        onSpotRef.current({ link: spotRef.current.link, pin: readPin.current });
      } catch (e) {
        if (!stale) setLinkError(errorMessage(e));
      } finally {
        if (!stale) setReading(false);
      }
    }, 300);
    return () => {
      stale = true;
      clearTimeout(t);
      setReading(false);
    };
  }, [spot.link, linkPath]);

  const link = spot.link.trim();
  // The pin shown belongs to the link in the box (not to a link that's still being read or failed).
  const current = !!spot.pin && (!link || link === readFor.current);

  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
      <label htmlFor={`${id}-link`} className="mb-1 flex items-center gap-1.5 text-sm font-medium text-slate-700">
        <Link2 className="h-4 w-4 text-indigo-600" aria-hidden /> {label}
        {required && (
          <span className="text-red-600" aria-hidden>
            *
          </span>
        )}
      </label>
      <div className="relative">
        <input
          id={`${id}-link`}
          value={spot.link}
          // A changed link has no location until it's read: the old one is never saved with the new link.
          onChange={(e) => onSpot({ link: e.target.value, pin: e.target.value.trim() === readFor.current ? readPin.current : null })}
          onKeyDown={(e) => e.key === 'Enter' && e.preventDefault()}
          placeholder="Paste the link, e.g. https://maps.app.goo.gl/…"
          inputMode="url"
          className={cn(
            'h-11 w-full rounded-lg border bg-white px-3 pr-9 text-sm focus:outline-none focus:ring-2',
            linkError ? 'border-red-400 focus:ring-red-100' : 'border-slate-300 focus:border-indigo-500 focus:ring-indigo-100',
          )}
        />
        {reading && <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-slate-400" aria-label="Reading the link" />}
      </div>
      {linkError ? (
        <p className="mt-1 text-sm text-red-600">{linkError}</p>
      ) : (
        <p className="mt-1 text-xs text-slate-500">
          In Google Maps, find the place (or long-press exactly on the building), tap <strong>Share</strong> and <strong>Copy link</strong>, then paste it here. On a computer you can copy the link from the
          address bar.
        </p>
      )}

      {spot.pin && current ? (
        <div className={cn('mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-white px-3 py-2 text-sm ring-1', saved ? 'ring-emerald-200' : 'ring-amber-300')}>
          <span className={cn('flex flex-wrap items-center gap-1.5', saved ? 'text-emerald-800' : 'text-amber-800')}>
            {saved ? <CheckCircle2 className="h-4 w-4" aria-hidden /> : <AlertCircle className="h-4 w-4" aria-hidden />}
            {saved ? 'Saved location:' : 'New location — save to keep it:'} <span className="font-mono">{show(spot.pin)}</span>
          </span>
          <span className="flex items-center gap-3">
            <a href={mapsHref(spot)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-indigo-700 hover:underline">
              Check in Google Maps <ExternalLink className="h-3.5 w-3.5" aria-hidden />
            </a>
            {!required && (
              <button
                type="button"
                onClick={() => {
                  readFor.current = '';
                  readPin.current = null;
                  setLinkError('');
                  onSpot({ link: '', pin: null });
                }}
                className="text-red-700 hover:underline"
              >
                Remove
              </button>
            )}
          </span>
        </div>
      ) : (
        !reading &&
        !linkError && (
          <p className={cn('mt-3 text-xs', required ? 'font-medium text-amber-700' : 'text-slate-500')}>
            {required ? 'Required: paste your home’s Google Maps link so your driver finds you exactly.' : saved ? 'No exact location saved yet.' : 'Location removed — save to confirm.'}
          </p>
        )
      )}
    </div>
  );
}
