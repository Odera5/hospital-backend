import bcrypt from "bcrypt";
import { prisma } from "../src/lib/prisma.js";

const argv = process.argv.slice(2);
const emailArg = argv.find((a) => a.startsWith("--email="));
const passArg = argv.find((a) => a.startsWith("--password="));

if (!emailArg || !passArg) {
  console.error(
    "Usage: node createAdmin.mjs --email=you@example.com --password=secret",
  );
  process.exit(2);
}

const email = emailArg.split("=")[1].toLowerCase().trim();
const password = passArg.split("=")[1];

(async () => {
  try {
    await prisma.$connect();

    // create a default clinic
    const clinic = await prisma.clinic.create({
      data: {
        name: `Local Clinic - ${email}`,
        email,
        isActive: true,
        plan: "PRO",
      },
    });

    const saltRounds = 10;
    const hashed = await bcrypt.hash(password, saltRounds);

    const user = await prisma.user.create({
      data: {
        name: "Admin",
        email,
        password: hashed,
        role: "admin",
        clinicId: clinic.id,
        isActive: true,
        emailVerified: true,
        assignedBranchIds: [],
      },
    });

    console.log(
      JSON.stringify(
        {
          ok: true,
          user: { id: user.id, email: user.email, role: user.role },
          clinic: { id: clinic.id, email: clinic.email, plan: clinic.plan },
        },
        null,
        2,
      ),
    );

    await prisma.$disconnect();
    process.exit(0);
  } catch (err) {
    console.error("Failed to create admin:", err.message || err);
    try {
      await prisma.$disconnect();
    } catch (_) {}
    process.exit(1);
  }
})();
