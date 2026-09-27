import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

async function main() {
  const email = process.argv[2]?.trim().toLowerCase();
  if (!email) {
    console.error(
      "Please provide the clinic email.\nExample: node deactivate_clinic.js clinic@example.com",
    );
    process.exit(1);
  }

  const clinic = await prisma.clinic.findUnique({
    where: { email },
    include: { users: true },
  });

  if (!clinic) {
    console.error(`No clinic found with email: ${email}`);
    process.exit(1);
  }

  if (!clinic.isActive) {
    console.log(`Clinic "${clinic.name}" (${email}) is already deactivated.`);
    return;
  }

  const [updatedClinic, revokedUsers] = await prisma.$transaction([
    prisma.clinic.update({
      where: { email },
      data: { isActive: false },
    }),
    prisma.user.updateMany({
      where: { clinicId: clinic.id },
      data: { refreshToken: null },
    }),
  ]);

  console.log(
    `✅ Successfully deactivated clinic: "${updatedClinic.name}" (${email})`,
  );
  console.log(
    `🔒 Revoked active sessions for ${revokedUsers.count} associated user(s). All access is now blocked.`,
  );
}

main()
  .catch((err) => {
    console.error("Deactivation error:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
