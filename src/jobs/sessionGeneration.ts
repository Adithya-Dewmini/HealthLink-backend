import cron from "node-cron";

export const startRoutineSessionGenerationJob = () => {
  cron.schedule("0 1 * * *", () => {
    console.warn("[routine-session-job] skipped because doctorRoutine.service is unavailable");
  });
};
