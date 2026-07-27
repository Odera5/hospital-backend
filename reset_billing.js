import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const email = process.argv[2]?.trim().toLowerCase();
  if (!email) {
    console.error("Please provide the clinic email. Example: node reset_billing.js clinic@example.com");
    process.exit(1);
  }

  const clinic = await prisma.clinic.findUnique({
    where: { email },
  });

  if (!clinic) {
    console.error(`No clinic found with email: ${email}`);
    process.exit(1);
  }

  console.log(`Resetting billing details for clinic: "${clinic.name}" (${email})...`);

  const updatedClinic = await prisma.clinic.update({
    where: { email },
    data: {
      paystackCustomerCode: null,
      paystackPlanCode: null,
      paystackSubscriptionCode: null,
      paystackSubscriptionStatus: null,
      paystackSubscriptionEmailToken: null,
      paystackAuthorizationCode: null,
      paystackLastReference: null,
      paystackNextPaymentDate: null,
      subscriptionEnds: null,
    },
  });

  console.log(`Successfully reset billing details for "${updatedClinic.name}".`);
  console.log(`They can now subscribe using the live Paystack integration!`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
