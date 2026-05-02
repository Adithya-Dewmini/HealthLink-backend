import cron from "node-cron";
import { generateSessionsFromRoutine } from "../services/doctorRoutine.service";

export const startRoutineSessionGenerationJob = () => {
  const runGeneration = async () => {
    try {
      const result = await generateSessionsFromRoutine({ daysAhead: 30 });
      console.log(`[routine-session-job] generated ${result.createdCount} sessions`);
    } catch (error) {
      console.error("[routine-session-job] generation failed:", error);
    }
  };

  void runGeneration();

  cron.schedule("0 1 * * *", () => {
    void runGeneration();
  });
};
