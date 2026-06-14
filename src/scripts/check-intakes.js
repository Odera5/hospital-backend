import { prisma } from "../lib/prisma.js";

async function main() {
  const intakes = await prisma.pendingIntake.findMany();
  console.log("All pending intakes:", JSON.stringify(intakes, null, 2));

  const users = await prisma.user.findMany();
  console.log("All users:", JSON.stringify(users.map(u => ({ id: u.id, email: u.email, role: u.role, branchId: u.branchId, clinicId: u.clinicId })), null, 2));

  const branches = await prisma.branch.findMany();
  console.log("All branches:", JSON.stringify(branches, null, 2));
}

main().catch(console.error);
