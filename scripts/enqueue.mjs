import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";

const [title, machineId] = process.argv.slice(2);
if (!title || !machineId) throw new Error("usage: enqueue <presetTitle> <machineId>");
const client = new ConvexHttpClient("http://127.0.0.1:3210");
const presets = await client.query(anyApi.presets.list, {});
const preset = presets.find((p) => p.title === title);
if (!preset) throw new Error(`нет пресета «${title}»`);
console.log(await client.mutation(anyApi.presets.enqueue, { presetId: preset._id, machineId }));
