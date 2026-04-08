import dotenv from "dotenv";
import { MongoClient } from "mongodb";
import { prisma } from "../lib/prisma.js";

dotenv.config();

const REQUIRED_ENV_VARS = ["MONGO_URI", "DATABASE_URL", "ENCRYPTION_KEY"];
const missing = REQUIRED_ENV_VARS.filter((key) => !process.env[key]?.trim());

if (missing.length > 0) {
  throw new Error(
    `Missing required environment variables for migration: ${missing.join(", ")}`,
  );
}

const collectionCandidates = {
  users: ["users", "user"],
  patients: ["patients", "patient"],
  records: ["records", "record"],
  appointments: ["appointments", "appointment"],
  waitingRooms: ["waitingrooms", "waitingroom", "waiting_rooms"],
  invoices: ["invoices", "invoice"],
  auditLogs: ["auditlogs", "auditlog", "audit_logs"],
};

const normalizeRole = (role) =>
  ["admin", "doctor", "nurse"].includes(role) ? role : "nurse";
const normalizeIsActive = (value) =>
  typeof value === "boolean" ? value : true;

const normalizeGender = (gender) =>
  ["male", "female", "other"].includes(gender) ? gender : "other";

const normalizeDentition = (dentition) =>
  dentition === "child" ? "child" : "adult";

const normalizeTeeth = (teeth) =>
  Array.isArray(teeth)
    ? teeth
        .map((tooth) => ({
          number: Number(tooth?.number),
          condition:
            typeof tooth?.condition === "string" ? tooth.condition : "present",
        }))
        .filter((tooth) => Number.isFinite(tooth.number))
    : [];

const normalizeAttachments = (attachments) =>
  Array.isArray(attachments)
    ? attachments.map((attachment) => {
        if (typeof attachment === "string") {
          return {
            name: attachment,
            url: attachment,
            mimetype: "",
          };
        }

        return {
          name: attachment?.name || "",
          url: attachment?.url || "",
          mimetype: attachment?.mimetype || "",
        };
      })
    : [];

const normalizeItems = (items) =>
  Array.isArray(items)
    ? items.map((item) => ({
        description: item?.description || "",
        quantity: Number(item?.quantity) || 1,
        unitPrice: Number(item?.unitPrice) || 0,
        totalPrice:
          Number(item?.totalPrice) ||
          (Number(item?.quantity) || 1) * (Number(item?.unitPrice) || 0),
      }))
    : [];

const toDateOrNull = (value) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const getCollection = async (db, candidates) => {
  for (const name of candidates) {
    const exists = await db.listCollections({ name }).hasNext();
    if (exists) return db.collection(name);
  }
  return null;
};

const createInvoiceNumber = (() => {
  let counter = 0;
  return (fallbackDate) => {
    counter += 1;
    const year = fallbackDate ? new Date(fallbackDate).getFullYear() : new Date().getFullYear();
    return `INV-${year}-${String(counter).padStart(4, "0")}`;
  };
})();

