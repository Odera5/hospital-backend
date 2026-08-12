import { prisma } from "../src/lib/prisma.js";

const argv = process.argv.slice(2);
const emailArg = argv.find((a) => a.startsWith("--email="));
if (!emailArg) {
  console.error("Usage: node checkUser.mjs --email=you@example.com");
  process.exit(2);
}
const email = emailArg.split("=")[1].toLowerCase().trim();

(async () => {
  try {
    await prisma.$connect();
    const user = await prisma.user.findUnique({
      where: { email },
      include: { clinic: true },
    });
    if (!user) {
      console.log(JSON.stringify({ exists: false }));
      await prisma.$disconnect();
      process.exit(0);
    }

    const result = {
      exists: true,
      id: user.id,
      email: user.email,
      isActive: user.isActive,
      emailVerified: user.emailVerified,
      hasPassword: Boolean(user.password),
      clinic: user.clinic
        ? {
            id: user.clinic.id,
            email: user.clinic.email,
            isActive: user.clinic.isActive,
            plan: user.clinic.plan,
            subscriptionEnds: user.clinic.subscriptionEnds || null,
          }
        : null,
    };

    console.log(JSON.stringify(result, null, 2));
    await prisma.$disconnect();
    process.exit(0);
  } catch (err) {
    console.error("Error querying user:", err.message || err);
    try {
      await prisma.$disconnect();
    } catch (_) {}
    process.exit(1);
  }
})();
