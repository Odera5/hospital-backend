import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { toDecryptedPatient } from "../src/utils/patientCrypto.js";

const prisma = new PrismaClient();
(async () => {
  try {
    const today = new Date();
    const curMonth = String(today.getMonth() + 1).padStart(2, "0");
    const curDay = String(today.getDate()).padStart(2, "0");
    const currentYear = today.getFullYear();

    const patients = await prisma.patient.findMany({
      where: {
        isDeleted: false,
        OR: [
          { lastBirthdayGreetingYear: null },
          { lastBirthdayGreetingYear: { lt: currentYear } },
        ],
      },
    });

    const decryptedPatients = patients.map(p => toDecryptedPatient(p));

    const matches = decryptedPatients.filter((p) => {
      if (!p.dateOfBirth || typeof p.dateOfBirth !== "string") return false;
      const m = p.dateOfBirth.split("-");
      if (m.length !== 3) return false;
      return m[1] === curMonth && m[2] === curDay;
    });

    console.log(
      `Today is ${curMonth}-${curDay} (${currentYear}). Found ${matches.length} matching patient(s):`,
    );
    console.log(JSON.stringify(matches.map(p => ({ id: p.id, name: p.name, email: p.email, dateOfBirth: p.dateOfBirth })), null, 2));
  } catch (e) {
    console.error(e);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
})();

