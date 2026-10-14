import { randomUUID } from "node:crypto";

const [programId, count = "1", sheet = "", ...lines] = process.argv.slice(2);
const response = await fetch("http://127.0.0.1:3211/agent/events", {
  method: "POST",
  headers: { Authorization: "Bearer laser-stand-dev", "Content-Type": "application/json" },
  body: JSON.stringify({
    events: [
      {
        eventId: randomUUID(),
        programId,
        type: "run_finished",
        at: Date.now(),
        count: Number(count),
        sheet: sheet ? Number(sheet) : undefined,
        detail: lines.length > 0 ? lines.join("\n") : undefined,
      },
    ],
  }),
});
console.log(response.status, await response.text());
