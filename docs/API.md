# HTTP-контракт

Внешнее приложение работает с тем же сервером, что веб и агент станка. Базовый адрес — порт сайта Convex, тот, что `Запустить-сервер.cmd` печатает как `BaseUrl агента`. По умолчанию `http://<ip-сервера>:3211`.

Веб-страница по-прежнему ходит в Convex напрямую. Этот документ описывает HTTP, которым можно пользоваться из другой программы.

Два независимых контура:

| Контур | Префикс | Ключ | Кто вызывает |
|---|---|---|---|
| Приложение | `/api` | `API_TOKEN` | ERP, скрипт, другое приложение |
| Станок | `/agent` | `AGENT_TOKEN` | агент на компьютере станка |

Оба ключа задаёт установщик сервера и печатает в конце. По умолчанию оба равны `laser-stand-dev`. Если `API_TOKEN` на сервере не задан, `/api` принимает `AGENT_TOKEN`.

## Общие правила

Заголовок на каждый запрос:

```
Authorization: Bearer <ключ>
Content-Type: application/json
```

`GET` и скачивание файла тело не передают. На `/api` отвечаем на `OPTIONS` кодом `204` и разрешаем запросы из браузера с любого адреса (`Authorization`, `Content-Type`).

Успешный JSON-ответ имеет код `200`. Ошибка всегда такой объект:

```json
{ "error": "Текст, который можно показать пользователю" }
```

| Код | Когда |
|---|---|
| 400 | Не хватает поля, неверное значение, задача уже закрыта |
| 401 | Нет заголовка, ключ не тот, ключ на сервере не задан |
| 404 | Задача, файл или номенклатура не найдены |
| 409 | Артикул уже занят, имя детали уже привязано к другой карточке |
| 413 | Снимок экрана агента больше 3 МБ |
| 415 | В `/agent/screen` пришло не изображение |

Идентификаторы (`jobId`, `presetId`, `fileId`, `lineId`, `id`) — строки Convex. Их возвращают методы создания, передавать их нужно как есть. Время везде — миллисекунды Unix.

Список методов без авторизации не отдаётся. С ключом `GET /api` возвращает оглавление:

```json
{
  "version": 1,
  "auth": "Authorization: Bearer <API_TOKEN>",
  "docs": "docs/API.md",
  "endpoints": ["GET /api/machines", "GET /api/jobs"]
}
```

`endpoints` содержит все пути ниже. Это проверка связи: `200` значит ключ принят.

## Загрузка файла

Файлы (LXDS и картинки) загружаются в два шага. Сначала берём адрес:

`POST /api/files/upload-url`

Тело пустое. Ответ:

```json
{ "uploadUrl": "http://<ip-сервера>:3210/api/storage/upload?token=..." }
```

Адрес загрузки смотрит на порт `3210`, не на `3211`. Оба порта должны быть доступны приложению.

Дальше само тело файла:

```
POST <uploadUrl>
Content-Type: application/octet-stream
```

Ключ сюда не нужен, он уже внутри адреса. Ответ:

```json
{ "storageId": "kg2..." }
```

`storageId` подставляется как `fileId` при разборе LXDS и как `imageId` у карточки номенклатуры.

## Станки

### `GET /api/machines`

Тело нет. Ответ — станки, от которых приходил агент.

```json
{
  "machines": [
    {
      "machineId": "Лазер-1",
      "agentVersion": "0.8.0",
      "cypcutRunning": true,
      "windowTitle": "J-1_раскрой.lxds - CypCutE",
      "hostname": "LASER-PC",
      "at": 1761100000000,
      "ip": "192.168.50.2",
      "serverUrl": "http://192.168.50.1:3211",
      "machineState": "Working",
      "alarms": [],
      "logTail": ["(10/15 12:21:17)Production ends! Spend time: 38.408s"],
      "panel": [],
      "screenUrl": "http://192.168.50.1:3210/api/storage/...",
      "screenAt": 1761100000000,
      "nest": { "programId": "jd7...", "current": 2, "done": [1], "total": 7 },
      "cypcutEstimate": {
        "cutLengthMm": 2189.5,
        "moveLengthMm": 2025.28,
        "pierces": 0,
        "processSec": 28.184,
        "moveSec": 7.709,
        "delaySec": 0.523,
        "totalSec": 36.416
      },
      "rate": { "secPerMeter": 7, "secPerPierce": 1, "source": "default", "samples": 0 },
      "events": [
        { "type": "run_finished", "text": "за 38 с", "sheetIndex": 2, "at": 1761100000000 }
      ],
      "debug": []
    }
  ]
}
```

