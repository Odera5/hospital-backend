import { PrismaClient } from '@prisma/client';

const databaseUrl = "postgresql://postgres:bYaaavWbbQDsildilECrcmhiZQChEzCb@viaduct.proxy.rlwy.net:42344/railway";
const prisma = new PrismaClient({
  datasources: {
    db: {
      url: databaseUrl
    }
  }
});

async function main() {
  const clinics = await prisma.clinic.findMany();
  console.log("Clinics in Railway DB:", JSON.stringify(clinics, null, 2));
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
