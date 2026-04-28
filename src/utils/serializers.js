import { toDecryptedPatient } from "./patientCrypto.js";

export const serializeRecord = (record) => ({
  id: record.id || record._id,
  _id: record.id || record._id,
  ...record,
  attachments: Array.isArray(record.attachments) ? record.attachments : [],
  teeth: Array.isArray(record.teeth) ? record.teeth : [],
  consentObtained: Boolean(record.consentObtained),
  consentDate: record.consentDate || null,
  consentTakenBy: record.consentTakenBy || "",
  consentNotes: record.consentNotes || "",
  isDeleted: Boolean(record.isDeleted),
});

export const serializeInvoice = (invoice) => ({
  id: invoice.id || invoice._id,
  _id: invoice.id || invoice._id,
  ...invoice,
  items: Array.isArray(invoice.items) ? invoice.items : [],
  payments: Array.isArray(invoice.payments) ? invoice.payments : [],
  patientId:
    invoice.patientId && typeof invoice.patientId === "object"
      ? toDecryptedPatient(invoice.patientId)
      : invoice.patientId,
});

export const serializeAppointment = (appointment) => {
  const { patientResponseToken, ...safeAppointment } = appointment || {};

  return {
  id: safeAppointment.id || safeAppointment._id,
  _id: safeAppointment.id || safeAppointment._id,
  ...safeAppointment,
  patientId:
    safeAppointment.patientId && typeof safeAppointment.patientId === "object"
      ? toDecryptedPatient(safeAppointment.patientId)
      : safeAppointment.patientId,
  dentistId: safeAppointment.dentistId || null,
};
};

export const serializeWaitingEntry = (entry) => ({
  id: entry.id || entry._id,
  _id: entry.id || entry._id,
  ...entry,
  patientId:
    entry.patientId && typeof entry.patientId === "object"
      ? toDecryptedPatient(entry.patientId)
      : entry.patientId,
});
