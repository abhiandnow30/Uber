import mongoose, { Schema, type InferSchemaType } from 'mongoose';

export const EMPLOYEE_EDITABLE_FIELDS = [
  'fullName',
  'phone',
  'officeLocation',
  'route',
  'homeAddress',
] as const;
export type EmployeeEditableField = (typeof EMPLOYEE_EDITABLE_FIELDS)[number];

const employeeSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    employeeId: { type: String, required: true, trim: true, uppercase: true, unique: true },
    fullName: { type: String, required: true, trim: true },
    email: { type: String, required: true, trim: true, lowercase: true, unique: true },
    phone: { type: String, trim: true },
    officeLocation: { type: String, trim: true, index: true },
    // Cab route / pickup zone the employee is grouped under, e.g. "LB Nagar Cab".
    route: { type: String, trim: true, maxlength: 120, index: true },
    // Default pickup / drop point. Personal data: only the employee and admins can
    // read it; coordinators and drivers only see the pickup/drop text of a booking.
    homeAddress: { type: String, trim: true, maxlength: 300 },
    homeAddressUpdatedAt: { type: Date },
    source: { type: String, enum: ['MANUAL', 'IMPORT', 'ACCESS_REQUEST', 'SSO', 'SEED'], default: 'MANUAL' },
    // Set when an admin deletes an employee who has ride history: the record stays only so past
    // rides and reports keep their name; personal details are erased and access is removed.
    deletedAt: { type: Date, index: true },
    deletedReason: { type: String },
    deletedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

export type EmployeeAttrs = InferSchemaType<typeof employeeSchema>;
export const Employee = mongoose.model('Employee', employeeSchema);
