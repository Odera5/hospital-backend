import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
async function main() {
  try {
    console.log("Checking active locks in database:");
    const locks = await prisma.$queryRaw`
      SELECT 
        l.pid,
        l.locktype,
        l.mode,
        l.granted,
        a.query,
        a.state,
        a.usename
      FROM pg_locks l
      LEFT JOIN pg_stat_activity a ON l.pid = a.pid
      WHERE l.locktype = 'advisory'
    `;
    console.log("Advisory locks:", locks);

    console.log("\nChecking all stat activity:");
    const activity = await prisma.$queryRaw`
      SELECT pid, usename, datname, query, state 
      FROM pg_stat_activity
    `;
    console.table(activity);

  } catch (err) {
    console.error("Error querying activity:", err.message);
  } finally {
    await prisma.$disconnect();
  }
}
main();
