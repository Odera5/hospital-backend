import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const email = process.argv[2]?.trim().toLowerCase();
  if (!email) {
    console.error("Please provide the clinic email. Example: node reactivate_clinic.js clinic@example.com");
    process.exit(1);
  }

  const clinic = await prisma.clinic.findUnique({
    where: { email },
  });

  if (!clinic) {
    console.error(`No clinic found with email: ${email}`);
    process.exit(1);
  }

  if (clinic.isActive) {
    console.log(`Clinic "${clinic.name}" (${email}) is already active.`);
    return;
  }

  const updatedClinic = await prisma.clinic.update({
    where: { email },
    data: { isActive: true },
  });

  console.log(`Successfully reactivated clinic: "${updatedClinic.name}" (${email})`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
