import express from "express";
import rateLimit from "express-rate-limit";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { toEncryptedPatientData } from "../utils/patientCrypto.js";

const router = express.Router();

const normalizeText = (value) => (typeof value === "string" ? value.trim() : "");
const formatCardNumber = (sequence) => `PAT-${String(sequence).padStart(6, "0")}`;

const isPatientCardSequenceConflict = (error) =>
  error instanceof Prisma.PrismaClientKnownRequestError &&
  error.code === "P2002" &&
  Array.isArray(error.meta?.target) &&
  error.meta.target.includes("clinicId") &&
  error.meta.target.includes("cardNumberSequence");

const intakeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // Limit each IP to 10 intake submissions per window
  message: { message: "Too many intake submissions from this IP. Please try again later." }
});

// GET /api/intake/:clinicId - Fetch public details of a clinic for the Intake Form UI
router.get("/:clinicId", async (req, res) => {
  try {
    const { clinicId } = req.params;
    
    const clinic = await prisma.clinic.findUnique({
      where: { id: clinicId },
      select: {
         name: true,
         logoUrl: true,
         brandColor: true,
         plan: true,
         address: true,
         phone: true
      }
    });

    if (!clinic) {
      return res.status(404).json({ message: "Clinic not found" });
    }

    if (clinic.plan === "FREE") {
      return res.status(403).json({ message: "This clinic's plan does not support online patient intake forms." });
    }

    res.json(clinic);
  } catch (error) {
    console.error("Intake Fetch Error:", error);
    res.status(500).json({ message: "Failed to fetch clinic details" });
  }
});

// POST /api/intake/:clinicId - Submit a new patient
router.post("/:clinicId", intakeLimiter, async (req, res) => {
  try {
    const { clinicId } = req.params;

    const clinic = await prisma.clinic.findUnique({
      where: { id: clinicId }
    });

    if (!clinic) {
      return res.status(404).json({ message: "Clinic not found" });
    }

    if (clinic.plan === "FREE") {
      return res.status(403).json({ message: "This clinic's plan does not support online patient intake forms." });
    }

    const name = normalizeText(req.body?.name);
    const age = normalizeText(req.body?.age);
    const gender = normalizeText(req.body?.gender) || "other";
    const phone = normalizeText(req.body?.phone);
    const address = normalizeText(req.body?.address);
    const email = normalizeText(req.body?.email);

    if (!name || !age) {
      return res.status(400).json({ message: "Name and age are required" });
    }

    let createdPatient = null;

    // Retry logic for sequence generation
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const aggregate = await prisma.patient.aggregate({
          where: { clinicId },
          _max: { cardNumberSequence: true },
        });

        const nextSequence = (aggregate._max.cardNumberSequence || 0) + 1;

        createdPatient = await prisma.patient.create({
          data: {
            clinicId,
            cardNumberSequence: nextSequence,
            ...toEncryptedPatientData({
              name,
              age,
              gender,
              phone,
              address,
              email,
              cardNumber: formatCardNumber(nextSequence),
            }),
          },
        });
        break; // Success
      } catch (error) {
        if (isPatientCardSequenceConflict(error) && attempt < 4) {
          continue;
        }
        throw error;
      }
    }

    if (!createdPatient) {
       throw new Error("Failed to generate a unique patient card number");
    }

    res.status(201).json({ message: "Intake form submitted successfully. You are now registered." });
  } catch (error) {
    console.error("Intake submission error:", error);
    res.status(500).json({ message: "Failed to submit intake form. Please try again." });
  }
});

export default router;