const main = async () => {
  const mongoClient = new MongoClient(process.env.MONGO_URI);

  try {
    await prisma.$connect();
    await mongoClient.connect();

    const mongoDb = mongoClient.db();

    const [
      usersCollection,
      patientsCollection,
      recordsCollection,
      appointmentsCollection,
      waitingRoomsCollection,
      invoicesCollection,
      auditLogsCollection,
    ] = await Promise.all([
      getCollection(mongoDb, collectionCandidates.users),
      getCollection(mongoDb, collectionCandidates.patients),
      getCollection(mongoDb, collectionCandidates.records),
      getCollection(mongoDb, collectionCandidates.appointments),
      getCollection(mongoDb, collectionCandidates.waitingRooms),
      getCollection(mongoDb, collectionCandidates.invoices),
      getCollection(mongoDb, collectionCandidates.auditLogs),
    ]);

    const users = usersCollection ? await usersCollection.find({}).toArray() : [];
    const patients = patientsCollection ? await patientsCollection.find({}).toArray() : [];
    const records = recordsCollection ? await recordsCollection.find({}).toArray() : [];
    const appointments = appointmentsCollection
      ? await appointmentsCollection.find({}).toArray()
      : [];
    const waitingRooms = waitingRoomsCollection
      ? await waitingRoomsCollection.find({}).toArray()
      : [];
    const invoices = invoicesCollection ? await invoicesCollection.find({}).toArray() : [];
    const auditLogs = auditLogsCollection ? await auditLogsCollection.find({}).toArray() : [];

    if (
      users.length === 0 &&
      patients.length === 0 &&
      records.length === 0 &&
      appointments.length === 0 &&
      waitingRooms.length === 0 &&
      invoices.length === 0
    ) {
      console.log("No MongoDB data found to migrate.");
      return;
    }

    const userIdMap = new Map();
    const patientIdMap = new Map();

    console.log(`Migrating ${users.length} users...`);
    for (const user of users) {
      const createdUser = await prisma.user.upsert({
        where: { email: String(user.email).toLowerCase() },
        update: {
          name: user.name || "",
          password: user.password || "",
          role: normalizeRole(user.role),
          isActive: normalizeIsActive(user.isActive),
          refreshToken: user.refreshToken || null,
          createdAt: toDateOrNull(user.createdAt) || undefined,
          updatedAt: toDateOrNull(user.updatedAt) || undefined,
        },
        create: {
          name: user.name || "",
          email: String(user.email).toLowerCase(),
          password: user.password || "",
          role: normalizeRole(user.role),
          isActive: normalizeIsActive(user.isActive),
          refreshToken: user.refreshToken || null,
          createdAt: toDateOrNull(user.createdAt) || undefined,
          updatedAt: toDateOrNull(user.updatedAt) || undefined,
        },
      });

      userIdMap.set(String(user._id), createdUser.id);
    }

    console.log(`Migrating ${patients.length} patients...`);
    for (const patient of patients) {
      const createdPatient = await prisma.patient.create({
        data: {
          name: patient.name || "",
          age: String(patient.age ?? ""),
          email: patient.email || "",
          gender: normalizeGender(patient.gender),
          phone: patient.phone || "",
          address: patient.address || "",
          isDeleted: Boolean(patient.isDeleted),
          createdAt: toDateOrNull(patient.createdAt) || undefined,
          updatedAt: toDateOrNull(patient.updatedAt) || undefined,
        },
      });

      patientIdMap.set(String(patient._id), createdPatient.id);
    }

    console.log(`Migrating ${records.length} records...`);
    for (const record of records) {
      const patientId = patientIdMap.get(String(record.patient));
      if (!patientId) continue;

      await prisma.record.create({
        data: {
          patientId,
          presentingComplaint: record.presentingComplaint || "",
          history: record.history || "",
          examination: record.examination || "",
          examinationExtraOral: record.examinationExtraOral || "",
          softTissue: record.softTissue || "",
          periodontalStatus: record.periodontalStatus || "",
          occlusion: record.occlusion || "",
          investigation: record.investigation || "",
          diagnosis: record.diagnosis || "",
          treatmentPlan: record.treatmentPlan || "",
          medication: record.medication || "",
          dentition: normalizeDentition(record.dentition),
          teeth: normalizeTeeth(record.teeth),
          attachments: normalizeAttachments(record.attachments),
          createdAt: toDateOrNull(record.createdAt) || undefined,
          updatedAt: toDateOrNull(record.updatedAt) || undefined,
        },
      });
    }

    console.log(`Migrating ${appointments.length} appointments...`);
    for (const appointment of appointments) {
      const patientId = patientIdMap.get(String(appointment.patientId));
      if (!patientId) continue;

      await prisma.appointment.create({
        data: {
          patientId,
          appointmentDate:
            toDateOrNull(appointment.appointmentDate) || new Date(),
          timeSlot: appointment.timeSlot || "",
          duration: Number(appointment.duration) || 30,
          appointmentType: appointment.appointmentType || "checkup",
          dentistId: appointment.dentistId
            ? userIdMap.get(String(appointment.dentistId)) || null
            : null,
          notes: appointment.notes || "",
          status: appointment.status || "scheduled",
          createdAt: toDateOrNull(appointment.createdAt) || undefined,
          updatedAt: toDateOrNull(appointment.updatedAt) || undefined,
        },
      });
    }

    console.log(`Migrating ${waitingRooms.length} waiting room entries...`);
    for (const waitingRoom of waitingRooms) {
      const patientId = patientIdMap.get(String(waitingRoom.patientId));
      if (!patientId) continue;

      await prisma.waitingRoom.create({
        data: {
          patientId,
          patientName: waitingRoom.patientName || "",
          status: waitingRoom.status || "waiting",
          notes: waitingRoom.notes || "",
          arrivalTime: toDateOrNull(waitingRoom.arrivalTime) || new Date(),
          calledAt: toDateOrNull(waitingRoom.calledAt),
          consultationStartedAt: toDateOrNull(waitingRoom.consultationStartedAt),
          completedAt: toDateOrNull(waitingRoom.completedAt),
          createdAt: toDateOrNull(waitingRoom.createdAt) || undefined,
          updatedAt: toDateOrNull(waitingRoom.updatedAt) || undefined,
        },
      });
    }

    console.log(`Migrating ${invoices.length} invoices...`);
    for (const invoice of invoices) {
      const patientId = patientIdMap.get(String(invoice.patientId));
      if (!patientId) continue;

      await prisma.invoice.create({
        data: {
          invoiceNumber:
            invoice.invoiceNumber ||
            createInvoiceNumber(invoice.invoiceDate || invoice.createdAt),
          patientId,
          treatmentPlanId: invoice.treatmentPlanId
            ? String(invoice.treatmentPlanId)
            : null,
          invoiceDate: toDateOrNull(invoice.invoiceDate) || new Date(),
          dueDate: toDateOrNull(invoice.dueDate),
          items: normalizeItems(invoice.items),
          subtotal: Number(invoice.subtotal) || 0,
          tax: Number(invoice.tax) || 0,
          taxPercentage: Number(invoice.taxPercentage) || 0,
          discount: Number(invoice.discount) || 0,
          total: Number(invoice.total) || 0,
          amountPaid: Number(invoice.amountPaid) || 0,
          balance: Number(invoice.balance) || 0,
          status: invoice.status || "draft",
          paymentMethod: invoice.paymentMethod || "pending",
          notes: invoice.notes || "",
          createdAt: toDateOrNull(invoice.createdAt) || undefined,
          updatedAt: toDateOrNull(invoice.updatedAt) || undefined,
        },
      });
    }

    if (auditLogs.length > 0) {
      console.log(`Migrating ${auditLogs.length} audit logs...`);
      for (const log of auditLogs) {
        await prisma.auditLog.create({
          data: {
            actorId: log.actorId ? userIdMap.get(String(log.actorId)) || null : null,
            actorRole: log.actorRole || "",
            action: log.action || "legacy.migrated",
            resourceType: log.resourceType || "unknown",
            resourceId: log.resourceId ? String(log.resourceId) : "",
            patientId: log.patientId
              ? patientIdMap.get(String(log.patientId)) || null
              : null,
            metadata:
              log.metadata && typeof log.metadata === "object" ? log.metadata : {},
            ipAddress: log.ipAddress || "",
            createdAt: toDateOrNull(log.createdAt) || undefined,
            updatedAt: toDateOrNull(log.updatedAt) || undefined,
          },
        });
      }
    }

    console.log("MongoDB to PostgreSQL migration completed successfully.");
  } finally {
    await mongoClient.close();
    await prisma.$disconnect();
  }
};

main().catch((error) => {
  console.error("Migration failed:", error);
  process.exit(1);
});
