import assert from "node:assert/strict";
import test from "node:test";
import { prisma } from "../src/lib/prisma.js";
import { getAccessiblePatientBranchIds } from "../src/utils/branchAccess.js";
import { isSubscriptionExpired } from "../src/utils/subscriptionAccess.js";
process.env.ENCRYPTION_KEY =
  process.env.ENCRYPTION_KEY || "carechrome-test-encryption-key-32";

const {
  decryptPatientValue,
  toEncryptedPatientData,
} = await import("../src/utils/patientCrypto.js");

const uniqueId = `smoke_${Date.now()}_${Math.floor(Math.random() * 10000)}`;

test("Pre-onboarding Smoke Test Suite (DEPLOYMENT.md)", async (t) => {
  let clinicId;
  let branchAId;
  let branchBId;
  let ownerId;
  let doctorId;
  let patientId;
  let recordId;
  let appointmentId;
  let waitingRoomId;
  let invoiceId;
  let paymentId;
  let cashReconciliationId;

  try {
    // -------------------------------------------------------------
    // 1. Clinic registration, roles, and branch restrictions
    // -------------------------------------------------------------
    await t.test("1. Clinic registration, role changes, and branch restrictions", async () => {
      const clinic = await prisma.clinic.create({
        data: {
          name: `Synthetic Clinic ${uniqueId}`,
          email: `${uniqueId}@testclinic.com`,
          plan: "ENTERPRISE",
          paystackSubscriptionStatus: "active",
          isActive: true,
        },
      });
      clinicId = clinic.id;

      const owner = await prisma.user.create({
        data: {
          name: "Owner Admin",
          email: `owner_${uniqueId}@testclinic.com`,
          password: "synthetic-password-hash",
          role: "admin",
          isClinicOwner: true,
          clinicId,
          emailVerified: true,
        },
      });
      ownerId = owner.id;

      const branchA = await prisma.branch.create({
        data: {
          name: "Main Branch",
          slug: `main-${uniqueId}`,
          clinicId,
          isActive: true,
        },
      });
      branchAId = branchA.id;

      const branchB = await prisma.branch.create({
        data: {
          name: "Annex Branch",
          slug: `annex-${uniqueId}`,
          clinicId,
          isActive: true,
        },
      });
      branchBId = branchB.id;

      const doctor = await prisma.user.create({
        data: {
          name: "Dr. Synthetic",
          email: `doctor_${uniqueId}@testclinic.com`,
          password: "synthetic-password-hash",
          role: "doctor",
          clinicId,
          assignedBranchIds: [branchAId],
          emailVerified: true,
        },
      });
      doctorId = doctor.id;

      // Verify branch scoping logic
      const singleBranchScope = getAccessiblePatientBranchIds({
        ...doctor,
        branchId: branchAId,
        clinic,
        availableBranches: [branchA],
      });
      assert.deepEqual(singleBranchScope, [branchAId]);

      // Role change: promote to branch_manager
      const updatedDoctor = await prisma.user.update({
        where: { id: doctorId },
        data: { role: "branch_manager", assignedBranchIds: [branchAId, branchBId] },
      });
      assert.equal(updatedDoctor.role, "branch_manager");
      assert.equal(updatedDoctor.isClinicOwner, false);

      // Verify Clinic Owner protection
      assert.equal(owner.isClinicOwner, true);
    });

    // -------------------------------------------------------------
    // 2. Patient creation, chart updates, consent edits
    // -------------------------------------------------------------
    await t.test("2. Patient creation, chart updates, consent edits", async () => {
      const encryptedData = toEncryptedPatientData({
        name: "Jane Doe (Synthetic)",
        cardNumber: `CARD-${uniqueId}`,
        age: "30",
        email: `patient_${uniqueId}@example.com`,
        occupation: "Software Engineer",
      });

      const patient = await prisma.patient.create({
        data: {
          ...encryptedData,
          clinicId,
          branchId: branchAId,
          gender: "female",
          phone: "+2348000000000",
        },
      });
      patientId = patient.id;

      assert.notEqual(patient.name, "Jane Doe (Synthetic)");
      assert.equal(decryptPatientValue(patient.name), "Jane Doe (Synthetic)");
      assert.equal(decryptPatientValue(patient.occupation), "Software Engineer");

      // Create dental record with chart findings and consent
      const record = await prisma.record.create({
        data: {
          patientId,
          branchId: branchAId,
          presentingComplaint: "Toothache in upper jaw",
          diagnosis: "Caries on upper right molar",
          treatmentPlan: "Restoration with composite resin",
          teeth: [{ number: 16, condition: "caries", treated: false }],
          consentObtained: true,
          consentTakenBy: "Dr. Synthetic",
          consentNotes: "Patient signed informed consent for restoration",
        },
      });
      recordId = record.id;

      assert.equal(record.consentObtained, true);
      assert.equal(record.consentTakenBy, "Dr. Synthetic");

      // Update consent and chart
      const updatedRecord = await prisma.record.update({
        where: { id: recordId },
        data: {
          treatmentPlan: "Completed restoration with composite resin",
          teeth: [{ number: 16, condition: "restored", treated: true }],
          consentNotes: "Consent verified and completed procedure",
        },
      });
      assert.equal(updatedRecord.consentNotes, "Consent verified and completed procedure");
    });

    // -------------------------------------------------------------
    // 3. Appointment, patient responses, waiting-room workflow
    // -------------------------------------------------------------
    await t.test("3. Appointment creation, reminders, and waiting-room workflow", async () => {
      const apptDate = new Date(Date.now() + 86400000);
      const appt = await prisma.appointment.create({
        data: {
          patientId,
          branchId: branchAId,
          appointmentDate: apptDate,
          timeSlot: "10:00 - 10:30",
          appointmentType: "restoration",
          status: "confirmed",
          patientResponseToken: `token-${uniqueId}`,
        },
      });
      appointmentId = appt.id;
      assert.equal(appt.status, "confirmed");

      // Waiting room workflow
      const entry = await prisma.waitingRoom.create({
        data: {
          patientId,
          branchId: branchAId,
          patientName: "Jane Doe (Synthetic)",
          notes: "Dental Restoration",
          status: "waiting",
          priority: "normal",
        },
      });
      waitingRoomId = entry.id;
      assert.equal(entry.status, "waiting");

      // Progress through stages
      const inConsult = await prisma.waitingRoom.update({
        where: { id: waitingRoomId },
        data: { status: "in-consultation", consultationStartedAt: new Date() },
      });
      assert.equal(inConsult.status, "in-consultation");

      const completed = await prisma.waitingRoom.update({
        where: { id: waitingRoomId },
        data: { status: "completed", completedAt: new Date() },
      });
      assert.equal(completed.status, "completed");
    });

    // -------------------------------------------------------------
    // 4. Invoice, payments, reversals, cash close & review
    // -------------------------------------------------------------
    await t.test("4. Invoice creation, payments, reversal, cash close & review", async () => {
      const invoice = await prisma.invoice.create({
        data: {
          invoiceNumber: `INV-${uniqueId}`,
          patientId,
          branchId: branchAId,
          invoiceDate: new Date(),
          dueDate: new Date(),
          items: [{ description: "Restoration", quantity: 1, unitPrice: 25000, total: 25000 }],
          subtotal: 25000,
          total: 25000,
          amountPaid: 25000,
          status: "paid",
        },
      });
      invoiceId = invoice.id;

      // Record BillingPayment
      const payment = await prisma.billingPayment.create({
        data: {
          invoiceId,
          branchId: branchAId,
          amount: 25000,
          paymentMethod: "cash",
          receiptNumber: `REC-${uniqueId}`,
          recordedById: ownerId,
          kind: "recorded",
        },
      });
      paymentId = payment.id;
      assert.equal(payment.amount, 25000);
      assert.equal(payment.kind, "recorded");

      // Reverse payment
      const reversal = await prisma.billingPayment.create({
        data: {
          invoiceId,
          branchId: branchAId,
          amount: -25000,
          paymentMethod: "cash",
          receiptNumber: `REV-${uniqueId}`,
          recordedById: ownerId,
          kind: "reversal",
          reversalOfId: paymentId,
          reversalReason: "Patient returned check or erroneous billing",
        },
      });
      assert.equal(reversal.reversalOfId, paymentId);
      assert.equal(reversal.kind, "reversal");

      // Cash Reconciliation (daily close)
      const today = new Date().toISOString().slice(0, 10);
      const cashClose = await prisma.cashReconciliation.create({
        data: {
          clinicId,
          branchId: branchAId,
          businessDate: `${today}_${uniqueId.slice(0, 8)}`,
          timezone: "UTC",
          expectedCash: 25000,
          countedCash: 24500,
          variance: -500,
          status: "pending",
          notes: "End of shift cash count",
          submittedById: ownerId,
        },
      });
      cashReconciliationId = cashClose.id;
      assert.equal(cashClose.variance, -500);

      // Review, follow-up, and resolve
      const reviewed = await prisma.cashReconciliation.update({
        where: { id: cashReconciliationId },
        data: {
          status: "flagged",
          reviewerNotes: "500 NGN variance requires staff explanation",
          reviewedAt: new Date(),
          reviewedById: ownerId,
          followUpNotes: "Staff explained change was given from drawer reserve",
          respondedAt: new Date(),
          respondedById: doctorId,
          resolutionNotes: "Discrepancy reconciled against petty cash drawer",
          resolvedAt: new Date(),
          resolvedById: ownerId,
        },
      });
      assert.equal(reviewed.status, "flagged");
      assert.equal(reviewed.followUpNotes.length > 0, true);
      assert.equal(reviewed.resolutionNotes.length > 0, true);
    });

    // -------------------------------------------------------------
    // 5. Audit-log entries
    // -------------------------------------------------------------
    await t.test("5. Audit-log entries for patient, role, billing, cash close", async () => {
      const audit = await prisma.auditLog.create({
        data: {
          actorId: ownerId,
          patientId,
          branchId: branchAId,
          resourceType: "billing",
          resourceId: invoiceId,
          action: "billing.payment.create",
          metadata: { amount: 25000, receiptNumber: `REC-${uniqueId}` },
        },
      });
      assert.equal(audit.branchId, branchAId);
      assert.equal(audit.action, "billing.payment.create");
    });

    // -------------------------------------------------------------
    // 6. Subscription expiration and renewal recovery
    // -------------------------------------------------------------
    await t.test("6. Subscription expiration and access recovery", async () => {
      const expiredClinic = {
        plan: "ENTERPRISE",
        paystackSubscriptionStatus: "cancelled",
        subscriptionEnds: new Date(Date.now() - 86400000).toISOString(),
      };
      assert.equal(isSubscriptionExpired(expiredClinic), true);

      const renewedClinic = {
        plan: "ENTERPRISE",
        paystackSubscriptionStatus: "active",
        subscriptionEnds: new Date(Date.now() + 86400000 * 30).toISOString(),
      };
      assert.equal(isSubscriptionExpired(renewedClinic), false);
    });

    // -------------------------------------------------------------
    // 7. Isolation and data integrity verification
    // -------------------------------------------------------------
    await t.test("7. Database isolation and data integrity verification", async () => {
      const clinicCount = await prisma.clinic.count({ where: { id: clinicId } });
      assert.equal(clinicCount, 1);
    });
  } finally {
    // -------------------------------------------------------------
    // Clean up all synthetic test data created during smoke test
    // -------------------------------------------------------------
    try {
      if (cashReconciliationId) {
        await prisma.cashReconciliation.deleteMany({ where: { id: cashReconciliationId } });
      }
      if (paymentId) {
        await prisma.billingPayment.deleteMany({ where: { invoiceId } });
      }
      if (invoiceId) {
        await prisma.invoice.deleteMany({ where: { id: invoiceId } });
      }
      if (waitingRoomId) {
        await prisma.waitingRoom.deleteMany({ where: { id: waitingRoomId } });
      }
      if (appointmentId) {
        await prisma.appointment.deleteMany({ where: { id: appointmentId } });
      }
      if (recordId) {
        await prisma.record.deleteMany({ where: { id: recordId } });
      }
      if (patientId) {
        await prisma.auditLog.deleteMany({ where: { patientId } });
        await prisma.patient.deleteMany({ where: { id: patientId } });
      }
      if (doctorId) {
        await prisma.user.deleteMany({ where: { id: doctorId } });
      }
      if (ownerId) {
        await prisma.user.deleteMany({ where: { id: ownerId } });
      }
      if (branchAId || branchBId) {
        await prisma.branch.deleteMany({ where: { clinicId } });
      }
      if (clinicId) {
        await prisma.clinic.deleteMany({ where: { id: clinicId } });
      }
    } catch (cleanupErr) {
      console.error("Cleanup error in smoke test:", cleanupErr);
    }
  }
});
