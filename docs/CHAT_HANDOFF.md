# Handoff: лазерный станок (CypCut) ↔ веб-очередь на Convex

> **Как продолжить (локально или в Cursor Cloud):**
> 1. Открыть репо `whanarchyven/laser-erp` (ветка `main`).
> 2. Новый Agent-чат, первым сообщением:
>    `@docs/CHAT_HANDOFF.md продолжаем с этого handoff. Следующий шаг: …`
> 3. Для теста на настоящем станке — `docs/ТЕСТ-НА-СТАНКЕ.md`.
>
> Локальные чаты Cursor не синхронизируются. Этот файл и есть срез всего, о чём договорились.

Дата среза: **2026-10-15**. Версия агента: **0.6.1**.

---

## 1. Цель

Завод: станок **XT Laser XTC-1530H**, софт **CypCut 6.3.801.x** (Windows), задания в виде файлов **LXDS**.

Что нужно:
1. Отправлять задания на станок из веба, без флешки.
2. Получать обратно, что и сколько нарезано (по листам), фактическое время и оценку CypCut.
3. Потом перенести это в `whanarchyven/leanpro-erp` (там уже есть `cuttingPrograms` / `programs.finish`). **leanpro пока не трогаем.**

## 2. Что построено (всё в этом репо)

| Часть | Где | Суть |
|---|---|---|
| Backend | `convex/` | Convex: номенклатура, пресеты, задачи (jobs), учёт прогонов, HTTP API для агента |
| Веб | `src/App.tsx` (Vite + React) | Номенклатура, пресеты, новая задача, очередь, страница задачи с листами, страница «Станки» |
| Агент | `agent/Program.cs` (.NET 8, single-file win-x64) | Опрашивает API, скачивает LXDS, сам открывает файл в CypCut, читает окно/журнал CypCut, шлёт события |
| Установщик | `agent/installer/*`, `agent/build-usb.ps1` | Флешка: `Установить.cmd`, `Настроить-сеть.cmd`, `Удалить.cmd`, `ИНСТРУКЦИЯ.txt` |
| Запуск сервера | `Запустить-сервер.cmd`, `scripts/lan-server.ps1` | Convex dev + Vite в локальной сети |
| Утилиты | `scripts/*.mjs` | `enqueue`, `fake-run` (имитация прогона), `jobs`, `upload` и т.д. |

### Backend
- Режим: **локальный анонимный Convex dev** (`npx convex dev`). API на `:3210`, HTTP-роуты на `:3211`. Данные лежат в `.convex/` (в git не попадают).
- Обязательно: `npx convex env set AGENT_TOKEN laser-stand-dev`, иначе агент получает 401.
- Таблицы: `nomenclature`, `cadAliases`, `presets`, `presetLines`, `jobs`, `jobLines`, `cutRuns`, `cypcutEstimates`, `counters`, `agentEvents`, `heartbeats`.
- HTTP API агента (`convex/http.ts`), заголовок `Authorization: Bearer <AGENT_TOKEN>`:
  - `GET /agent/programs` — задачи для станка
  - `GET /agent/file?programId=` — скачать LXDS
  - `POST /agent/events` — события (`delivered`, `opened`, `run_started`, `run_finished`…), идемпотентно по `eventId`, поле `sheet` = номер листа
  - `POST /agent/heartbeat` — жив/CypCut/заголовок/журнал/`nest` (текущий лист, вырезанные листы)
  - `POST /agent/screen` — снимок окна CypCut
- Парсинг LXDS: `convex/lib/parseLxds.ts`, геометрия и превью: `lxdsGeometry.ts`, `sheets.ts`; оценка времени: `timing.ts`, `rates.ts`.
- Учёт прогонов: `convex/lib/progress.ts` (`applySheetRuns`). Если пришёл прогон с номером листа, он засчитывается именно этому листу.
- Оценка CypCut из журнала: `convex/lib/cypcutLog.ts` (`parseCypCutEstimate`).
- `convex/wipe.ts` — `npx convex run wipe:batch`, повторять, пока не вернёт 0. Нужно, чтобы очистить базу «как на новом станке».
- `stand:removeMachine` — удалить станок из веба. Не даст удалить, если у станка есть незакрытые задачи.

### Веб
- `vite.config.ts`: `host: true`. `src/main.tsx` подставляет в URL Convex хост страницы, поэтому веб работает с любого ПК в сети.
- Страница «Станки»: снимок окна, журнал, «Листов N, выбран X, вырезаны …», последний старт с оценкой CypCut, кнопка «Удалить».
- Страница задачи: листы, «в CypCut: вырезан», «выбран в CypCut», наша оценка рядом с оценкой CypCut. Если наш учёт расходится с CypCut, показывается предупреждение.