Поля, которых может не быть в данных, приходят как `null` или пустой массив. `machineState` — последнее состояние из журнала CypCut: `Working`, `Stop`, `Pause`, `Frame`, `Go Zero`, `Go ZeroRef`. `nest` есть, только когда агент видит список листов. `cypcutEstimate` — разбор последней оценки из журнала, поля кроме `totalSec` могут отсутствовать. `rate.source` равен `default`, пока по станку меньше фактов, и `fact`, когда скорость посчитана по вырезанным листам. `screenUrl` живёт, пока агент не пришлёт следующий снимок.

`events[].type`: `run_started`, `run_finished`, `run_stopped`, `alarm`, `alarm_cleared`. В массиве последние 20, свежие первыми. `sheetIndex` — `null`, если лист не был известен.

Связь свежая, если `Date.now() - at < 60000`.

### `DELETE /api/machines?machineId=Лазер-1`

Убирает станок из списка. Нельзя, пока у него есть задача в статусе `queued`, `delivered`, `loaded` или `in_progress`.

```json
{ "ok": true }
```

Ошибка, если задачи открыты:

```json
{ "error": "У станка 2 незакрытых задач. Закройте или отмените их, потом удаляйте станок." }
```

## Задачи

Статус задачи:

| status | Смысл |
|---|---|
| `queued` | в очереди, файл ещё готовится или агент его не забрал |
| `delivered` | файл лежит на станке |
| `loaded` | открыт в CypCut |
| `in_progress` | резка началась |
| `done` | закрыта |
| `cancelled` | отменена, агент удалит файл |
| `failed` | агент не смог открыть файл |

`fileReady: false` значит, сервер ещё переписывает имена листов. Агент такую задачу не видит. Обычно это доли секунды.

### `GET /api/jobs`

Последние 50 задач, новые первыми.

```json
{
  "jobs": [
    {
      "_id": "jd7...",
      "number": "J-1",
      "title": "1.0 mm Pi 96x7",
      "fileName": "1.0 mm Pi 96x7.lxds",
      "status": "in_progress",
      "lastError": null,
      "createdAt": 1761100000000,
      "machineId": "Лазер-1",
      "thicknessMm": "1.0",
      "fileReady": true,
      "readyCount": 1,
      "pendingCount": 3,
      "sheetsDone": 1,
      "sheetsTotal": 7,
      "currentSheetIndex": 2,
      "currentFromCypCut": true,
      "cypcutDone": [1],
      "estimateTotalSec": 260,
      "estimateLeftSec": 220,
      "actualTotalSec": 38,
      "rate": { "secPerMeter": 7, "secPerPierce": 1, "source": "default", "samples": 0 },
      "cypcutLast": {
        "sheetIndex": 2,
        "at": 1761100000000,
        "estimate": { "totalSec": 36.416, "cutLengthMm": 2189.5, "moveLengthMm": 2025.28, "pierces": 0, "processSec": 28.184, "moveSec": 7.709, "delaySec": 0.523 }
      },
      "lines": [
        {
          "_id": "k17...",
          "cadName": "Стойка",
          "qtyPlanned": 4,
          "qtyDone": 2,
          "nomenclatureId": "mn3...",
          "name": "Стойка левая",
          "article": "ST-L",
          "imageUrl": null
        }
      ],
      "sheets": [
        {
          "index": 1,
          "planCount": 1,
          "width": 1250,
          "height": 2200,
          "previewUrl": "http://192.168.50.1:3210/api/storage/...",
          "cutLengthMm": 2189.5,
          "pierces": 0,
          "estimateSec": 15,
          "actualSec": [38.408],
          "done": 1,
          "cypcut": null
        }
      ]
    }
  ]
}
```

`machineId`, `thicknessMm`, `lastError`, `currentSheetIndex`, оценки и `cypcutLast` бывают `null`. `currentFromCypCut: false` значит, что номер текущего листа угадан по учёту, а не прочитан из CypCut. `cypcutDone` — `null`, если список листов агент сейчас не видит. `name` и `article` строки — `null`, если у детали нет карточки. `previewUrl` и `imageUrl` — `null`, если картинки нет. `cutLengthMm`, `pierces`, `estimateSec` у листа — `null`, если файл их не содержал. `cypcut` у листа — последняя оценка CypCut по этому листу или `null`.

