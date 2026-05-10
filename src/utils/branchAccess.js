import { prisma } from "../lib/prisma.js";

export const STAFF_BRANCH_ACCESS_MESSAGE =
  "No branch has been assigned to this staff account. Contact an admin to assign a branch.";

export const serializeBranch = (branch) =>
  branch
    ? {
        id: branch.id,
        clinicId: branch.clinicId,
        name: branch.name,
        slug: branch.slug,
        country: branch.country || "",
        city: branch.city || "",
        area: branch.area || "",
        address: branch.address || "",
        phone: branch.phone || "",
        isPrimary: Boolean(branch.isPrimary),
        isActive: Boolean(branch.isActive),
        intakeEnabled: Boolean(branch.intakeEnabled),
      }
    : null;

export const normalizeAssignedBranchIds = (branchIds) =>
  Array.from(
    new Set(
      (Array.isArray(branchIds) ? branchIds : [])
        .map((branchId) => String(branchId || "").trim())
        .filter(Boolean),
    ),
  );

export const getAllActiveClinicBranches = async (clinicId) =>
  prisma.branch.findMany({
    where: {
      clinicId,
      isActive: true,
    },
    orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
  });

export const getAllowedActiveBranches = async ({
  clinicId,
  role,
  assignedBranchIds = [],
}) => {
  const branches = await getAllActiveClinicBranches(clinicId);

  if (role === "admin") {
    return branches;
  }

  const normalizedAssignedBranchIds = normalizeAssignedBranchIds(
    assignedBranchIds,
  );

  return branches.filter((branch) => normalizedAssignedBranchIds.includes(branch.id));
};

export const resolveActiveBranch = (branches, requestedBranchId = "") => {
  const normalizedRequestedBranchId = String(requestedBranchId || "").trim();

  const activeBranch =
    (normalizedRequestedBranchId
      ? branches.find((branch) => branch.id === normalizedRequestedBranchId)
      : null) || branches[0] || null;

  return {
    activeBranch,
    requestedBranchId: normalizedRequestedBranchId,
  };
};
