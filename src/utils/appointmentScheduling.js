const WORKING_HOURS = [
  "09:00",
  "09:30",
  "10:00",
  "10:30",
  "11:00",
  "11:30",
  "12:00",
  "12:30",
  "13:00",
  "13:30",
  "14:00",
  "14:30",
  "15:00",
  "15:30",
  "16:00",
  "16:30",
];

export const SLOT_MINUTES = 30;

export const parseTimeSlotToMinutes = (value) => {
  if (typeof value !== "string" || !value.includes(":")) return null;

  const [hours, minutes] = value.split(":").map(Number);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;

  return hours * 60 + minutes;
};

const rangesOverlap = (startA, endA, startB, endB) =>
  startA < endB && startB < endA;

export const getAppointmentRange = (timeSlot, duration = SLOT_MINUTES) => {
  const start = parseTimeSlotToMinutes(timeSlot);
  if (start === null) return null;

  const safeDuration = Math.max(SLOT_MINUTES, Number(duration) || SLOT_MINUTES);
  return {
    start,
    end: start + safeDuration,
  };
};

export const getAppointmentStartDateTime = (appointmentDate, timeSlot) => {
  const date = new Date(appointmentDate);
  if (Number.isNaN(date.getTime())) return null;

  const [hours, minutes] = String(timeSlot || "")
    .split(":")
    .map((value) => Number(value));
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;

  date.setHours(hours, minutes, 0, 0);
  return date;
};

export const isSlotAvailableForDuration = (
  slot,
  duration,
  appointments,
  excludedId = null,
) => {
  const candidateRange = getAppointmentRange(slot, duration);
  if (!candidateRange) return false;

  const workingDayStart = parseTimeSlotToMinutes(WORKING_HOURS[0]);
  const workingDayEnd =
    parseTimeSlotToMinutes(WORKING_HOURS[WORKING_HOURS.length - 1]) +
    SLOT_MINUTES;

  if (
    candidateRange.start < workingDayStart ||
    candidateRange.end > workingDayEnd
  ) {
    return false;
  }

  return !appointments.some((appointment) => {
    if (excludedId && appointment.id === excludedId) return false;
    if (appointment.status === "cancelled") return false;

    const existingRange = getAppointmentRange(
      appointment.timeSlot,
      appointment.duration,
    );

    if (!existingRange) return false;

    return rangesOverlap(
      candidateRange.start,
      candidateRange.end,
      existingRange.start,
      existingRange.end,
    );
  });
};

export const listAvailableSlots = (appointments, duration, excludedId = null) =>
  WORKING_HOURS.filter((slot) =>
    isSlotAvailableForDuration(slot, duration, appointments, excludedId),
  );
