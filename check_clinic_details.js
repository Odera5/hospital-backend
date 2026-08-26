import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const user = await prisma.user.findUnique({
    where: { email: 'brainycluk@gmail.com' },
    include: { clinic: true }
  });
  
  if (!user || !user.clinic) {
    console.log("No clinic found for user");
    return;
  }
  
  console.log("Clinic Data:", JSON.stringify(user.clinic, null, 2));
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
