export const permanentDeletionDisabled = (_req, res) =>
  res.status(410).json({
    message:
      "Permanent deletion is disabled while the clinic's retention policy is being confirmed. The item remains in Trash.",
  });
