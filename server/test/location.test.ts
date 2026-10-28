import { afterEach, describe, expect, it, vi } from 'vitest';
import { Employee } from '../src/models/Employee.js';
import { coordsFromMapsUrl } from '../src/routes/geo.routes.js';
import { issueRegistrationTicket } from '../src/services/sso.service.js';
import { anonymous, makeAdmin, makeEmployee } from './helpers.js';

// A link copied from the browser's address bar: the selected place plus a dropped pin near it.
const PLACE_LINK =
  'https://www.google.com/maps/place/Neutara+Technologies/@17.4632263,78.3448299,16.11z/data=!4m12!1m5!3m4!2zMTfCsDI3JzQyLjMiTiA3OMKwMjAnNTQuOCJF!8m2!3d17.46176!4d78.348565!3m5!1s0x3bcb93ba36771ba3:0x9279b080568d6c44!8m2!3d17.4617596!4d78.3511398!16s%2Fg%2F11ls15fknj?entry=ttu';
const link = (url: string) => `/api/geo/link?url=${encodeURIComponent(url)}`;

describe('home location from a Google Maps link', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reads Google’s own coordinates from every kind of link, and never guesses from the map view', () => {
    expect(coordsFromMapsUrl(PLACE_LINK)).toEqual({ lat: 17.4617596, lng: 78.3511398 }); // the place, not the dropped pin or "@"
    expect(coordsFromMapsUrl("https://www.google.com/maps/place/17%C2%B027'42.3%22N+78%C2%B020'54.8%22E/@17.46,78.34,17z/data=!3m1!4b1!4m4!3m3!8m2!3d17.46176!4d78.348565")).toEqual({ lat: 17.46176, lng: 78.348565 });
    expect(coordsFromMapsUrl('https://www.google.com/maps/search/17.46176,+78.348565')).toEqual({ lat: 17.46176, lng: 78.348565 });
    expect(coordsFromMapsUrl('https://maps.google.com/?q=17.46176,78.348565')).toEqual({ lat: 17.46176, lng: 78.348565 });
    // only the map view ("@") or only a name: no location
    expect(coordsFromMapsUrl('https://www.google.com/maps/@17.4632263,78.3448299,16z')).toBeNull();
    expect(coordsFromMapsUrl('https://maps.google.com/?q=Neutara+Technologies&ftid=0x3bcb93ba36771ba3:0x9279b080568d6c44')).toBeNull();
  });

  it('admins paste a link for an employee; the pin is saved and can be removed', async () => {
    const admin = (await makeAdmin()).client;
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const found = await admin.get(link(PLACE_LINK)).expect(200);
    expect(found.body).toEqual({ lat: 17.4617596, lng: 78.3511398 });
    expect(fetchSpy).not.toHaveBeenCalled(); // a full link is read without going online

    const emp = await makeEmployee();
    const id = String(emp.employee._id);
    await admin.patch(`/api/admin/employees/${id}`, { homeLocation: found.body }).expect(200);
    expect((await admin.get(`/api/admin/employees/${id}`)).body).toMatchObject({ homeLocation: { lat: 17.4617596, lng: 78.3511398 } });
    expect((await admin.patch(`/api/admin/employees/${id}`, { homeLocation: { lat: 95, lng: 78 } })).status).toBe(422);
    await admin.patch(`/api/admin/employees/${id}`, { homeLocation: null }).expect(200);
    expect((await Employee.findById(id).lean())!.homeLocation).toBeUndefined();

    expect((await anonymous().get(link(PLACE_LINK))).status).toBe(401);
  });

  it('follows short share links to Google only, and explains links that hold no location', async () => {
    const admin = (await makeAdmin()).client;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const u = new URL(String(input));
      if (u.pathname === '/pin') return new Response(null, { status: 302, headers: { location: 'https://www.google.com/maps/search/17.46176,+78.348565' } });
      if (u.pathname === '/named') return new Response(null, { status: 302, headers: { location: 'https://maps.google.com/?q=Neutara&ftid=0x1:0x2' } });
      if (u.pathname === '/elsewhere') return new Response(null, { status: 302, headers: { location: 'https://evil.example.com/steal' } });
      return new Response('<html></html>', { status: 200 });
    });

    expect((await admin.get(link('https://maps.app.goo.gl/pin')).expect(200)).body).toEqual({ lat: 17.46176, lng: 78.348565 });

    const named = await admin.get(link('https://maps.app.goo.gl/named'));
    expect(named.status).toBe(422);
    expect(named.body.error.code).toBe('NO_LOCATION_IN_LINK');

    // a redirect away from Google is not followed
    expect((await admin.get(link('https://maps.app.goo.gl/elsewhere'))).body.error.code).toBe('NOT_A_MAPS_LINK');
    expect(fetchSpy.mock.calls.every(([u]) => new URL(String(u)).hostname !== 'evil.example.com')).toBe(true);

    // other sites are never requested at all
    const before = fetchSpy.mock.calls.length;
    expect((await admin.get(link('https://example.com/maps?q=1'))).body.error.code).toBe('NOT_A_MAPS_LINK');
    expect((await admin.get(link('not a link at all'))).status).toBe(422);
    expect(fetchSpy.mock.calls.length).toBe(before);
  });

  it('employees set or replace their own home location from Account, but can’t remove it', async () => {
    const emp = await makeEmployee();
    await emp.client!.patch('/api/me/profile', { homeLocation: { lat: 17.4617596, lng: 78.3511398 }, homeMapLink: PLACE_LINK }).expect(200);
    // the link is kept as pasted, so it can be shown again
    expect((await emp.client!.get('/api/auth/me')).body.profile).toMatchObject({ homeLocation: { lat: 17.4617596, lng: 78.3511398 }, homeMapLink: PLACE_LINK });
    expect((await emp.client!.patch('/api/me/profile', { homeLocation: { lat: 17.46, lng: 200 } })).status).toBe(422);
    // it's required for their rides: it can be replaced, not removed
    expect((await emp.client!.patch('/api/me/profile', { homeLocation: null })).status).toBe(422);
    expect((await emp.client!.patch('/api/me/profile', { homeMapLink: '' })).status).toBe(422);
    await emp.client!.patch('/api/me/profile', { homeLocation: { lat: 17.458705, lng: 78.350621 }, homeMapLink: 'https://maps.google.com/?q=17.458705,78.350621' }).expect(200);
    expect((await Employee.findById(emp.employee._id).lean())!.homeLocation).toEqual({ lat: 17.458705, lng: 78.350621 });
  });

  it('admins save each office’s exact location in Settings', async () => {
    const admin = (await makeAdmin()).client;
    const offices = (await admin.get('/api/admin/policy').expect(200)).body.officeLocations as Array<Record<string, unknown>>;
    const withPin = offices.map((o) => (o.code === 'HYD' ? { ...o, location: { lat: 17.4617596, lng: 78.3511398 }, mapLink: PLACE_LINK } : o));
    await admin.put('/api/admin/policy', { officeLocations: withPin }).expect(200);
    const hyd = (await admin.get('/api/policy').expect(200)).body.officeLocations.find((o: { code: string }) => o.code === 'HYD');
    expect(hyd).toMatchObject({ location: { lat: 17.4617596, lng: 78.3511398 }, mapLink: PLACE_LINK });
    const bad = offices.map((o) => (o.code === 'HYD' ? { ...o, location: { lat: 91, lng: 78 } } : o));
    expect((await admin.put('/api/admin/policy', { officeLocations: bad })).status).toBe(422);
  });

  it('people registering with Microsoft can paste a link for their home', async () => {
    expect((await anonymous().get(`/api/auth/sso/geo/link?url=${encodeURIComponent(PLACE_LINK)}`)).status).toBe(401);

    const client = anonymous();
    client.agent.jar.setCookie(`cab_sso_reg=${issueRegistrationTicket({ oid: 'oid-pin', email: 'pin.person@company.com', name: 'Pin Person' })}; Path=/api/auth/sso`);
    const found = await client.get(`/api/auth/sso/geo/link?url=${encodeURIComponent(PLACE_LINK)}`).expect(200);

    await client
      .post('/api/auth/sso/register', { employeeId: 'PIN1', fullName: 'Pin Person', phone: '9000012345', officeLocation: 'HYD', homeAddress: '12th floor, Vamsiram Jyothi Granules, Kondapur', homeLocation: found.body, homeMapLink: PLACE_LINK })
      .expect(201);
    expect((await Employee.findOne({ employeeId: 'PIN1' }).lean())!.homeLocation).toMatchObject({ lat: 17.4617596, lng: 78.3511398 });
  });
});

