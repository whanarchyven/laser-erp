import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";

const client = new ConvexHttpClient("http://127.0.0.1:3210");
const [command, arg] = process.argv.slice(2);

if (command === "enqueue") {
  console.log(await client.mutation(anyApi.presets.enqueue, { presetId: arg }));
}
for (const job of await client.query(anyApi.jobs.list, {})) {
  console.log(`${job.number} ${job._id} ${job.status} листы ${job.sheetsDone}/${job.sheetsTotal} готово ${job.readyCount}/${job.readyCount + job.pendingCount} ${job.fileName}`);
}
for (const preset of await client.query(anyApi.presets.list, {})) {
  console.log(`preset ${preset._id} ${preset.title} листов ${preset.sheetCount} ready=${preset.ready}`);
}
