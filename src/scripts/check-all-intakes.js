import { prisma } from "../lib/prisma.js";

async function main() {
  const allIntakes = await prisma.pendingIntake.findMany();
  console.log("All intakes in DB:", JSON.stringify(allIntakes.map(i => ({ id: i.id, clinicId: i.clinicId, branchId: i.branchId, name: i.name, status: i.status })), null, 2));
}

main().catch(console.error);
