# Handoff: интеграция лазерного станка ↔ leanpro-erp

> **Как продолжить на другом компе:**  
> 1. Открыть папку репо `laser-erp` в Cursor (локально: `C:\Users\parac\OneDrive\Desktop\paracels\laser` или clone `whanarchyven/laser-erp`).  
> 2. Новый **Agent**-чат.  
> 3. Первым сообщением:  
>    `@docs/CHAT_HANDOFF.md продолжаем с этого handoff. Следующий шаг: …`  
> 4. При необходимости приложить `@Zayavki/.../*.lxds`.  
>  
> Локальные чаты Cursor **не синхронизируются** по аккаунту. Этот файл = срез всей договорённости.

Дата среза: **2026-10-14**.  
Репо среза: `whanarchyven/laser-erp` (ветка с этим файлом).  
Связанный ERP: `whanarchyven/leanpro-erp` (Convex), путь у автора раньше: `~/Desktop/leanpro-erp`.

---

## 1. Цель

На заводе станок **XT Laser XTC-1530H**, софт **CypCut Laser Cutting System 6.3.801.4** (Windows).  
Сейчас: чертежи на флешке → режут → всё.  

Нужно:
1. Удалённо загружать на станок задания (файлы **LXDS**) из веб-сервиса по API.
2. Получать обратную связь: что нарезано → в ERP понять, какая номенклатура/полуфабрикаты вышли со станка.

---

## 2. Решение (выбрано)

**Вариант 3 — свой агент**, без покупки RayBox / CloudNest на первом этапе.

| Слой | Стек |
|------|------|
| Станок | Windows 10, CypCut 6.3.801.4, файлы `.lxds` |
| Агент на ПК станка | **.NET 8** Windows Service, self-contained `win-x64` single-file |
| Backend (позже) | **Convex** в `leanpro-erp`, HTTP routes |
| Backend (сейчас, стенд) | Временный **mock API** в этом репо (`laser-erp`) |
| Тест | VM **Windows 10 22H2** + CypCut 6.3.801.4; код пишем на хосте |

Агент **только исходящие** HTTP-запросы (poll). Не кликает UI CypCut, не принимает входящие порты.

Официальные альтернативы (на будущее): BOCHU **RayBox** (локальный HTTP API + callbacks), **CloudNest** + CloudCut assistant (нужен интернет/доступ к API BOCHU). Не выбраны для MVP.

---

## 3. Что выяснили про LXDS

LXDS = **ZIP** (часто store/deflate) с XML внутри. Сохранено CypCut **6.3.761.9** (пример с машины `KONS`).

Ключевые пути внутри архива:
- `info.xml` — версия приложения, компьютер, время сохранения
- `Nest2D/Results/content.xml` — листы: `Index`, `PlanCount`, `SizeX/Y` (часто 1250×2200), `Utilization`, GUID
- `Nest2D/Parts/content.xml` — детали: `Name` вроде `1.0 mm Pi 96x7L   VA` … `VN`, атрибут `Amount`
- `Nest2D/Plates/content.xml` — заготовка: `Amount` / `AmountUsed`
- Превью: `Nest2D/Results/N/thumbnail.emf`; рядом с файлом часто лежит `.lxds.fs.bmp`

Примеры из `Zayavki/ピアノ/960x2070/1.0/Варианты/`:

| Файл | Листов (Results) | Деталей VA…VN | Amount каждой |
|------|------------------|---------------|---------------|
| `1.0 mm Pi 96x7L   V (2dv).lxds` | 5 | 14 | 2 |
| `1.0 mm Pi 96x7L   V (3dv).lxds` | 7 | 14 | 3 |
| `1.0 mm Pi 96x7R   V (2dv).lxds` | 5 | 14 | 2 |
| `1.0 mm Pi 96x7R   V (6dv).lxds` | 13 | 14 | 6 |

Выводы:
- Один LXDS = **один раскройный пакет** (несколько листов), не «один лист».
- Учёт для ERP: **файл целиком отработан** → все детали по `Amount` произведены. Частичное — только через оператора (листы общие на несколько дверей; надёжно разложить детали по листам нельзя).
- Материал в CypCut часто `Material Name` (пусто); толщину берём из имени (`1.0 mm`).
- Нужна таблица соответствия **имя детали CAD → `items` в ERP**.

---

## 4. Связь с leanpro-erp

В `leanpro-erp/convex` уже есть почти вся доменная модель:

- `cuttingPrograms` — `draft → ready → running → done | cancelled`, `fileStorageId`, `sheetsPlanned`, `sheetsUsed`
- `cuttingProgramLines` — `programId`, `taskId`, `itemId`, `qtyPlanned`, `qtyGood`, `qtyDefect`
- `programs.ts`: `draftFromStack`, `attachFile`, `start`, `finish`  
  `finish` списывает листы (`issue`) и приходует полуфабрикаты (`receipt`), начисляет сдельную (`accruePieceForCycle`)

Идея интеграции:
1. Шаблоны раскроя (варианты 2dv/3dv/…) + парсер LXDS → заполняют `sheetsPlanned` и строки.
2. Программа `ready` → агент скачивает файл на станок.
3. События агента: `delivered`, `opened`, прогресс (если найдём), затем оператор подтверждает → `programs.finish` (на первом этапе **не** закрывать программу автоматически с агента, т.к. `finish` завязан на пользователя/сдельную).

