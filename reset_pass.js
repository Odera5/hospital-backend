import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  const email = 'brainycluk@gmail.com';
  const newPassword = 'Admin@123';
  const hashedPassword = await bcrypt.hash(newPassword, 10);
  
  await prisma.user.update({
    where: { email },
    data: { password: hashedPassword }
  });
  
  console.log(`Password reset successfully for ${email} to ${newPassword}`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
