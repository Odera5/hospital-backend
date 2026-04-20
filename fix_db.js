import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
  const result = await prisma.clinic.updateMany({
    where: { paystackSubscriptionStatus: 'success' },
    data: { paystackSubscriptionStatus: 'active' }
  });
  console.log('Updated', result);
}
main().catch(console.error).finally(() => prisma.$disconnect());
