import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const email = process.argv[2]?.trim().toLowerCase();
  if (!email) {
    console.error("Please provide the clinic email.");
    process.exit(1);
  }

  const clinic = await prisma.clinic.findUnique({
    where: { email },
  });

  if (!clinic) {
    console.error(`No clinic found with email: ${email}`);
    process.exit(1);
  }

  console.log(JSON.stringify(clinic, null, 2));
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