`readyCount` — сколько позиций уже закрыто (`qtyDone >= qtyPlanned`).

### `GET /api/jobs?jobId=<id>`

Одна задача, тот же объект внутри `{ "job": { ... } }`. Нет такой задачи: `404` и `{ "error": "Задача не найдена" }`.

### `GET /api/jobs/file?jobId=<id>`

Скачивание LXDS, который уйдёт на станок. Это не JSON: тело — байты файла. Заголовки ответа: `Content-Type: application/octet-stream`, `Content-Disposition: attachment; filename="..."`, `X-Sha256` — хеш в нижнем регистре. Имена листов внутри уже «Лист 1 (1.0мм)», если толщина была задана и файл успел подготовиться.

### `POST /api/jobs/qty`

Поправить, сколько деталей строки уже готово. Значение обрезается диапазоном от 0 до плана. Задача при этом становится `in_progress`, если ещё не режется. Закрытую задачу менять нельзя.

```json
{ "lineId": "k17...", "qtyDone": 3 }
```

```json
{ "ok": true }
```

### `POST /api/jobs/sheet-done`

Засчитать один лист вручную, как кнопка «Лист вырезан» в вебе. Лист выбирается сам: первый, у которого ещё не выработан план.

```json
{ "jobId": "jd7..." }
```

```json
{ "sheetsDone": 2, "sheetsTotal": 7 }
```

### `POST /api/jobs/finish`

Закрыть задачу, даже если листы не все вырезаны.

```json
{ "jobId": "jd7..." }
```

```json
{ "ok": true }
```

### `POST /api/jobs/cancel`

Отменить задачу. Агент удалит файл с компьютера станка.

```json
{ "jobId": "jd7..." }
```

```json
{ "ok": true }
```

Ошибки этих четырёх методов: `{ "error": "Задача не найдена" }`, `{ "error": "Задача уже закрыта" }` (для количества и листа), `{ "error": "Строка не найдена" }`.

## Пресеты

### `GET /api/presets`

```json
{
  "presets": [
    {
      "_id": "ps7...",
      "title": "1.0 mm Pi 96x7",
      "fileName": "1.0 mm Pi 96x7.lxds",
      "thicknessMm": "1.0",
      "sheetCount": 7,
      "lineCount": 4,
      "ready": true,
      "createdAt": 1761100000000
    }
  ]
}
```

`thicknessMm` — `null`, если толщину ещё не задавали. `ready: false` значит, у какой-то детали нет карточки номенклатуры, и в очередь пресет не встанет.

### `POST /api/presets/inspect`

Разобрать уже загруженный LXDS. Картинки листов и деталей сохраняются на сервере, в ответе их адреса.

```json
{ "fileId": "kg2...", "fileName": "1.0 mm Pi 96x7.lxds" }
```

```json
{
  "kind": "nest",
  "sha256": "ab12...",
  "thicknessMm": "1.0",
  "sheetCount": 7,
  "sheets": [
    {
      "index": 1,
      "width": 1250,
      "height": 2200,
      "planCount": 1,
      "utilization": 90.42,
      "parts": [{ "cadName": "Стойка", "qty": 2 }],
      "previewId": "kg3...",
      "cutLengthMm": 2189.5,
      "pierces": 12
    }
  ],
  "sheetUrls": [{ "index": 1, "url": "http://192.168.50.1:3210/api/storage/..." }],
  "lines": [
    {
      "cadName": "Стойка",
      "qty": 4,
      "nomenclatureId": "mn3...",
      "name": "Стойка левая",
      "article": "ST-L",
      "imageUrl": null,
      "previewId": "kg4...",
      "previewUrl": "http://192.168.50.1:3210/api/storage/...",
      "cutLengthMm": 800.5,
      "pierces": 4
    }
  ]
}
```

`kind` равен `nest` для раскроя и `drawing` для плоского чертежа без списка деталей. У чертежа одна позиция и один лист. `thicknessMm` берётся из имени файла (`1.0 mm ...`) и бывает `null`. `utilization`, `parts`, `previewId`, `cutLengthMm`, `pierces` у листа могут отсутствовать. `sheetUrls[].url` бывает `null`. У строки без карточки `nomenclatureId`, `name`, `article`, `imageUrl` равны `null`.

Файл не LXDS: `{ "error": "Файл не похож на LXDS (это zip-архив)" }`. В раскрое нет деталей: `{ "error": "В раскрое не найдены детали" }`.

### `POST /api/presets`

