import { prisma } from "../src/lib/prisma.js";

(async () => {
  try {
    await prisma.$connect();
    const users = await prisma.user.findMany({
      select: {
        email: true,
        isActive: true,
        emailVerified: true,
        password: true,
      },
    });
    const output = users.map((u) => ({
      email: u.email,
      isActive: u.isActive,
      emailVerified: u.emailVerified,
      hasPassword: Boolean(u.password),
    }));
    console.log(JSON.stringify(output, null, 2));
    await prisma.$disconnect();
    process.exit(0);
  } catch (err) {
    console.error("Error listing users:", err.message || err);
    try {
      await prisma.$disconnect();
    } catch (_) {}
    process.exit(1);
  }
})();
