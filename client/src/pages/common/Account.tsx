import { useEffect, useState, type FormEvent } from 'react';
import { Home } from 'lucide-react';
import { Alert, Button, Card, DescriptionList, PageHeader, Select, Textarea, useToast, cn } from '../../components/ui';
import { errorMessage, patch } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fieldErrors } from '../../lib/hooks';
import { fmt12h, usePolicy } from '../../lib/policy';
import { useUnsavedChanges } from '../../lib/unsaved';
import { MapLinkField, sameSpot, type LatLng, type MapSpot } from '../../components/LocationPicker';

/** Phones: no rounded corners or side borders, so a card meets the screen edges. */
const EDGE_TO_EDGE = 'max-sm:rounded-none max-sm:border-x-0';

// Everyone signs in with Microsoft (employees, admins) or a mobile number (coordinators, drivers),
// so there's no password to change here.
export default function Account() {
  const { me } = useAuth();
  if (!me) return null;
  const profile = (me.profile ?? {}) as Record<string, string>;
  const employee = me.user.role === 'EMPLOYEE';

  return (
    <>
      <PageHeader title="Account" />
      {/* Phones: the cards run edge to edge (no side margin), giving the details the full width. */}
      <div className={cn('grid gap-6 max-sm:-mx-4 max-sm:gap-4', employee && 'lg:grid-cols-2')}>
        <Card title="Profile" className={EDGE_TO_EDGE}>
          <DescriptionList
            items={[
              ['Name', me.user.name],
              ...(me.user.email && !me.user.email.endsWith('@phone-login.invalid') ? ([['Email', me.user.email]] as Array<[string, string]>) : []),
              ...(profile.employeeId ? ([['Employee ID', profile.employeeId], ['Office', profile.officeLocation]] as Array<[string, string]>) : []),
              ...(profile.driverCode ? ([['Driver ID', profile.driverCode], ['Office', profile.officeLocation]] as Array<[string, string]>) : []),
            ]}
          />
        </Card>
        {employee && <CabDetailsCard />}
      </div>
    </>
  );
}

/**
 * Employees keep their usual shift and present address together: the shift is pre-selected on
 * the cab request form, and the address is where the transport team plans the cab to.
 */
function CabDetailsCard() {
  const { me, refresh } = useAuth();
  const toast = useToast();
  const { data: policy } = usePolicy();
  const profile = (me?.profile ?? {}) as { defaultShift?: string; homeAddress?: string; homeLocation?: LatLng | null; homeMapLink?: string };
  const savedShift = profile.defaultShift ?? '';
  const savedAddress = profile.homeAddress ?? '';
  const savedSpot: MapSpot = { link: profile.homeMapLink ?? '', pin: profile.homeLocation ? { lat: profile.homeLocation.lat, lng: profile.homeLocation.lng } : null };
  const [shift, setShift] = useState(savedShift);
  const [address, setAddress] = useState(savedAddress);
  const [spot, setSpot] = useState<MapSpot>(savedSpot);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => setShift(savedShift), [savedShift]);
  useEffect(() => setAddress(savedAddress), [savedAddress]);
  // After a save (or a change elsewhere) the form follows the saved location.
  const savedSpotKey = JSON.stringify(savedSpot);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setSpot(savedSpot), [savedSpotKey]);
  const shifts = policy?.shifts.filter((s) => s.active) ?? [];

  const shiftChanged = shift !== savedShift;
  const addressChanged = address.trim() !== savedAddress;
  const pinChanged = !sameSpot(spot, savedSpot);
  const addressOk = address.trim().length >= 5 || (!addressChanged && !savedAddress);

  const save = async (): Promise<boolean> => {
    if (!spot.pin) {
      setErrors({ form: spot.link.trim() ? 'Your Google Maps link is still being read or could not be read. Check the link, then save.' : 'Add your home’s Google Maps link before saving.' });
      return false;
    }
    if (!addressOk) {
      setErrors({ homeAddress: 'Enter your full present address' });
      return false;
    }
    setBusy(true);
    setErrors({});
    try {
      await patch('/me/profile', {
        ...(shiftChanged ? { defaultShift: shift } : {}),
        ...(addressChanged ? { homeAddress: address.trim() } : {}),
        ...(pinChanged ? { homeLocation: spot.pin, homeMapLink: spot.pin ? spot.link.trim() : '' } : {}),
      });
      await refresh();
      toast.success('Cab details saved', 'Your shift is selected and your address is used when you request a cab.');
      return true;
    } catch (err) {
      const f = fieldErrors(err);
      setErrors(Object.keys(f).length ? f : { form: errorMessage(err) });
      return false;
    } finally {
      setBusy(false);
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void save();
  };
  useUnsavedChanges(shiftChanged || addressChanged || pinChanged, save);

  return (
    <Card
      className={EDGE_TO_EDGE}
      title={
        <span className="flex items-center gap-2">
          <Home className="h-4 w-4" aria-hidden /> Cab details
        </span>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        {(!savedShift || !savedAddress) && <Alert tone="info">Save your shift and present address so cab requests take just a tap.</Alert>}
        <Select label="My shift" value={shift} onChange={(e) => setShift(e.target.value)} error={errors.defaultShift}>
          <option value="">No default shift</option>
          {shifts.map((s) => (
            <option key={s.code} value={s.code}>
              {s.name}
              {s.defaultPickupTime ? ` · cab ${fmt12h(s.defaultPickupTime)}` : ''}
            </option>
          ))}
        </Select>
        <Textarea
          label="Present address"
          required
          maxLength={300}
          autoComplete="street-address"
          placeholder="Flat / house no., building, street, area, city, PIN code"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          error={errors.homeAddress}
        />
        <p className="text-xs text-slate-500">
          Used for your rides. You can still pick another shift for a single ride when you request it.
        </p>
        {errors.form && <Alert tone="error">{errors.form}</Alert>}
        <MapLinkField spot={spot} onSpot={setSpot} saved={!pinChanged} required />
        <Button type="submit" className="max-sm:w-full" loading={busy} disabled={(!shiftChanged && !addressChanged && !pinChanged) || !addressOk || !spot.pin}>
          Save
        </Button>
      </form>
    </Card>
  );
}