Сохранить пресет. Тело собирается из ответа `inspect`: лишние поля (`name`, `article`, `previewUrl`, `sheetUrls`) можно не выкидывать, сервер их не записывает. `enqueue: true` сразу ставит задачу на станок, тогда обязательны `machineId` и толщина.

```json
{
  "title": "1.0 mm Pi 96x7",
  "fileName": "1.0 mm Pi 96x7.lxds",
  "fileId": "kg2...",
  "sha256": "ab12...",
  "thicknessMm": "1.0",
  "sheets": [],
  "lines": [
    {
      "cadName": "Стойка",
      "qty": 4,
      "nomenclatureId": "mn3...",
      "previewId": "kg4...",
      "cutLengthMm": 800.5,
      "pierces": 4
    },
    {
      "cadName": "Петля",
      "qty": 8,
      "previewId": "kg5...",
      "create": { "name": "Петля", "article": "PET-1", "description": "" }
    }
  ],
  "enqueue": true,
  "machineId": "Лазер-1"
}
```

`sheets` в примере пустой только для краткости: передавайте массив из `inspect`. У строки либо `nomenclatureId` уже известной карточки, либо объект `create`, и тогда карточка создаётся. `photoId` — необязательный `storageId` фотографии, она заменит чертёж в карточке.

Толщина `1`, `1,0` и `1.0 мм` записывается как `1.0`. В CypCut листы получат имена «Лист 1 (1.0мм)», «Лист 2 (1.0мм)».

```json
{ "presetId": "ps7...", "jobId": "jd7..." }
```

`jobId` равен `null`, если `enqueue` был `false`. Пока `fileReady` у новой задачи `false`, агент её не забирает.

Ошибки: `{ "error": "В пресете нет деталей" }`, `{ "error": "Выберите станок" }`, `{ "error": "Укажите толщину листа, например 1.0" }`, `{ "error": "Не понял толщину «x». Пример: 1.0" }`, `{ "error": "Заполните карточку для «Петля»" }`, `{ "error": "Артикул «PET-1» уже есть" }`.

### `POST /api/presets/enqueue`

Поставить уже сохранённый пресет в очередь станка. Все детали должны иметь карточки. Толщина обязательна, если в пресете её ещё нет. Переданная толщина перезаписывает толщину пресета.

```json
{ "presetId": "ps7...", "machineId": "Лазер-1", "thicknessMm": "1.0" }
```

```json
{ "jobId": "jd7..." }
```

Ошибки: `{ "error": "Пресет не найден" }`, `{ "error": "Выберите станок" }`, `{ "error": "Укажите толщину листа, например 1.0" }`, `{ "error": "В пресете есть детали без номенклатуры" }`.

## Номенклатура

### `GET /api/nomenclature`

```json
{
  "nomenclature": [
    {
      "_id": "mn3...",
      "name": "Стойка левая",
      "article": "ST-L",
      "description": "",
      "imageUrl": null,
      "cadNames": ["Стойка"],
      "createdAt": 1761100000000
    }
  ]
}
```

`cadNames` — имена деталей из LXDS, которые привязаны к карточке. `imageUrl` — `null`, если картинки нет.

### `POST /api/nomenclature`

```json
{ "name": "Стойка левая", "article": "ST-L", "description": "", "cadName": "Стойка", "imageId": "kg9..." }
```

`description`, `cadName` и `imageId` необязательны. Без `cadName` к карточке привязывается само наименование.

```json
{ "id": "mn3..." }
```

### `POST /api/nomenclature/update`

```json
{
  "id": "mn3...",
  "name": "Стойка левая",
  "article": "ST-L",
  "description": "новая",
  "imageId": "kg9...",
  "clearImage": false
}
```

`clearImage: true` убирает картинку. Без `imageId` и без `clearImage` картинка остаётся прежней.

```json
{ "ok": true }
```

### `POST /api/nomenclature/lookup`

Узнать карточки по именам из CAD. Порядок ответа совпадает с порядком запроса. Нет привязки — поля карточки `null`.

```json
{ "cadNames": ["Стойка", "Неизвестная"] }
```

```json
{
  "matches": [
    { "cadName": "Стойка", "nomenclatureId": "mn3...", "name": "Стойка левая", "article": "ST-L", "imageUrl": null },
    { "cadName": "Неизвестная", "nomenclatureId": null, "name": null, "article": null, "imageUrl": null }
  ]
}
```

## Как поставить задачу из другого приложения

