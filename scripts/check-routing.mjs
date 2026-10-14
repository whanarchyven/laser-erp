import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";

const client = new ConvexHttpClient("http://127.0.0.1:3210");
const presets = await client.query(anyApi.presets.list, {});
const jobId = await client.mutation(anyApi.presets.enqueue, { presetId: presets[0]._id, machineId: "test-machine" });

async function programs(machineId) {
  const response = await fetch(`http://127.0.0.1:3211/agent/programs?machineId=${machineId}`, {
    headers: { Authorization: "Bearer laser-stand-dev" },
  });
  const body = await response.json();
  return body.programs.filter((p) => p.status !== "cancelled").map((p) => p.programNumber);
}

console.log("test-machine видит:", await programs("test-machine"));
console.log("laser-stand видит:", await programs("laser-stand"));
await client.mutation(anyApi.jobs.cancel, { jobId });
console.log("тестовая задача отменена");
