import { config } from '../../config.js';

export const EMAIL_TEMPLATES = [
  'ACCOUNT_INVITATION',
  'PASSWORD_RESET',
  'ACCESS_REQUEST_INFO_REQUESTED',
  'ACCESS_REQUEST_REJECTED',
  'BOOKING_SUBMITTED',
  'BOOKING_APPROVED',
  'BOOKING_REJECTED',
  'CAB_ASSIGNED',
  'ASSIGNMENT_CHANGED',
  'RIDE_CANCELLED',
  'DRIVER_ARRIVED',
  'TRIP_STARTED',
  'TRIP_COMPLETED',
  'TRIP_DELAYED',
  'DAILY_BOOKING_REMINDER',
] as const;
export type EmailTemplate = (typeof EMAIL_TEMPLATES)[number];

type Params = Record<string, unknown>;
export type RenderedEmail = { subject: string; html: string; text: string };

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const portalUrl = () => config.APP_BASE_URL;

function layout(greetingName: unknown, paragraphs: string[], details?: Array<[string, unknown]>, cta?: [string, string]) {
  const detailHtml = details?.length
    ? `<p style="margin:16px 0 4px"><strong>Booking Details</strong></p><ul style="padding-left:18px;margin:0">${details
        .map(([k, v]) => `<li>${escapeHtml(k)}: ${escapeHtml(v)}</li>`)
        .join('')}</ul>`
    : '';
  const ctaHtml = cta
    ? `<p style="margin:20px 0"><a href="${escapeHtml(cta[1])}" style="background:#111827;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">${escapeHtml(cta[0])}</a></p>`
    : '';
  const html = `<!doctype html><html><body style="font-family:Segoe UI,Arial,sans-serif;color:#111827;line-height:1.5;max-width:600px">
<p>Hello ${escapeHtml(greetingName)},</p>
${paragraphs.map((p) => `<p>${p}</p>`).join('\n')}
${detailHtml}
${ctaHtml}
<p>Regards,<br/>Transport Coordination Team</p>
</body></html>`;
  const strip = (s: string) => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  const text = [
    `Hello ${String(greetingName ?? '')},`,
    '',
    ...paragraphs.map(strip),
    ...(details?.length ? ['', 'Booking Details', ...details.map(([k, v]) => `- ${k}: ${String(v ?? '')}`)] : []),
    ...(cta ? ['', `${cta[0]}: ${cta[1]}`] : []),
    '',
    'Regards,',
    'Transport Coordination Team',
  ].join('\n');
  return { html, text };
}

function bookingDetails(p: Params): Array<[string, unknown]> {
  return [
    ['Booking Reference', p.reference],
    ['Travel Date', p.travelDate],
    ['Pickup Time', p.pickupTime],
    ['Pickup Location', p.pickupLocation],
    ['Destination', p.destination],
  ];
}