describe('driver navigation to the exact pickup and drop', () => {
  it('gives the assigned driver the office and home spots in the ride’s direction, only while the ride is on', async () => {
    const { Policy } = await import('../src/models/Policy.js');
    const { invalidatePolicyCache } = await import('../src/services/policy.service.js');
    const { assign, employeePin, scenario, toArrived } = await import('./helpers.js');
    await Policy.updateOne({ key: 'global', 'officeLocations.code': 'HYD' }, { $set: { 'officeLocations.$.location': { lat: 17.4617596, lng: 78.3511398 } } });
    invalidatePolicyCache();

    const s = await scenario();
    await Employee.updateOne({ _id: s.emp.employee._id }, { $set: { homeLocation: { lat: 17.458705, lng: 78.350621 } } });
    const a = await assign(s.coord.client, s.bookingId, s.drv);
    const rideUrl = `/api/driver/rides/${a.body.assignment._id}`;

    // home → office (IN): pick up at the home, drop at the office; office → home (OUT) the other way round
    const { CabRequest } = await import('../src/models/booking.js');
    const toOffice = (await CabRequest.findById(s.bookingId).lean())!.direction === 'IN';
    const office = { lat: 17.4617596, lng: 78.3511398 };
    const home = { lat: 17.458705, lng: 78.350621 };
    const ride = (await s.drv.client.get(rideUrl).expect(200)).body;
    expect(ride.pickupPoint).toEqual(toOffice ? home : office);
    expect(ride.dropPoint).toEqual(toOffice ? office : home);
    expect(ride.employee).toEqual({ name: expect.any(String) }); // nothing else about the employee

    // once the ride is over the driver no longer gets the home's spot
    await toArrived(s.drv.client, a.body.assignment._id);
    await s.drv.client.post(`${rideUrl}/start`, { pin: await employeePin(s.emp.client!, s.bookingId) }).expect(200);
    await s.drv.client.post(`${rideUrl}/complete`).expect(200);
    const done = (await s.drv.client.get(rideUrl).expect(200)).body;
    expect(done.pickupPoint).toBeNull();
    expect(done.dropPoint).toBeNull();
  });
});
