import { useAction, useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import type { Id } from "../convex/_generated/dataModel";
import { api } from "../convex/_generated/api";
import { useEffect, useMemo, useState } from "react";

type Route =
  | { name: "queue" }
  | { name: "new" }
  | { name: "catalog" }
  | { name: "machines" }
  | { name: "job"; id: Id<"jobs"> };

type Inspected = FunctionReturnType<typeof api.presets.inspect>;
type Rate = FunctionReturnType<typeof api.stand.machines>[number]["rate"];

function useRoute(): Route {
  const [hash, setHash] = useState(window.location.hash || "#/");
  useEffect(() => {
    const onHash = () => setHash(window.location.hash || "#/");
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const job = /^#\/job\/(.+)$/.exec(hash);
  if (job?.[1]) return { name: "job", id: decodeURIComponent(job[1]) as Id<"jobs"> };
  if (hash.startsWith("#/new")) return { name: "new" };
  if (hash.startsWith("#/catalog")) return { name: "catalog" };
  if (hash.startsWith("#/machines")) return { name: "machines" };
  return { name: "queue" };
}

const statusLabel: Record<string, string> = {
  queued: "в очереди",
  delivered: "файл на станке",
  loaded: "открыт в CypCut",
  in_progress: "режется",
  done: "готово",
  cancelled: "отменено",
  failed: "ошибка",
};

function agentSiteUrl() {
  const host = window.location.hostname;
  return `http://${host}:3211`;
}

function formatTime(ms: number) {
  return new Date(ms).toLocaleString("ru-RU", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" });
}

function formatDuration(sec: number) {
  const total = Math.max(0, Math.round(sec));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h} ч ${String(m).padStart(2, "0")} мин`;
  if (m > 0) return `${m} мин ${String(s).padStart(2, "0")} с`;
  return `${s} с`;
}

function meters(mm: number) {
  return `${(mm / 1000).toFixed(mm < 10000 ? 2 : 1)} м`;
}

function estimate(rate: Rate | undefined, cutLengthMm: number | null | undefined, pierces: number | null | undefined) {
  if (!rate || cutLengthMm == null || pierces == null) return null;
  return Math.round((cutLengthMm / 1000) * rate.secPerMeter + pierces * rate.secPerPierce);
}

type CypCutEstimate = NonNullable<FunctionReturnType<typeof api.stand.machines>[number]["cypcutEstimate"]>;

function cypcutLabel(e: CypCutEstimate) {
  const parts = [`оценка CypCut ≈ ${formatDuration(e.totalSec)}`];
  if (e.cutLengthMm !== undefined) parts.push(`рез ${meters(e.cutLengthMm)}`);
  if (e.moveLengthMm !== undefined) parts.push(`холостые ${meters(e.moveLengthMm)}`);
  if (e.pierces !== undefined) parts.push(`пробивок ${e.pierces}`);
  const split = [
    e.processSec !== undefined ? `резка ${formatDuration(e.processSec)}` : null,
    e.moveSec !== undefined ? `перемещения ${formatDuration(e.moveSec)}` : null,
    e.delaySec !== undefined ? `задержки ${formatDuration(e.delaySec)}` : null,
  ].filter(Boolean);
  return parts.join(" · ") + (split.length > 0 ? ` (${split.join(", ")})` : "");
}

function rateLabel(rate: Rate) {
  return rate.source === "fact"
    ? `по факту (вырезанных листов: ${rate.samples}): ${rate.secPerMeter.toFixed(1)} с/м + ${rate.secPerPierce.toFixed(1)} с на пробивку`
    : "грубо, по умолчанию (7 с/м + 1 с на пробивку); уточнится после первых резов";
}

const MACHINE_STATES: Record<string, string> = {
  Working: "Режет",
  Stop: "Стоит",
  Pause: "Пауза",
  Frame: "Обход рамки",
  "Go Zero": "Едет в ноль",
  "Go ZeroRef": "Едет в ноль",
};

function machineStateLabel(state: string) {
  return MACHINE_STATES[state] ?? state;
}

const MACHINE_EVENTS: Record<string, string> = {
  run_started: "старт",
  run_finished: "лист вырезан",
  run_stopped: "остановлен до конца листа",
  alarm: "авария",
  alarm_cleared: "авария снята",
};

function machineEventLabel(type: string) {
  return MACHINE_EVENTS[type] ?? type;
}

function formatClock(ms: number) {
  return new Date(ms).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function isOnline(at: number) {
  return Date.now() - at < 60_000;
}

async function uploadToStorage(getUrl: () => Promise<string>, file: File) {
  const postUrl = await getUrl();
  const posted = await fetch(postUrl, { method: "POST", headers: { "Content-Type": file.type || "application/octet-stream" }, body: file });
  if (!posted.ok) throw new Error("Не удалось загрузить файл");
  const body = (await posted.json()) as { storageId: Id<"_storage"> };
  return body.storageId;
}

export default function App() {
  const route = useRoute();
  const machines = useQuery(api.stand.machines);
  return (
    <div className="app">
      <header>
        <div>
          <h1>Очередь станка</h1>
          {machines?.length === 0 && <p className="muted">Ни один агент ещё не выходил на связь</p>}
          {machines?.map((machine) => (
            <p key={machine.machineId} className="muted">
              {machine.machineId}: CypCut {machine.cypcutRunning ? "запущен" : "не запущен"}
              {machine.windowTitle ? ` — ${machine.windowTitle}` : ""} · связь {formatTime(machine.at)}
            </p>
          ))}
          <p className="muted">Агент: {agentSiteUrl()} · токен в appsettings.json</p>
        </div>
        <nav>
          <a className={route.name === "queue" ? "active" : ""} href="#/">Очередь</a>
          <a className={route.name === "new" ? "active" : ""} href="#/new">Новая задача</a>
          <a className={route.name === "machines" ? "active" : ""} href="#/machines">Станки</a>
          <a className={route.name === "catalog" ? "active" : ""} href="#/catalog">Номенклатура</a>
        </nav>
      </header>
      {route.name === "queue" && <Queue />}
      {route.name === "new" && <NewJob />}
      {route.name === "machines" && <Machines />}
      {route.name === "catalog" && <Catalog />}
      {route.name === "job" && <JobPage id={route.id} />}
    </div>
  );
}

type JobView = FunctionReturnType<typeof api.jobs.list>[number];
type MachineView = FunctionReturnType<typeof api.stand.machines>[number];

const NO_MACHINE = "";

function Queue() {
  const jobs = useQuery(api.jobs.list);
  const machines = useQuery(api.stand.machines);
  if (jobs === undefined || machines === undefined) return <p className="muted">Загрузка…</p>;
  const ids = [...machines.map((m) => m.machineId)];
  for (const job of jobs) {
    const id = job.machineId ?? NO_MACHINE;
    if (!ids.includes(id)) ids.push(id);
  }
  if (ids.length === 0) return <div className="card"><p>Очередь пустая. Создайте задачу из пресета или нового LXDS.</p></div>;
  return (
    <div className="stack">
      {ids.map((id) => (
        <MachineQueue
          key={id || "none"}
          machineId={id}
          machine={machines.find((m) => m.machineId === id) ?? null}
          jobs={jobs.filter((job) => (job.machineId ?? NO_MACHINE) === id)}
        />
      ))}
    </div>
  );
}

function MachineQueue({ machineId, machine, jobs }: { machineId: string; machine: MachineView | null; jobs: JobView[] }) {
  const open = jobs.filter((job) => job.status !== "done" && job.status !== "cancelled").sort((a, b) => a.createdAt - b.createdAt);
  const closed = jobs.filter((job) => job.status === "done" || job.status === "cancelled");
  const online = machine !== null && isOnline(machine.at);
  return (
    <section className="card stack queue">
      <div className="row">
        <div>
          <h2>{machineId || "Без станка"}</h2>
          <p className="muted">
            {machine === null
              ? machineId ? "агент ещё не выходил на связь" : "задачи без станка"
              : `${online ? "на связи" : `нет связи с ${formatTime(machine.at)}`}${machine.ip ? ` · ${machine.ip}` : ""}`}
          </p>
        </div>
        <div className="row" style={{ gap: 8 }}>
          {machine && online && machine.machineState && (
            <span className={`badge ${machine.alarms.length > 0 ? "failed" : machine.machineState === "Working" ? "in_progress" : "queued"}`}>
              {machineStateLabel(machine.machineState)}
            </span>
          )}
          <span className="badge queued">в очереди: {open.length}</span>
        </div>
      </div>
      {machine?.alarms.map((alarm, i) => <p key={i} className="error">Авария: {alarm}</p>)}
      {open.length === 0 ? (
        <p className="muted">Очередь станка пустая.</p>
      ) : (
        <div className="grid">
          {open.map((job, i) => <JobCard key={job._id} job={job} position={i + 1} />)}
        </div>
      )}
      {closed.length > 0 && (
        <details>
          <summary>Закрытые задачи ({closed.length})</summary>
          <div className="grid" style={{ marginTop: 10 }}>
            {closed.map((job) => <JobCard key={job._id} job={job} />)}
          </div>
        </details>
      )}
    </section>
  );
}

function JobCard({ job, position }: { job: JobView; position?: number }) {
  const total = job.readyCount + job.pendingCount;
  const ratio = total === 0 ? 0 : job.readyCount / total;
  return (
    <a className="card" href={`#/job/${job._id}`}>
      <div className="row">
        <strong>{position !== undefined ? `${position}. ` : ""}{job.number} · {job.title}</strong>
        <span className={`badge ${job.status}`}>{job.fileReady ? statusLabel[job.status] ?? job.status : "готовится файл"}</span>
      </div>
      <p className="muted">{job.thicknessMm ? `${job.thicknessMm} мм · ` : ""}{job.fileName} · {formatTime(job.createdAt)}</p>
      <div className="progress" style={{ marginTop: 10 }}><span style={{ width: `${ratio * 100}%` }} /></div>
      <p style={{ marginTop: 8 }}>
        Листов {job.sheetsDone} из {job.sheetsTotal} · позиций готово {job.readyCount} из {total}
        {job.estimateLeftSec !== null && job.estimateLeftSec > 0 ? ` · осталось ≈ ${formatDuration(job.estimateLeftSec)}` : ""}
      </p>
      <p className="muted">
        {job.lines.filter((line) => line.qtyDone < line.qtyPlanned).slice(0, 4).map((line) => line.name ?? line.cadName).join(", ") || "все позиции закрыты"}
      </p>
    </a>
  );
}

function sheetTitle(index: number, thicknessMm: string | null) {
  return thicknessMm ? `Лист ${index} (${thicknessMm}мм)` : `Лист ${index}`;
}

function sheetMismatch(job: { cypcutDone: number[] | null; sheets: Array<{ index: number; done: number; planCount: number }> }) {
  const theirs = new Set(job.cypcutDone ?? []);
  return job.sheets.some((sheet) => theirs.has(sheet.index) !== (sheet.done >= sheet.planCount));
}

function JobPage({ id }: { id: Id<"jobs"> }) {
  const job = useQuery(api.jobs.get, { jobId: id });
  const setQty = useMutation(api.jobs.setQtyDone);
  const finish = useMutation(api.jobs.finish);
  const cancel = useMutation(api.jobs.cancel);
  const sheetDone = useMutation(api.jobs.sheetDone);
  if (job === undefined) return <p className="muted">Загрузка…</p>;
  if (job === null) return <p>Задача не найдена.</p>;
  const closed = job.status === "done" || job.status === "cancelled";
  return (
    <div className="stack">
      <div className="card">
        <div className="row">
          <div>
            <h2>{job.number} · {job.title}</h2>
            <p className="muted">{job.machineId ?? "станок не указан"} · {job.thicknessMm ? `${job.thicknessMm} мм · ` : ""}{job.fileName}</p>
          </div>
          <span className={`badge ${job.status}`}>{statusLabel[job.status] ?? job.status}</span>
        </div>
        <p style={{ marginTop: 8 }}>Листов вырезано: {job.sheetsDone} из {job.sheetsTotal}. Позиций готово: {job.readyCount}, не готово: {job.pendingCount}.</p>
        <p className="muted" style={{ marginTop: 4 }}>
          {job.estimateTotalSec !== null && <>Оценка всей задачи ≈ {formatDuration(job.estimateTotalSec)}</>}
          {job.estimateLeftSec !== null && <>, осталось ≈ {formatDuration(job.estimateLeftSec)}</>}
          {job.actualTotalSec > 0 && <> · фактически вырезано за {formatDuration(job.actualTotalSec)}</>}
          {job.estimateTotalSec !== null && <> · {rateLabel(job.rate)}</>}
        </p>
        {job.cypcutLast && (
          <p style={{ marginTop: 4 }}>
            Последний старт в CypCut{job.cypcutLast.sheetIndex !== null ? ` (лист ${job.cypcutLast.sheetIndex})` : ""}, {formatTime(job.cypcutLast.at)}:{" "}
            {cypcutLabel(job.cypcutLast.estimate)}
          </p>
        )}
        {job.lastError && <p className="error">{job.lastError}</p>}
        <div className="progress" style={{ marginTop: 10 }}><span style={{ width: `${(job.sheetsDone / job.sheetsTotal) * 100}%` }} /></div>
        <div className="row" style={{ marginTop: 12 }}>
          <button className="ghost" disabled={closed} onClick={() => void sheetDone({ jobId: job._id })}>Лист вырезан</button>
          <button className="primary" disabled={closed} onClick={() => void finish({ jobId: job._id })}>Выполнено</button>
          <button className="danger" disabled={closed} onClick={() => void cancel({ jobId: job._id })}>Отменить</button>
        </div>
      </div>
      {job.sheets.length > 0 && (
        <div className="card stack">
          <h2>Листы раскроя</h2>
          <p className="muted">
            {job.currentFromCypCut
              ? "Рамкой отмечен лист, выбранный сейчас в CypCut."
              : "CypCut сейчас не сообщает выбранный лист. Рамкой отмечен первый ещё не вырезанный по нашему учёту."}
          </p>
          {job.cypcutDone && sheetMismatch(job) && (
            <p className="error">
              В CypCut отмечены вырезанными листы {job.cypcutDone.join(", ") || "—"}, а у нас учтены{" "}
              {job.sheets.filter((s) => s.done > 0).map((s) => s.index).join(", ") || "—"}. Количество деталей может не совпадать с фактом.
            </p>
          )}
          <div className="sheets">
            {job.sheets.map((sheet) => (
              <figure
                key={sheet.index}
                className={`sheet ${job.currentSheetIndex === sheet.index ? "current" : ""} ${sheet.done >= sheet.planCount ? "finished" : ""}`}
                style={{ margin: 0 }}
              >
                {sheet.previewUrl ? <img src={sheet.previewUrl} alt={sheetTitle(sheet.index, job.thicknessMm)} /> : <div className="thumb" style={{ width: "100%", height: 220 }} />}
                <strong>{sheetTitle(sheet.index, job.thicknessMm)}{sheet.planCount > 1 ? ` ×${sheet.planCount}` : ""} · вырезано {sheet.done} из {sheet.planCount}</strong>
                {job.cypcutDone?.includes(sheet.index) && <span>в CypCut: вырезан</span>}
                {job.currentFromCypCut && job.currentSheetIndex === sheet.index && <span>выбран в CypCut</span>}
                <span className="muted">{sheet.width}×{sheet.height} мм</span>
                {sheet.cutLengthMm !== null && <span className="muted">рез {meters(sheet.cutLengthMm)} · пробивок {sheet.pierces}</span>}
                {sheet.estimateSec !== null && <span>наша оценка ≈ {formatDuration(sheet.estimateSec)}</span>}
                {sheet.cypcut && <span>{cypcutLabel(sheet.cypcut)}</span>}
                {sheet.actualSec.length > 0 && <span>факт: {sheet.actualSec.map(formatDuration).join(", ")}</span>}
              </figure>
            ))}
          </div>
        </div>
      )}
      <div className="card">
        <table>
          <thead>
            <tr><th></th><th>Номенклатура</th><th>План</th><th>Готово</th></tr>
          </thead>
          <tbody>
            {job.lines.map((line) => (
              <tr key={line._id}>
                <td>{line.imageUrl ? <img className="thumb drawing" src={line.imageUrl} alt="" /> : <div className="thumb" />}</td>
                <td>
                  <div>{line.name ?? line.cadName}</div>
                  <div className="muted">{line.article ?? "без артикула"} · {line.cadName}</div>
                </td>
                <td>{line.qtyPlanned}</td>
                <td>
                  <div className="qty">
                    <button className="ghost" disabled={closed || line.qtyDone <= 0} onClick={() => void setQty({ lineId: line._id, qtyDone: line.qtyDone - 1 })}>−</button>
                    <input
                      type="number"
                      min={0}
                      max={line.qtyPlanned}
                      value={line.qtyDone}
                      disabled={closed}
                      onChange={(event) => void setQty({ lineId: line._id, qtyDone: Number(event.target.value) })}
                    />
                    <button className="ghost" disabled={closed || line.qtyDone >= line.qtyPlanned} onClick={() => void setQty({ lineId: line._id, qtyDone: line.qtyDone + 1 })}>+</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

type DraftLine = Inspected["lines"][number] & {
  createName: string;
  createArticle: string;
  createDescription: string;
  photoId: Id<"_storage"> | null;
  photoUrl: string | null;
};

function NewJob() {
  const presets = useQuery(api.presets.list);
  const enqueue = useMutation(api.presets.enqueue);
  const uploadUrl = useMutation(api.presets.generateUploadUrl);
  const inspectFile = useAction(api.presets.inspect);
  const save = useMutation(api.presets.save);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileId, setFileId] = useState<Id<"_storage"> | null>(null);
  const [fileName, setFileName] = useState("");
  const [sha, setSha] = useState("");
  const [thickness, setThickness] = useState("");
  const [presetThickness, setPresetThickness] = useState<Record<string, string>>({});
  const [presetError, setPresetError] = useState<string | null>(null);
  const [sheets, setSheets] = useState<Inspected["sheets"]>([]);
  const [sheetUrls, setSheetUrls] = useState<Inspected["sheetUrls"]>([]);
  const [kind, setKind] = useState<"nest" | "drawing">("nest");
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [title, setTitle] = useState("");
  const machines = useQuery(api.stand.machines);
  const [chosenMachine, setChosenMachine] = useState(() => localStorage.getItem("machineId") ?? "");
  const machineId = machines?.some((m) => m.machineId === chosenMachine)
    ? chosenMachine
    : machines?.[0]?.machineId ?? "";
  function chooseMachine(value: string) {
    setChosenMachine(value);
    localStorage.setItem("machineId", value);
  }

  const rate = machines?.find((m) => m.machineId === machineId)?.rate;

  async function onPhoto(index: number, file: File) {
    setError(null);
    try {
      const photoId = await uploadToStorage(uploadUrl, file);
      updateLine(setLines, index, { photoId, photoUrl: URL.createObjectURL(file) });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Фото не загрузилось");
    }
  }

  async function onFile(file: File) {
    setBusy(true);
    setError(null);
    try {
      const storageId = await uploadToStorage(uploadUrl, file);
      const preview = await inspectFile({ fileId: storageId, fileName: file.name });
      setFileId(storageId);
      setFileName(file.name);
      setSha(preview.sha256);
      setThickness(preview.thicknessMm ?? "");
      setSheets(preview.sheets);
      setSheetUrls(preview.sheetUrls);
      setKind(preview.kind);
      setTitle(file.name.replace(/\.lxds$/i, ""));
      setLines(preview.lines.map((line) => ({
        ...line,
        createName: line.name ?? line.cadName,
        createArticle: line.article ?? suggestArticle(line.cadName),
        createDescription: "",
        photoId: null,
        photoUrl: null,
      })));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Ошибка разбора");
    } finally {
      setBusy(false);
    }
  }

  async function commit(enqueueNow: boolean) {
    if (!fileId) return;
    if (enqueueNow && !thickness.trim()) {
      setError("Укажите толщину листа, например 1.0");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const saved = await save({
        title,
        fileName,
        fileId,
        sha256: sha,
        thicknessMm: thickness.trim() || undefined,
        sheets,
        enqueue: enqueueNow,
        machineId: enqueueNow ? machineId : undefined,
        lines: lines.map((line) => {
          const extra = {
            previewId: line.previewId ?? undefined,
            cutLengthMm: line.cutLengthMm ?? undefined,
            pierces: line.pierces ?? undefined,
            photoId: line.photoId ?? undefined,
          };
          return line.nomenclatureId
            ? { cadName: line.cadName, qty: line.qty, nomenclatureId: line.nomenclatureId, ...extra }
            : {
                cadName: line.cadName,
                qty: line.qty,
                ...extra,
                create: {
                  name: line.createName,
                  article: line.createArticle,
                  description: line.createDescription,
                },
              };
        }),
      });
      window.location.hash = saved.jobId ? `#/job/${saved.jobId}` : "#/";
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не сохранилось");
    } finally {
      setBusy(false);
    }
  }

  const sheetLabel = useMemo(() => {
    const first = sheets[0];
    if (!first) return "листов нет";
    return `${sheets.reduce((sum, sheet) => sum + sheet.planCount, 0)} лист. · ${first.width}×${first.height} мм`;
  }, [sheets]);

  return (
    <div className="stack">
      <div className="card stack">
        <label>
          Станок
          <select value={machineId} onChange={(event) => chooseMachine(event.target.value)} disabled={!machines?.length}>
            {machines?.map((machine) => (
              <option key={machine.machineId} value={machine.machineId}>{machine.machineId}</option>
            ))}
          </select>
        </label>
        {machines?.length === 0 && <p className="error">Нет ни одного станка: установите агент на станок, и он появится здесь.</p>}
      </div>

      <div className="card">
        <h2>Из сохранённого пресета</h2>
        <p className="muted">Толщина попадёт в названия листов в CypCut: «Лист 1 (1.0мм)», «Лист 2 (1.0мм)»…</p>
        {presets === undefined && <p className="muted">Загрузка…</p>}
        {presets?.length === 0 && <p className="muted">Пресетов пока нет.</p>}
        <div className="grid">
          {presets?.map((preset) => {
            const value = presetThickness[preset._id] ?? preset.thicknessMm ?? "";
            return (
              <div key={preset._id} className="row">
                <div>
                  <strong>{preset.title}</strong>
                  <div className="muted">{preset.sheetCount} лист. · {preset.lineCount} дет.{preset.ready ? "" : " · есть детали без карточек"}</div>
                </div>
                <div className="row" style={{ gap: 8 }}>
                  <label className="inline">
                    Толщина, мм
                    <input
                      className="thickness"
                      inputMode="decimal"
                      placeholder="1.0"
                      value={value}
                      onChange={(event) => setPresetThickness((prev) => ({ ...prev, [preset._id]: event.target.value }))}
                    />
                  </label>
                  <button
                    className="primary"
                    disabled={!preset.ready || !machineId || !value.trim()}
                    title={value.trim() ? "" : "Укажите толщину листа"}
                    onClick={() => {
                      setPresetError(null);
                      enqueue({ presetId: preset._id, machineId, thicknessMm: value })
                        .then((id) => { window.location.hash = `#/job/${id}`; })
                        .catch((reason: unknown) => setPresetError(reason instanceof Error ? reason.message.replace(/^.*Uncaught Error:\s*/s, "").split("\n")[0] ?? "" : "Не удалось поставить в очередь"));
                    }}
                  >
                    В очередь
                  </button>
                </div>
              </div>
            );
          })}
        </div>
        {presetError && <p className="error">{presetError}</p>}
      </div>

      <div className="card stack">
        <h2>Новый пресет из LXDS</h2>
        <label className="drop">
          {busy ? "Читаю файл…" : "Выберите файл .lxds"}
          <input type="file" accept=".lxds" hidden disabled={busy} onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void onFile(file);
          }} />
        </label>
        {error && <p className="error">{error}</p>}
        {fileId && (
          <>
            <label>Название<input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
            <label>
              Толщина листа, мм (пойдёт в названия листов в CypCut)
              <input className="thickness" inputMode="decimal" placeholder="1.0" value={thickness} onChange={(event) => setThickness(event.target.value)} />
            </label>
            <p className="muted">{fileName} · {sheetLabel}</p>
            {kind === "drawing" && (
              <p className="error">Это плоский чертёж без раскроя: состава деталей в файле нет. Задача будет одной позицией на один лист. Для учёта по деталям загрузите файл из папки «Варианты».</p>
            )}
            {sheets.some((sheet) => sheet.previewId) && (
              <div className="stack">
                <strong>Листы</strong>
                <div className="sheets">
                  {sheets.map((sheet) => {
                    const url = sheetUrls.find((s) => s.index === sheet.index)?.url;
                    const sec = estimate(rate, sheet.cutLengthMm, sheet.pierces);
                    return (
                      <figure key={sheet.index} className="sheet" style={{ margin: 0 }}>
                        {url ? <img src={url} alt={sheetTitle(sheet.index, thickness.trim() || null)} /> : <div className="thumb" style={{ width: "100%", height: 220 }} />}
                        <strong>{sheetTitle(sheet.index, thickness.trim() || null)}{sheet.planCount > 1 ? ` ×${sheet.planCount}` : ""}</strong>
                        {sheet.cutLengthMm !== undefined && <span className="muted">рез {meters(sheet.cutLengthMm)} · пробивок {sheet.pierces}</span>}
                        {sec !== null && <span>≈ {formatDuration(sec)} на лист</span>}
                      </figure>
                    );
                  })}
                </div>
                {rate && <p className="muted">Оценка времени: {rateLabel(rate)}.</p>}
              </div>
            )}
            <table>
              <thead><tr><th>Картинка</th><th>Деталь из файла</th><th>Кол-во</th><th>Номенклатура</th></tr></thead>
              <tbody>
                {lines.map((line, index) => {
                  const shown = line.photoUrl ?? line.imageUrl ?? line.previewUrl;
                  return (
                  <tr key={line.cadName}>
                    <td>
                      <div className="stack" style={{ justifyItems: "center" }}>
                        {shown ? <img className="thumb drawing big" src={shown} alt="" /> : <div className="thumb big" />}
                        <label className="pick">
                          {line.photoUrl ? "другое фото" : "загрузить фото"}
                          <input type="file" accept="image/*" hidden onChange={(event) => {
                            const file = event.target.files?.[0];
                            if (file) void onPhoto(index, file);
                          }} />
                        </label>
                      </div>
                    </td>
                    <td>
                      <div>{line.cadName}</div>
                      {line.cutLengthMm !== null && <div className="muted">рез {meters(line.cutLengthMm)} · пробивок {line.pierces}</div>}
                      <div className="muted">
                        {line.photoUrl
                          ? "в карточку пойдёт фото"
                          : line.imageUrl
                            ? "картинка уже есть в карточке"
                            : line.previewUrl
                              ? "в карточку пойдёт чертёж из файла"
                              : ""}
                      </div>
                    </td>
                    <td>{line.qty}</td>
                    <td>
                      {line.nomenclatureId ? (
                        <span>{line.name} · {line.article}</span>
                      ) : (
                        <div className="stack">
                          <input placeholder="Наименование" value={line.createName} onChange={(event) => updateLine(setLines, index, { createName: event.target.value })} />
                          <input placeholder="Артикул" value={line.createArticle} onChange={(event) => updateLine(setLines, index, { createArticle: event.target.value })} />
                          <input placeholder="Описание" value={line.createDescription} onChange={(event) => updateLine(setLines, index, { createDescription: event.target.value })} />
                        </div>
                      )}
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="row">
              <button className="ghost" disabled={busy} onClick={() => void commit(false)}>Сохранить пресет</button>
              <button className="primary" disabled={busy || !machineId} onClick={() => void commit(true)}>Сохранить и в очередь</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function updateLine(setLines: (value: DraftLine[] | ((prev: DraftLine[]) => DraftLine[])) => void, index: number, patch: Partial<DraftLine>) {
  setLines((prev) => prev.map((line, i) => (i === index ? { ...line, ...patch } : line)));
}

function suggestArticle(cadName: string) {
  return cadName.trim().replace(/\s+/g, " ").slice(0, 48);
}

function Machines() {
  const machines = useQuery(api.stand.machines);
  const removeMachine = useMutation(api.stand.removeMachine);
  const [removeError, setRemoveError] = useState<{ machineId: string; message: string } | null>(null);
  const onRemove = async (machineId: string, online: boolean) => {
    const warning = online
      ? `Станок «${machineId}» сейчас на связи: его агент работает и через несколько секунд вернёт станок в список. Чтобы убрать его насовсем, сначала запустите «Удалить.cmd» на компьютере станка. Всё равно удалить?`
      : `Удалить станок «${machineId}» из списка? Закрытые задачи этого станка останутся в истории.`;
    if (!window.confirm(warning)) return;
    setRemoveError(null);
    try {
      await removeMachine({ machineId });
    } catch (error) {
      const message = error instanceof Error ? error.message.replace(/^.*Uncaught Error:\s*/s, "").split("\n")[0] ?? "" : "";
      setRemoveError({ machineId, message: message || "Не удалось удалить станок" });
    }
  };
  if (machines === undefined) return <p className="muted">Загрузка…</p>;
  if (machines.length === 0) return <div className="card"><p>Ни один агент ещё не выходил на связь.</p></div>;
  return (
    <div className="stack">
      {machines.map((machine) => (
        <div key={machine.machineId} className="card stack">
          <div className="row">
            <div>
              <h2>{machine.machineId}</h2>
              <p className="muted">
                {machine.hostname}{machine.ip ? ` · IP ${machine.ip}` : ""}{machine.serverUrl ? ` · сервер ${machine.serverUrl}` : ""} · агент {machine.agentVersion} · связь {formatTime(machine.at)}
                {isOnline(machine.at) ? "" : " · нет связи больше минуты"}
              </p>
            </div>
            <div className="row" style={{ gap: 8 }}>
              <span className={`badge ${machine.cypcutRunning ? "done" : "cancelled"}`}>
                CypCut {machine.cypcutRunning ? "запущен" : "не запущен"}
              </span>
              {machine.cypcutRunning && machine.machineState && (
                <span className={`badge ${machine.alarms.length > 0 ? "failed" : machine.machineState === "Working" ? "in_progress" : "queued"}`}>
                  {machineStateLabel(machine.machineState)}
                </span>
              )}
              <button className="danger" onClick={() => void onRemove(machine.machineId, isOnline(machine.at))}>Удалить</button>
            </div>
          </div>
          {removeError?.machineId === machine.machineId && <p className="error">{removeError.message}</p>}
          {machine.alarms.map((alarm, i) => (
            <p key={i} className="error">Авария: {alarm}</p>
          ))}
          {/\s-\s*CypCut/i.test(machine.windowTitle) ? (
            <p>Открыт файл: {machine.windowTitle.replace(/\s*-\s*CypCut.*$/i, "")}</p>
          ) : (
            machine.cypcutRunning && <p className="muted">В CypCut не открыт ни один файл.</p>
          )}
          {machine.nest && (
            <p>
              Листов в раскрое: {machine.nest.total}. Выбран в CypCut: {machine.nest.current ?? "—"}. Отмечены вырезанными:{" "}
              {machine.nest.done.length > 0 ? machine.nest.done.join(", ") : "ни одного"}.
            </p>
          )}
          {machine.cypcutEstimate && <p>Последний старт: {cypcutLabel(machine.cypcutEstimate)}</p>}
          {machine.events.length > 0 && (
            <div className="stack">
              <strong>События станка</strong>
              <pre className="log">
                {machine.events
                  .map((event) =>
                    [
                      formatClock(event.at),
                      machineEventLabel(event.type),
                      event.sheetIndex !== null ? `лист ${event.sheetIndex}` : "",
                      event.text,
                    ]
                      .filter(Boolean)
                      .join(" · "),
                  )
                  .join("\n")}
              </pre>
            </div>
          )}
          {machine.screenUrl ? (
            <>
              <img className="screen" src={machine.screenUrl} alt="Окно CypCut" />
              <p className="muted">Снимок окна CypCut от {machine.screenAt ? formatTime(machine.screenAt) : "—"}</p>
            </>
          ) : (
            <p className="muted">Снимков окна пока нет (нужен агент 0.4 и запущенный CypCut).</p>
          )}
          {machine.panel.length > 0 && (
            <div className="stack">
              <strong>Значения на панели CypCut</strong>
              <div className="chips">{machine.panel.map((value, i) => <span key={i}>{value}</span>)}</div>
            </div>
          )}
          {machine.logTail.length > 0 && (
            <div className="stack">
              <strong>Журнал CypCut (последние строки)</strong>
              <pre className="log">{machine.logTail.join("\n")}</pre>
            </div>
          )}
          <p className="muted">Скорость для оценок: {rateLabel(machine.rate)}.</p>
          {machine.debug.length > 0 && (
            <details>
              <summary>Отладка агента</summary>
              <pre className="log">{machine.debug.join("\n")}</pre>
            </details>
          )}
        </div>
      ))}
    </div>
  );
}

function Catalog() {
  const cards = useQuery(api.nomenclature.list);
  const create = useMutation(api.nomenclature.create);
  const update = useMutation(api.nomenclature.update);
  const uploadUrl = useMutation(api.presets.generateUploadUrl);
  const [name, setName] = useState("");
  const [article, setArticle] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function uploadImage(file: File) {
    const postUrl = await uploadUrl();
    const posted = await fetch(postUrl, { method: "POST", headers: { "Content-Type": file.type || "application/octet-stream" }, body: file });
    if (!posted.ok) throw new Error("Не удалось загрузить картинку");
    const body = (await posted.json()) as { storageId: Id<"_storage"> };
    return body.storageId;
  }

  return (
    <div className="stack">
      <form className="card stack" onSubmit={(event) => {
        event.preventDefault();
        setError(null);
        void create({ name, article, description }).then(() => {
          setName(""); setArticle(""); setDescription("");
        }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Ошибка"));
      }}>
        <h2>Новая карточка</h2>
        <label>Наименование<input value={name} onChange={(event) => setName(event.target.value)} required /></label>
        <label>Артикул<input value={article} onChange={(event) => setArticle(event.target.value)} required /></label>
        <label>Описание<textarea value={description} onChange={(event) => setDescription(event.target.value)} /></label>
        {error && <p className="error">{error}</p>}
        <button className="primary" type="submit">Создать</button>
      </form>
      <div className="grid">
        {cards?.map((card) => (
          <article key={card._id} className="card row">
            {card.imageUrl ? <img className="thumb drawing big" src={card.imageUrl} alt="" /> : <div className="thumb big" />}
            <div className="stack" style={{ flex: 1 }}>
              <strong>{card.name}</strong>
              <span className="muted">{card.article}</span>
              <span>{card.description}</span>
              <span className="muted">{card.cadNames.join(" · ")}</span>
              <label>
                Картинка
                <input type="file" accept="image/*" onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (!file) return;
                  void uploadImage(file).then((imageId) => update({
                    id: card._id,
                    name: card.name,
                    article: card.article,
                    description: card.description,
                    imageId,
                  }));
                }} />
              </label>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
