import type { EngineState } from "./engine";
import { office } from "./seed";

/**
 * The state a fresh office starts from: the seeded demo, the demo clock, and
 * an id counter above every id in the seed so generated ids never collide.
 */
export const initialState: EngineState = {
  office,
  now: Date.parse("2026-11-20T09:35:00-05:00"),
  seq: 4000,
  clockStepMinutes: 3,
};