export function renderEmail(template: EmailTemplate, p: Params, secret: Record<string, string> = {}): RenderedEmail {
  const name = p.name;
  switch (template) {
    case 'ACCOUNT_INVITATION': {
      const { html, text } = layout(
        name,
        [
          'You have been invited to the Employee Cab Booking Portal.',
          `Use the button below to activate your account. This single-use link expires on ${escapeHtml(p.expiresAt)}.`,
          'If you did not expect this invitation, you can ignore this email.',
        ],
        undefined,
        ['Activate your account', secret.activationUrl ?? portalUrl()],
      );
      return { subject: 'Activate your Employee Cab Booking account', html, text };
    }
    case 'PASSWORD_RESET': {
      const { html, text } = layout(
        name,
        [
          'We received a request to reset your Employee Cab Booking Portal password.',
          `This single-use link expires in ${escapeHtml(p.expiresInMinutes)} minutes. If you did not request this, ignore this email; your password will not change.`,
        ],
        undefined,
        ['Reset password', secret.resetUrl ?? portalUrl()],
      );
      return { subject: 'Reset your Employee Cab Booking password', html, text };
    }
    case 'ACCESS_REQUEST_INFO_REQUESTED': {
      const { html, text } = layout(name, [
        'Your request for access to the Employee Cab Booking Portal needs more information before it can be reviewed.',
        `Administrator note: ${escapeHtml(p.note)}`,
        'Please reply to your administrator or submit an updated access request.',
      ]);
      return { subject: 'More information needed for your cab booking access request', html, text };
    }
    case 'ACCESS_REQUEST_REJECTED': {
      const { html, text } = layout(name, [
        'Your request for access to the Employee Cab Booking Portal was not approved.',
        p.note ? `Reason: ${escapeHtml(p.note)}` : 'Please contact your administrator for details.',
      ]);
      return { subject: 'Your cab booking access request', html, text };
    }
    case 'BOOKING_SUBMITTED': {
      const { html, text } = layout(
        name,
        [
          p.approvalRequired
            ? 'Your cab request has been submitted and is awaiting approval.'
            : 'Your cab request has been received. You will be notified when a cab is assigned.',
        ],
        bookingDetails(p),
      );
      return { subject: `Cab Request Received — ${p.travelDate}`, html, text };
    }
    case 'BOOKING_APPROVED': {
      const { html, text } = layout(name, ['Your cab request has been approved. A cab will be assigned shortly.'], bookingDetails(p));
      return { subject: `Cab Request Approved — ${p.travelDate}`, html, text };
    }
    case 'BOOKING_REJECTED': {
      const { html, text } = layout(
        name,
        ['Your cab request could not be approved.', p.reason ? `Reason: ${escapeHtml(p.reason)}` : ''],
        bookingDetails(p),
      );
      return { subject: `Cab Request Not Approved — ${p.travelDate}`, html, text };
    }
    case 'CAB_ASSIGNED': {
      const { html, text } = layout(
        name,
        ['Your cab has been assigned for your upcoming trip.'],
        [
          ...bookingDetails(p),
          ['Vehicle Number', p.vehicleNumber],
          ['Driver Name', p.driverName],
          ['Driver Contact', p.driverPhone],
        ],
      );
      const footer = [
        'Please be ready at the pickup location at the scheduled time.',
        'You can log in to the Employee Cab Booking Portal to view the latest trip status.',
      ];
      return {
        subject: `Your Cab Has Been Assigned — ${p.travelDate}`,
        html: html.replace('<p>Regards,', `${footer.map((f) => `<p>${f}</p>`).join('\n')}\n<p>Regards,`),
        text: text.replace('\nRegards,', `\n${footer.join('\n\n')}\n\nRegards,`),
      };
    }
    case 'ASSIGNMENT_CHANGED': {
      const { html, text } = layout(
        name,
        [
          'The driver or vehicle for your trip has changed. Your previous ride-start PIN is no longer valid; view the new PIN in the portal.',
        ],
        [
          ...bookingDetails(p),
          ['Vehicle Number', p.vehicleNumber],
          ['Driver Name', p.driverName],
          ['Driver Contact', p.driverPhone],
        ],
      );
      return { subject: `Your Cab Assignment Has Changed — ${p.travelDate}`, html, text };
    }
    case 'RIDE_CANCELLED': {
      const { html, text } = layout(
        name,
        ['Your cab booking has been cancelled.', p.reason ? `Reason: ${escapeHtml(p.reason)}` : ''],
        bookingDetails(p),
      );
      return { subject: `Cab Booking Cancelled — ${p.travelDate}`, html, text };
    }
    case 'DRIVER_ARRIVED': {
      const { html, text } = layout(
        name,
        [
          `Your driver ${escapeHtml(p.driverName)} (${escapeHtml(p.vehicleNumber)}) has arrived at the pickup location.`,
          'Share your ride-start PIN with the driver only when you are in the vehicle. The PIN is available in the portal.',
        ],
        bookingDetails(p),
      );
      return { subject: `Your Cab Has Arrived — ${p.reference}`, html, text };
    }
    case 'TRIP_STARTED': {
      const { html, text } = layout(name, ['Your trip has started. Have a safe journey.'], bookingDetails(p));
      return { subject: `Trip Started — ${p.reference}`, html, text };
    }
    case 'TRIP_COMPLETED': {
      const { html, text } = layout(name, [`Your trip was completed at ${escapeHtml(p.completedAt)}.`], bookingDetails(p));
      return { subject: `Trip Completed — ${p.reference}`, html, text };
    }
    case 'TRIP_DELAYED': {
      const { html, text } = layout(
        name,
        ['Your cab is running late. The transport team has been alerted and is following up.', p.reason ? escapeHtml(p.reason) : ''],
        bookingDetails(p),
      );
      return { subject: `Cab Delay Notice — ${p.reference}`, html, text };
    }
    case 'DAILY_BOOKING_REMINDER': {
      const { html, text } = layout(
        name,
        [
          `Do you need a cab for your shift on ${escapeHtml(p.shiftDate)}? Cabs are arranged only for employees who request them, so please request one for every day you need it.`,
          ...(p.cutoffTime ? [`Requests for ${escapeHtml(p.shiftDate)} close at ${escapeHtml(p.cutoffTime)} today.`] : []),
          'If you do not need a cab, you can ignore this email.',
        ],
        undefined,
        ['Request a cab', `${portalUrl()}/employee/request`],
      );
      return { subject: `Need a cab for ${p.shiftDate}? Request it today`, html, text };
    }
  }
}
