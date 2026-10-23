const normalizeText = (value) =>
  typeof value === "string" ? value.trim() : "";

const isNegativeHistoryStatement = (value) =>
  /^(?:no known|none\b|nka\b|nil\b)/i.test(value);

const splitHistoryValues = (value, category) =>
  normalizeText(value)
    .split(/[;,\n]+/)
    .map((entry) => entry.trim())
    .map((entry) =>
      category === "allergy"
        ? entry.replace(/^allergic\s+to\s+/i, "")
        : entry,
    )
    .filter((entry) => entry && !isNegativeHistoryStatement(entry));

export const syncClinicalHistoryFromRecord = async (
  transaction,
  { patientId, allergies, comorbidities },
) => {
  const candidates = [
    ...splitHistoryValues(allergies, "allergy").map((value) => ({
      category: "allergy",
      value,
    })),
    ...splitHistoryValues(comorbidities, "comorbidity").map((value) => ({
      category: "comorbidity",
      value,
    })),
  ];
  const createdEntries = [];

  for (const entry of candidates) {
    const existing = await transaction.patientClinicalHistory.findFirst({
      where: {
        patientId,
        category: entry.category,
        value: { equals: entry.value, mode: "insensitive" },
      },
      select: { id: true },
    });
    if (existing) continue;

    createdEntries.push(
      await transaction.patientClinicalHistory.create({
        data: {
          ...entry,
          patientId,
        },
        select: { id: true, category: true },
      }),
    );
  }
  return createdEntries;
};
