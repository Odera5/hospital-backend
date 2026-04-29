-- CreateTable
CREATE TABLE "PendingIntake" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "age" TEXT NOT NULL,
    "gender" TEXT NOT NULL DEFAULT 'other',
    "phone" TEXT NOT NULL DEFAULT '',
    "email" TEXT NOT NULL DEFAULT '',
    "address" TEXT NOT NULL DEFAULT '',
    "preferredDate" TIMESTAMP(3),
    "preferredTime" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PendingIntake_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PendingIntake_clinicId_status_createdAt_idx" ON "PendingIntake"("clinicId", "status", "createdAt");

-- AddForeignKey
ALTER TABLE "PendingIntake" ADD CONSTRAINT "PendingIntake_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;
