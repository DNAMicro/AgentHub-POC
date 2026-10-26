// In-memory demo store for Part 6 (server side only). FICTIONAL data; restarting the agent
// clears every request and booking. Not a real scheduling or reservation system.
import { randomUUID } from 'node:crypto';
import { BOOKING, ROOMS, TIMEZONE, hhmm, minutes } from './forms.js';

// ---- Tutor: in-person tutoring requests -------------------------------------------------------

export function createTutoringStore() {
  const requests = new Map(); // requestId → record
  return {
    // Allowlisted handler. Called once per operation ID by the form host.
    createTutoringRequest(values) {
      const requestId = `TR-${randomUUID().slice(0, 8).toUpperCase()}`;
      const record = {
        requestId, status: 'Received — awaiting scheduling', receivedAt: new Date().toISOString(), timezone: TIMEZONE, demo: true,
        contact: { firstName: values.firstName, lastName: values.lastName, email: values.email },
        preferences: { preferredDate: values.preferredDate, period: values.period, specificTime: values.specificTime, notes: values.notes },
      };
      requests.set(requestId, record);
      return record;
    },
    count: () => requests.size,
  };
}

// ---- Library: study-room availability and reservations ----------------------------------------

// A few fixed demo bookings so availability isn't uniform (same pattern every day).
const FIXTURE_BUSY = [
  { room: 'room-a', start: '14:00', end: '16:00' },
  { room: 'room-b', start: '10:00', end: '11:00' },
  { room: 'room-c', start: '18:00', end: '19:00' },
];

export function createRoomStore() {
  const taken = new Map(); // `${room}|${date}|${HH:MM}` (one per hour) → bookingId
  const bookings = new Map(); // bookingId → record
  const hourKeys = (room, date, start, duration) => {
    const keys = [];
    for (let m = minutes(start); m < minutes(start) + duration; m += 60) keys.push(`${room}|${date}|${hhmm(m)}`);
    return keys;
  };
  const fixtureBusy = (room, date, start, duration) => FIXTURE_BUSY.some((b) => b.room === room && minutes(start) < minutes(b.end) && minutes(start) + duration > minutes(b.start));
  const free = (room, date, start, duration) => !fixtureBusy(room, date, start, duration) && hourKeys(room, date, start, duration).every((k) => !taken.has(k));

  return {
    // Allowlisted handler: the only source of availability (never the model).
    listStudyRoomAvailability({ date, room, duration }) {
      const slots = [];
      for (let m = minutes(BOOKING.open); m + duration <= minutes(BOOKING.close); m += 60) {
        const start = hhmm(m);
        if (free(room, date, start, duration)) slots.push({ room, date, start, end: hhmm(m + duration), duration });
      }
      return slots;
    },
    isFree: ({ room, date, start, duration }) => free(room, date, start, duration),
    // Allowlisted handler. Check-and-reserve is synchronous (no await between the check and the
    // write), so two concurrent confirmations for an overlapping slot can't both succeed.
    reserveStudyRoom({ room, date, start, duration, groupSize, contact }) {
      if (!free(room, date, start, duration)) return { ok: false, reason: 'taken' };
      const bookingId = `BK-${randomUUID().slice(0, 8).toUpperCase()}`;
      for (const k of hourKeys(room, date, start, duration)) taken.set(k, bookingId);
      const roomInfo = ROOMS.find((r) => r.id === room);
      const record = { bookingId, room, roomName: roomInfo.name, date, start, end: hhmm(minutes(start) + duration), duration, groupSize, timezone: TIMEZONE, contact, bookedAt: new Date().toISOString(), demo: true };
      bookings.set(bookingId, record);
      return { ok: true, booking: record };
    },
    count: () => bookings.size,
  };
}