### Агент (`agent/Program.cs`, `AgentVersion = "0.6.1"`)
- Ставится как задача планировщика **LaserAgent**: запуск при входе любого пользователя, с наивысшими правами, перезапуск 999 раз. Mutex `Global\LaserAgent`. Опрос каждые 5 с.
- Конфиг `laser-agent.json`: `BaseUrl`, `Token`, `MachineId` (пусто = имя ПК), `JobsDir` (`C:\Jobs`), `FinishPatterns` (`Конец обработки`, `Processing End`, `加工结束`).
- Без сети он продолжает следить за CypCut, а события копит в outbox (`outbox.json`). Активную задачу без сети не закрывает.
- Нужен только Windows 10/11 x64; .NET встроен в exe.

## 3. Что выяснили про CypCut (проверено на демо 6.3.801.6 в VM)

- **LXDS** — это ZIP с XML: `Nest2D/Results/content.xml` (листы, `PlanCount`), `Nest2D/Parts/content.xml` (детали, `Amount`), превью листов.
- **Список листов** — это `TFsCheckListBox`. Сообщения `LB_GETCOUNT/GETCURSEL/GETTEXT/GETITEMRECT/GETTOPINDEX` работают из другого процесса. Пункт 0 — «Primary», дальше идут «Nest result» = лист N.
- **Состояние листа определяется по цвету** строки (окно снимается через `PrintWindow`, флаг `PW_RENDERFULLCONTENT`): `C0C0C0` = вырезан, `FFCCCC` = не вырезан, `A6CAF0` = выделен (у выделенного состояние не видно, поэтому агент запоминает его по заголовку).
- **Журнал при старте** (англ. демо):
  - `Cut Length: 11274,98 mm, Vacant Move Length 16388,01 mm, Piercing Count 0`
  - `Processing time (estimated):1min9,206s, Move time(estimated):1min35,416s,Delay Time:41,948s,Total time (estimated):3min26,632s`
  - Конец: `Processing End! Spend time: 5min6,376s`
- **KeyTips**: если нажать Alt на ленте DevExpress, включаются подсказки клавиш, и они перехватывают Ctrl+O. Агент выводит окно вперёд через `AttachThreadInput` + `SetForegroundWindow`, а запасной вариант — Alt, затем Esc (это исправлено в 0.6.1).

## 4. Чего ещё НЕ проверили

- Настоящий станок: реальная кнопка «Старт» → событие `run_started`, русский журнал, реальная плата FSCUT.
- Тексты журнала на русской версии CypCut (шаблоны в `cypcutLog.ts` сейчас под английский журнал).
- Запуск Convex без интернета на ноутбуке (репетиция описана в гайде, §1.1.1).
- Перенос в leanpro-erp.

## 5. Окружение автора (только для справки)

- Хост Windows, VM Hyper-V `laser-stand` (Win10, CypCut демо). IP хоста для VM: `172.23.32.1`. На VM агент 0.6.1 с `MachineId = LASER-STAND`.
- Скрипты управления VM (копирование агента с проверкой хеша, вайп, «флешка» на рабочем столе VM) лежат **вне репо**, в `D:\VMs\laser-stand\`, потому что в них есть пароль VM.
- Грабли:
  - `Copy-Item -ToSession` иногда обрезает большие файлы. Копировать во временную папку и сверять хеш.
  - PowerShell 5.1: `.ps1` с кириллицей сохранять в UTF-8 с BOM. `Get-Content` без `-Encoding UTF8` портит UTF-8 исходники.
  - В PowerShell 5 пустой аргумент `""` у `node` пропадает.

## 6. Правила работы

- Отвечать по-русски. leanpro не трогать. Не коммитить без просьбы. Лишние .md не плодить.
- Изменения в вебе проверять в браузере.
- Convex: `args`/`returns`-валидаторы, всё под `await`, без `Date.now()` в query, индексы вместо `.filter()`, без `any`.
- Тесты гонять на тестовых станках, не мешая реальным задачам.
- Коммиты в стиле conventional commits.

## 7. Следующие шаги

1. Тест на реальном станке по `docs/ТЕСТ-НА-СТАНКЕ.md`. Собрать журнал, дампы окна и снимки (§8 гайда).
2. По результатам поправить шаблоны журнала (русский CypCut) и распознавание листов.
3. Перенести контракт и учёт в `leanpro-erp` (`cuttingPrograms`, `programs.finish`), выдать токены на каждый станок.

## 8. Быстрый старт для разработчика

```powershell
npm install
npx convex dev            # первый раз: выбрать локальный анонимный деплой
npx convex env set AGENT_TOKEN laser-stand-dev
npm run dev               # http://localhost:5173
# агент: dotnet publish agent -c Release -r win-x64 (см. agent/build-usb.ps1)
```
