const normalizeText = (value) =>
  typeof value === "string" ? value.trim() : "";

const isNegativeHistoryStatement = (value) =>
  /^(?:no known|none\b|nka\b|nil\b)/i.test(value);

export const syncClinicalHistoryFromRecord = async (
  transaction,
  { patientId, allergies, comorbidities },
) => {
  const candidates = [
    { category: "allergy", value: normalizeText(allergies) },
    { category: "comorbidity", value: normalizeText(comorbidities) },
  ].filter(({ value }) => value && !isNegativeHistoryStatement(value));
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
