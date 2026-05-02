export type BookingSlotValidationInput = {
  doctorId: number;
  clinicId: string;
  date: string;
  time: string;
  excludeBookingId?: number;
};

export type BookingActionValidationResult =
  | { ok: true }
  | { ok: false; message: string };
