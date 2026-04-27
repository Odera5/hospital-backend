import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  try {
    const patientId = 'cmoheqb9e0001gu2mc7rhha2t';
    const isTrash = false;
    const records = await prisma.record.findMany({
      where: { patientId: patientId, isDeleted: isTrash },
      orderBy: { createdAt: "desc" },
    });
    console.log("Records fetched successfully:", records.length);
  } catch (err) {
    console.error("Error fetching records:", err);
  } finally {
    await prisma.$disconnect();
  }
}
main();