HTTP в leanpro уже есть (`convex/http.ts`) с общим `LEANPRO_REST_API_KEY`. Для станков нужны **отдельные токены на машину**.

Открытый вопрос автору: детали `VA…VN` — 14 отдельных полуфабрикатов или один комплект двери? Где рецепт лазерного процесса (`processRecipes`)?

---

## 5. Контракт агента (целевой)

Авторизация: `Authorization: Bearer <machine-token>`.

| Метод | Путь | Назначение |
|-------|------|------------|
| GET | `/agent/programs` | программы `ready` (+ cancelled для удаления файла) |
| GET | `/agent/file?programId=` | скачать LXDS |
| POST | `/agent/events` | пачка событий, идемпотентность по `eventId` |
| POST | `/agent/heartbeat` | жив, CypCut running, window title, agent version |

Статусы доставки (поверх статуса программы): примерно  
`queued → delivered → opened → in_progress → done / partial / cancelled / failed`.

Локально на станке:
- Папка: `C:\Jobs\<programNumber>_<title>.lxds` (скачивание через `.tmp` + sha256)
- Outbox: SQLite
- Наблюдение: `CypCut.exe` running + `MainWindowTitle` (read-only)
- Приоритет процесса: BelowNormal

---

## 6. План стенда (текущий фокус)

### Роли
| Где | Что |
|-----|-----|
| Хост / Cursor в `laser-erp` | пишем агент + mock API |
| VM Win10 **22H2** | CypCut **6.3.801.4** + агент; тест открытия LXDS |
| Позже | те же роуты → Convex leanpro |

### VM
- RAM ≥ 8 GB, 4 vCPU, диск 60–80 GB
- Shared folder: `Zayavki` → `C:\Jobs\Samples`
- Process Monitor (Sysinternals)
- CypCut без платы FSCUT = демо — ок для открытия LXDS / логов / заголовка окна

### Разведка CypCut (обязательно на VM)
1. Process Monitor: фильтр `CypCut.exe`, операции WriteFile/CreateFile/RegSetValue  
2. Открыть LXDS, симуляция, «Отчёт», сохранить файл  
3. Сравнить XML LXDS до/после: появляется ли счётчик выполненного (`PlanCount` / ActiveModelID и т.п.)  
4. Записать пути логов/отчётов/заголовка окна → `docs/CYPCUT_RECON.md`

### Очередь работ в этом репо
1. ~~Handoff~~ (этот файл)  
2. `docs/CONTRACT.md` — JSON схем  
3. `mock-api/` — временный backend  
4. `agent/` — .NET 8 каркас  
5. Сквозной тест на VM  
6. Парсер LXDS (zip+XML)  
7. Перенос контракта в leanpro Convex  

---

## 7. Примеры путей к файлам

Каталоги: `Zayavki/пиано/` и `Zayavki/С7/`.

```
Zayavki/пиано/960x2070/1.0/Варианты/1.0 mm Pi 96x7L   V (2dv).lxds
Zayavki/пиано/960x2070/1.0/Варианты/1.0 mm Pi 96x7L   V (3dv).lxds
Zayavki/пиано/960x2070/1.0/Варианты/1.0 mm Pi 96x7R   V (2dv).lxds
```

## 8. История обсуждения (краткий хронолог)

1. Вопрос: можно ли API к CypCut / удалённая загрузка и feedback.  
2. Обзор: RayBox API, CloudNest OpenAPI, DIY-агент.  
3. Выбор DIY на тестовом ПК с CypCut.  
4. Backend = Convex, станок = Win10, формат = LXDS.  
5. Разобрали реальные LXDS (zip+XML, Parts Amount = число дверей).  
6. Сопоставили с `cuttingPrograms` в leanpro.  
7. Перенос чата: локальные чаты не sync; код через git; Cloud Agent / резюме.  
8. На новом окружении: `/workspace` = clone `laser-erp`; локальный Windows path недоступен облачному агенту.  
9. Договорённость: mock API здесь → потом leanpro; VM Win10 22H2 + CypCut 6.3.801.4.  
10. Этот handoff — чтобы продолжить локально в `...\paracels\laser`.

---

## 9. Промпт для нового чата (скопировать)

```text
@docs/CHAT_HANDOFF.md

Продолжаем интеграцию лазерного станка. Контекст весь в handoff.

Сейчас работаем локально в laser-erp.
Следующий шаг: каркас mock-api + agent (.NET 8) по CONTRACT,
параллельно стенд VM Win10 22H2 + CypCut 6.3.801.4.

Не интегрируем leanpro до готовности контракта на mock.
```

---

## 10. Чеклист «я на другом компе»

- [ ] `git pull` в `laser-erp` (получить этот файл)
- [ ] Cursor → Open Folder → `...\paracels\laser`
- [ ] Новый Agent-чат + промпт из §9
- [ ] VM: ISO Win10 22H2, CypCut 6.3.801.4 с дилера/станка
- [ ] Shared `Zayavki`, открыть `(2dv).lxds` в CypCut
- [ ] Начать код: `docs/CONTRACT.md` → `mock-api` → `agent`
