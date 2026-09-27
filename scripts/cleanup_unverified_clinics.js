import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

const EXPIRY_HOURS = 48; // Hours after which unverified abandoned accounts are eligible for cleanup

async function main() {
  const isApply = process.argv.includes("--apply");
  const cutoffDate = new Date(Date.now() - EXPIRY_HOURS * 60 * 60 * 1000);

  console.log(`🔍 Scanning for unverified clinics created before ${cutoffDate.toISOString()} (${EXPIRY_HOURS}h ago)...`);
  if (!isApply) {
    console.log("ℹ️  Running in DRY-RUN mode. Use --apply to execute cleanup.\n");
  }

  // Find clinics created before cutoff date where all users remain unverified
  const candidates = await prisma.clinic.findMany({
    where: {
      createdAt: {
        lt: cutoffDate,
      },
      users: {
        every: {
          emailVerified: false,
        },
      },
    },
    include: {
      users: true,
      patients: { select: { id: true } },
    },
  });

  // Filter to truly abandoned accounts (zero patients created)
  const abandonedClinics = candidates.filter(
    (clinic) => clinic.patients.length === 0,
  );

  if (abandonedClinics.length === 0) {
    console.log("✨ No abandoned unverified clinics found. Database is clean.");
    return;
  }

  console.log(`Found ${abandonedClinics.length} abandoned unverified clinic(s):`);
  abandonedClinics.forEach((clinic) => {
    const adminUser = clinic.users.find((u) => u.role === "admin") || clinic.users[0];
    console.log(` • [ID: ${clinic.id}] "${clinic.name}" (${clinic.email})`);
    console.log(`   Admin: ${adminUser?.name || "N/A"} (${adminUser?.email || "N/A"}), Created: ${clinic.createdAt.toISOString()}`);
  });

  if (isApply) {
    console.log("\n🗑️  Executing deletion...");
    const clinicIds = abandonedClinics.map((c) => c.id);

    const result = await prisma.clinic.deleteMany({
      where: {
        id: {
          in: clinicIds,
        },
      },
    });

    console.log(`✅ Successfully deleted ${result.count} abandoned clinic(s) and their associated records.`);
  } else {
    console.log("\n💡 To delete these abandoned accounts, run: node scripts/cleanup_unverified_clinics.js --apply");
  }
}

main()
  .catch((err) => {
    console.error("Cleanup error:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