1. `GET /api/machines` и выбрать `machineId` станка, который на связи.
2. `POST /api/files/upload-url`, затем выложить `.lxds` на полученный адрес и взять `storageId`.
3. `POST /api/presets/inspect` с этим `storageId` и именем файла.
4. Для строк, где `nomenclatureId` равен `null`, либо заранее создать карточку через `POST /api/nomenclature`, либо передать `create` в строке.
5. `POST /api/presets` с `enqueue: true`, `machineId` и `thicknessMm`. В ответе `jobId`.
6. `GET /api/jobs?jobId=` пока статус не станет `delivered`, потом `loaded`, потом `in_progress`. `sheetsDone` растёт сам, когда CypCut пишет конец листа. `lines[].qtyDone` растёт по составу листа.

Повтор того же пресета — шаги 2–4 не нужны: `POST /api/presets/enqueue`.

## Агент станка

Эти методы вызывает только агент. Ключ — `AGENT_TOKEN`, не `API_TOKEN`. Другому приложению они нужны, только если оно само притворяется станком.

Ошибки здесь короче и по-английски: `{ "error": "Unauthorized" }`, `{ "error": "machineId is required" }`, `{ "error": "programId is required" }`, `{ "error": "Program not found" }`, `{ "error": "File missing" }`, `{ "error": "image body expected" }`, `{ "error": "image too large" }`.

### `GET /agent/programs?machineId=Лазер-1`

Задачи этого станка в статусах `queued`, `delivered`, `loaded`, `in_progress`, `cancelled`, у которых файл уже готов. Плюс задачи без указанного станка.

```json
{
  "programs": [
    {
      "programId": "jd7...",
      "programNumber": "J-1",
      "title": "1.0 mm Pi 96x7",
      "status": "queued",
      "fileName": "1.0 mm Pi 96x7.lxds",
      "sha256": "ab12...",
      "createdAt": 1761100000000
    }
  ]
}
```

### `GET /agent/file?programId=<jobId>`

Байты LXDS. Заголовки те же, что у `GET /api/jobs/file`: `X-Sha256` и `Content-Disposition`.

### `POST /agent/events`

```json
{
  "machineId": "Лазер-1",
  "events": [
    {
      "eventId": "уникальная-строка",
      "programId": "jd7...",
      "type": "run_finished",
      "at": 1761100000000,
      "count": 1,
      "detail": "(10/15 12:21:17)Production ends! Spend time: 38.408s",
      "sheet": 2
    }
  ]
}
```

`programId`, `count`, `detail`, `sheet` необязательны. Повтор того же `eventId` не применяется второй раз.

`type` и что он делает с задачей:

| type | Эффект |
|---|---|
| `delivered` | `queued` → `delivered` |
| `loaded` | `queued` или `delivered` → `loaded` |
| `in_progress` | до `loaded` включительно → `in_progress` |
| `run_started` | → `in_progress`, из `detail` читается оценка CypCut |
| `run_finished` | засчитывает `count` листов (по умолчанию 1), из `detail` читается факт времени |
| `run_stopped` | в журнал станка, лист не засчитывается |
| `alarm`, `alarm_cleared` | в журнал станка |
| `failed` | статус `failed`, текст в `lastError` |
| `file_removed` | только отметка, что событие принято |

```json
{ "accepted": ["уникальная-строка"], "duplicates": [] }
```

### `POST /agent/heartbeat`

```json
{
  "machineId": "Лазер-1",
  "agentVersion": "0.8.0",
  "cypcutRunning": true,
  "windowTitle": "J-1_раскрой.lxds - CypCutE",
  "hostname": "LASER-PC",
  "at": 1761100000000,
  "ip": "192.168.50.2",
  "serverUrl": "http://192.168.50.1:3211",
  "machineState": "Working",
  "alarms": [],
  "logTail": [],
  "panel": [],
  "nest": { "programId": "jd7...", "current": 2, "done": [1], "total": 7 },
  "debug": []
}
```

Обязательных полей нет: пустое тело создаёт станок `stand`. `logTail`, `panel`, `alarms`, `debug` — массивы строк, лишнее обрезается. `nest.total` обязан быть целым больше 0, иначе блок игнорируется.

```json
{ "ok": true }
```

### `POST /agent/screen?machineId=Лазер-1`

Тело — байты картинки, `Content-Type` начинается с `image/`. Не больше 3 МБ. Предыдущий снимок этого станка удаляется.

```json
{ "ok": true }
```
