Promise.all([
  import("./paystack.spec.mjs"),
  import("./upgrade-reconcile.spec.mjs"),
]).catch((err) => {
  console.error("Paystack tests failed:", err);
  process.exitCode = 1;
});
