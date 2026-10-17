/**
 * Read-only check: bookings whose office differs from the employee's registered office.
 * Before bookings were tied to the employee's own office, employees could pick any office,
 * so such bookings were handled by that other office's coordinators. Nothing is changed.
 *
 *   npm run check-office-mismatch -w server                          (uses MONGODB_URI)
 *   npm run check-office-mismatch -w server -- --uri "mongodb://127.0.0.1:27027/cab_booking?directConnection=true"
 *   node server/dist/scripts/check-office-mismatch.js                (container)
 *
 * Exits with code 1 if any OPEN booking (not yet completed/cancelled) has a mismatch.
 */
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { connectDatabase, disconnectDatabase } from '../db.js';
import { OPEN_STATUSES } from '../domain.js';
import { CabRequest } from '../models/booking.js';

type Row = { _id: unknown; reference: string; status: string; travelDate: string; pickupTime: string; bookingOffice: string; employeeOffice: string; employeeId: string; fullName: string };

export async function findOfficeMismatches(): Promise<Row[]> {
  return CabRequest.aggregate<Row>([
    { $lookup: { from: 'employees', localField: 'employee', foreignField: '_id', as: 'emp', pipeline: [{ $project: { officeLocation: 1, employeeId: 1, fullName: 1 } }] } },
    { $unwind: '$emp' },
    { $match: { $expr: { $ne: ['$officeLocation', '$emp.officeLocation'] } } },
    { $sort: { scheduledPickupAt: 1 } },
    {
      $project: {
        reference: 1, status: 1, travelDate: 1, pickupTime: 1, bookingOffice: '$officeLocation',
        employeeOffice: '$emp.officeLocation', employeeId: '$emp.employeeId', fullName: '$emp.fullName',
      },
    },
  ]);
}

async function main() {
  const { values } = parseArgs({ options: { uri: { type: 'string' } } });
  await connectDatabase(values.uri);
  try {
    const total = await CabRequest.estimatedDocumentCount();
    const rows = await findOfficeMismatches();
    const open = rows.filter((r) => (OPEN_STATUSES as string[]).includes(r.status));
    console.log(`Checked ${total} booking(s): ${rows.length} with an office different from the employee's office (${open.length} still open).`);
    if (rows.length) {
      console.table(rows.map((r) => ({ open: open.includes(r) ? 'YES' : '', reference: r.reference, status: r.status, date: `${r.travelDate} ${r.pickupTime}`, employee: `${r.fullName} (${r.employeeId})`, bookingOffice: r.bookingOffice, employeeOffice: r.employeeOffice })));
      console.log('Open ones are still handled by the booking office\'s coordinators. Cancel and re-book them, or leave them to finish; closed ones are history only.');
    }
    process.exitCode = open.length ? 1 : 0;
  } finally {
    await disconnectDatabase();
  }
}

// Run only when executed directly (tests import findOfficeMismatches).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(2);
  });
}
