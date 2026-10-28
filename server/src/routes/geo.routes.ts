import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { config } from '../config.js';
import { query } from '../middleware/common.js';
import { AppError } from '../utils/errors.js';

/**
 * The home's exact spot from a Google Maps link the person pastes: Google's own coordinates are in the
 * link, so this is precise, free and needs no API key. Short share links (maps.app.goo.gl/…) are
 * followed to the full link first. Only Google Maps addresses are ever requested, so the endpoint
 * can't be used to reach other sites.
 */
export const geoRouter = Router();

type LatLng = { lat: number; lng: number };

const GOOGLE_HOSTS = /^(?:www\.|maps\.)?google\.(?:com|co\.in)$|^maps\.app\.goo\.gl$|^goo\.gl$|^consent\.google\.com$/;
const MAX_REDIRECTS = 4;

const point = (lat: string, lng: string): LatLng | null => {
  const p = { lat: Number(lat), lng: Number(lng) };
  return Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180 && (p.lat !== 0 || p.lng !== 0) ? p : null;
};

/**
 * Coordinates from a full Google Maps link, most exact first:
 *  1. written out: …/search/17.46,78.34  ·  ?q=17.46,78.34  ·  …/place/17.46,78.34
 *  2. the selected place's own pin: …!1s<place id>…!3d<lat>!4d<lng>
 *  3. a dropped pin: the first …!3d<lat>!4d<lng>
 * The "@lat,lng" part is only where the map was looking (the side panel shifts it), so it isn't used.
 */
export function coordsFromMapsUrl(link: string): LatLng | null {
  let text = link;
  try {
    text = decodeURIComponent(link);
  } catch {
    // keep the raw text
  }
  const written = text.match(/(?:[?&](?:q|query|ll|destination|daddr)=|\/(?:search|place|dir)\/)(?:loc:)?\s*(-?\d{1,2}\.\d+)\s*,\s*\+?\s*(-?\d{1,3}\.\d+)/);
  if (written) return point(written[1], written[2]);
  const place = text.match(/!1s0x[0-9a-f]+:0x[0-9a-f]+.*?!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/i);
  if (place) return point(place[1], place[2]);
  const pin = text.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
  return pin ? point(pin[1], pin[2]) : null;
}

const isGoogleMaps = (u: URL) => (u.protocol === 'https:' || u.protocol === 'http:') && GOOGLE_HOSTS.test(u.hostname.toLowerCase());

/** Follows a short share link to the full Google Maps link (Google hosts only), without loading the page. */
async function fullLink(link: string): Promise<string> {
  let url = new URL(link);
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    if (!isGoogleMaps(url)) throw new AppError(422, 'NOT_A_MAPS_LINK', 'Paste a link from Google Maps.');
    // Some regions get a cookie-consent page first; the real link is in its "continue" parameter.
    if (url.hostname === 'consent.google.com' && url.searchParams.get('continue')) {
      url = new URL(url.searchParams.get('continue')!);
      continue;
    }
    if (coordsFromMapsUrl(url.href)) return url.href;
    const r = await fetch(url, { redirect: 'manual', headers: { 'User-Agent': `NeutaraCabs/1.0 (${config.APP_BASE_URL})` }, signal: AbortSignal.timeout(8000) });
    const next = r.status >= 300 && r.status < 400 ? r.headers.get('location') : null;
    if (!next) return url.href;
    url = new URL(next, url);
  }
  return url.href;
}

export const linkLimiter = rateLimit({
  windowMs: 60_000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => `geo:${req.auth?.user?._id ?? req.ip}`,
  skip: () => config.isTest,
});

const linkQuery = z.object({ url: z.string().trim().min(10, 'Paste the Google Maps link').max(2000) });

/** Shared by signed-in users (/api/geo/link) and people registering (/api/auth/sso/geo/link). */
export async function mapsLinkLookup(req: Request, res: Response) {
  const { url } = query(linkQuery, req);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new AppError(422, 'NOT_A_MAPS_LINK', 'Paste a link from Google Maps (it starts with https://).');
  }
  const direct = coordsFromMapsUrl(parsed.href);
  if (direct) return res.json(direct);
  let full: string;
  try {
    full = await fullLink(parsed.href);
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(502, 'MAPS_LINK_FAILED', 'Couldn’t open that link just now. Try again, or paste the link from the browser’s address bar.');
  }
  const found = coordsFromMapsUrl(full);
  if (!found) {
    throw new AppError(
      422,
      'NO_LOCATION_IN_LINK',
      'This link names the place but doesn’t contain its location. In Google Maps, long-press exactly on the building to drop a pin, then share or copy that pin’s link.',
    );
  }
  res.json(found);
}

geoRouter.get('/link', linkLimiter, mapsLinkLookup);
