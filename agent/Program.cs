using System.Diagnostics;
using System.Net.Http.Headers;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

const string AgentVersion = "0.6.1";

using var single = new Mutex(true, @"Global\LaserAgent", out var firstInstance);
if (!firstInstance) return;

var config = AgentConfig.Load(args);
Directory.CreateDirectory(config.JobsDir);
var logFile = new StreamWriter(Path.Combine(config.JobsDir, "agent.log"), append: true) { AutoFlush = true };
Console.SetOut(TextWriter.Synchronized(new TeeWriter(Console.Out, logFile)));
using var http = new HttpClient { BaseAddress = new Uri(config.BaseUrl.TrimEnd('/') + "/") };
http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", config.Token);
http.Timeout = TimeSpan.FromMinutes(2);

var state = new AgentState(config.JobsDir);
var lastDump = DateTime.MinValue;
var lastOpen = DateTime.MinValue;
var lastScreen = DateTime.MinValue;
string? startMarks = null;
var lastPrograms = new List<ProgramItem>();

Console.WriteLine($"Агент {AgentVersion} {config.MachineId} → {config.BaseUrl}");
Console.WriteLine($"Папка заданий: {config.JobsDir}, сеанс {Process.GetCurrentProcess().SessionId}");

while (true)
{
    var online = true;
    try
    {
        await FlushAsync(http, state);
        lastPrograms = await PollAsync(http, config, state);
    }
    catch (Exception ex)
    {
        online = false;
        Console.WriteLine($"{DateTime.Now:HH:mm:ss} нет связи с сервером: {ex.Message}");
    }
    try
    {
        var programs = lastPrograms;
        var snapshot = CypCutWatch.Read();
        CypCutWatch.DismissSecondInstance(snapshot);
        if (Diagnostics.Run(config, snapshot)) lastDump = DateTime.MinValue;
        if (DateTime.Now - lastDump > TimeSpan.FromSeconds(config.WindowDumpSeconds))
        {
            var image = CypCutWatch.Capture(snapshot);
            CypCutWatch.Dump(snapshot, Path.Combine(config.JobsDir, "cypcut-windows.txt"), image);
            image?.SaveBmp(Path.Combine(config.JobsDir, "cypcut.bmp"));
            lastDump = DateTime.Now;
        }
        if (online) TrackActive(state, programs, snapshot);
        var nest = CypCutWatch.Nest(snapshot);
        TrackRuns(config, state, snapshot, nest);
        startMarks = TrackStarts(state, snapshot, nest, startMarks);
        if (online)
        {
            if (DateTime.Now - lastOpen > TimeSpan.FromSeconds(60) && AutoOpen(config, state, programs, snapshot, ref lastOpen))
            {
                lastOpen = DateTime.Now;
            }
            await HeartbeatAsync(http, config, snapshot, nest, state.Active);
            if (config.ScreenSeconds > 0 && DateTime.Now - lastScreen > TimeSpan.FromSeconds(config.ScreenSeconds))
            {
                lastScreen = DateTime.Now;
                await ScreenAsync(http, config, snapshot);
            }
        }
    }
    catch (Exception ex)
    {
        Console.WriteLine($"{DateTime.Now:HH:mm:ss} {ex.Message}");
    }
    await Task.Delay(TimeSpan.FromSeconds(config.PollSeconds));
}

static async Task<List<ProgramItem>> PollAsync(HttpClient http, AgentConfig config, AgentState state)
{
    using var response = await http.GetAsync($"agent/programs?machineId={Uri.EscapeDataString(config.MachineId)}");
    var body = await response.Content.ReadAsStringAsync();
    if (!response.IsSuccessStatusCode) throw new InvalidOperationException($"programs {(int)response.StatusCode}: {body}");
    var programs = (JsonSerializer.Deserialize<ProgramList>(body, Json.Opts) ?? new ProgramList()).Programs ?? [];
    foreach (var program in programs)
    {
        if (program.Status == "cancelled")
        {
            if (state.Known.TryGetValue(program.ProgramId, out var path) && path.Length > 0)
            {
                if (File.Exists(path))
                {
                    File.Delete(path);
                    Console.WriteLine($"Удалён {path}");
                }
                state.Known[program.ProgramId] = "";
                state.SaveKnown();
                if (state.Active == program.ProgramId) state.SetActive(null);
                state.Enqueue(program.ProgramId, "file_removed");
            }
            continue;
        }

        var target = Path.Combine(config.JobsDir, SafeFileName(program.ProgramNumber, program.FileName));
        var existing = state.Known.GetValueOrDefault(program.ProgramId, "");
        if (existing.Length == 0 || !File.Exists(existing) || !HashEquals(existing, program.Sha256))
        {
            await DownloadAsync(http, program, target);
            state.Known[program.ProgramId] = target;
            state.SaveKnown();
            Console.WriteLine($"Скачан {target}");
        }
        state.Enqueue(program.ProgramId, "delivered");
    }
    return programs;
}

static void TrackActive(AgentState state, List<ProgramItem> programs, CypCutSnapshot snapshot)
{
    if (state.Active is not null && programs.All(p => p.ProgramId != state.Active || p.Status == "cancelled"))
    {
        Console.WriteLine($"Задача {state.Active} закрыта в вебе");
        state.SetActive(null);
    }
    if (!snapshot.Running || snapshot.Title.Length == 0) return;
    foreach (var program in programs.Where(p => p.Status != "cancelled"))
    {
        var path = state.Known.GetValueOrDefault(program.ProgramId, "");
        var stem = Path.GetFileNameWithoutExtension(path);
        if (stem.Length == 0 || !snapshot.Title.Contains(stem, StringComparison.OrdinalIgnoreCase)) continue;
        if (state.Active != program.ProgramId)
        {
            Console.WriteLine($"В CypCut открыт {stem}");
            state.SetActive(program.ProgramId);
        }
        state.Enqueue(program.ProgramId, "loaded");
        return;
    }
}

static void TrackRuns(AgentConfig config, AgentState state, CypCutSnapshot snapshot, NestState? nest)
{
    if (!snapshot.Running) return;
    var marks = snapshot.Windows.Sum(w => config.Patterns.Sum(p => CountOf(w.Text, p)));
    var previous = state.FinishMarks;
    state.SetFinishMarks(marks);
    if (previous is null || marks <= previous) return;
    var delta = marks - previous.Value;
    var finishLines = CypCutWatch.LogLines(snapshot)
        .Where(line => config.Patterns.Any(p => line.Contains(p, StringComparison.OrdinalIgnoreCase)))
        .TakeLast(delta)
        .ToList();
    if (state.Active is null)
    {
        Console.WriteLine($"CypCut закончил проход ({delta}), но активной задачи нет: {string.Join(" | ", finishLines)}");
        return;
    }
    var sheet = nest?.Current;
    state.Enqueue(state.Active, "run_finished", $"{state.Active}:run:{Guid.NewGuid():N}", delta, string.Join("\n", finishLines), sheet);
    Console.WriteLine($"Проход завершён: {state.Active} лист {sheet?.ToString() ?? "?"} +{delta} {string.Join(" | ", finishLines)}");
}

static string? TrackStarts(AgentState state, CypCutSnapshot snapshot, NestState? nest, string? previous)
{
    if (!snapshot.Running) return previous;
    const string mark = "Total time (estimated)";
    var lines = CypCutWatch.LogLines(snapshot);
    var at = lines.FindLastIndex(line => line.Contains(mark, StringComparison.OrdinalIgnoreCase));
    var latest = at >= 0 ? lines[at] : "";
    if (previous is null || latest == previous || at < 0 || state.Active is null) return latest;
    var detail = string.Join("\n", lines.Skip(Math.Max(0, at - 3)).Take(Math.Min(4, at + 1)));
    var sheet = nest?.Current;
    state.Enqueue(state.Active, "run_started", $"{state.Active}:start:{Guid.NewGuid():N}", null, detail, sheet);
    Console.WriteLine($"Старт резки: {state.Active} лист {sheet?.ToString() ?? "?"} | {latest}");
    return latest;
}

static bool AutoOpen(AgentConfig config, AgentState state, List<ProgramItem> programs, CypCutSnapshot snapshot, ref DateTime lastOpen)
{
    if (!config.AutoOpen || state.Active is not null) return false;
    if (programs.Any(p => p.Status is "loaded" or "in_progress")) return false;
    var next = programs.FirstOrDefault(p => p.Status == "delivered" && File.Exists(state.Known.GetValueOrDefault(p.ProgramId, "")));
    if (next is null) return false;
    var path = state.Known[next.ProgramId];
    if (!File.Exists(config.CypCutPath))
    {
        state.Enqueue(next.ProgramId, "failed", null, null, $"Не найден CypCut: {config.CypCutPath}");
        return true;
    }
    lastOpen = DateTime.Now;
    try
    {
        if (snapshot.Running)
        {
            CypCutWatch.OpenThroughDialog(snapshot, path);
        }
        else
        {
            Process.Start(new ProcessStartInfo(config.CypCutPath, $"\"{path}\"")
            {
                UseShellExecute = false,
                WorkingDirectory = Path.GetDirectoryName(config.CypCutPath)!,
            });
        }
    }
    catch (Exception ex)
    {
        Console.WriteLine($"Не удалось открыть в CypCut: {ex.Message}");
        state.Enqueue(next.ProgramId, "failed", null, null, $"Агент не смог открыть файл в CypCut: {ex.Message}");
        return true;
    }
    Console.WriteLine($"Открываю в CypCut: {path} (CypCut уже был запущен: {snapshot.Running})");
    state.SetActive(next.ProgramId);
    state.Enqueue(next.ProgramId, "loaded");
    return true;
}

static int CountOf(string text, string pattern)
{
    if (pattern.Length == 0) return 0;
    var count = 0;
    for (var i = text.IndexOf(pattern, StringComparison.OrdinalIgnoreCase); i >= 0; i = text.IndexOf(pattern, i + pattern.Length, StringComparison.OrdinalIgnoreCase)) count++;
    return count;
}

static async Task DownloadAsync(HttpClient http, ProgramItem program, string target)
{
    var tmp = target + ".tmp";
    using var response = await http.GetAsync($"agent/file?programId={Uri.EscapeDataString(program.ProgramId)}");
    if (!response.IsSuccessStatusCode)
    {
        var error = await response.Content.ReadAsStringAsync();
        throw new InvalidOperationException($"file {(int)response.StatusCode}: {error}");
    }
    await using (var input = await response.Content.ReadAsStreamAsync())
    await using (var output = File.Create(tmp))
    {
        await input.CopyToAsync(output);
    }
    var hash = await FileHashAsync(tmp);
    if (!string.Equals(hash, program.Sha256, StringComparison.OrdinalIgnoreCase))
    {
        File.Delete(tmp);
        throw new InvalidOperationException($"sha256 не совпал для {program.FileName}");
    }
    Directory.CreateDirectory(Path.GetDirectoryName(target)!);
    if (File.Exists(target)) File.Delete(target);
    File.Move(tmp, target);
}

static async Task HeartbeatAsync(HttpClient http, AgentConfig config, CypCutSnapshot snapshot, NestState? nest, string? active)
{
    var payload = JsonSerializer.Serialize(new
    {
        machineId = config.MachineId,
        agentVersion = AgentVersion,
        cypcutRunning = snapshot.Running,
        windowTitle = snapshot.Title,
        hostname = Environment.MachineName,
        at = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
        logTail = snapshot.Running ? CypCutWatch.LogLines(snapshot).TakeLast(15).ToArray() : null,
        panel = snapshot.Running ? CypCutWatch.PanelValues(snapshot) : null,
        nest = nest is null ? null : new { programId = active, current = nest.Current, done = nest.Done, total = nest.Total },
    });
    using var content = new StringContent(payload, Encoding.UTF8, "application/json");
    using var response = await http.PostAsync("agent/heartbeat", content);
    if (!response.IsSuccessStatusCode)
    {
        var error = await response.Content.ReadAsStringAsync();
        throw new InvalidOperationException($"heartbeat {(int)response.StatusCode}: {error}");
    }
}

static async Task ScreenAsync(HttpClient http, AgentConfig config, CypCutSnapshot snapshot)
{
    if (!snapshot.Running) return;
    var image = CypCutWatch.Capture(snapshot);
    if (image is null) return;
    using var content = new ByteArrayContent(image.ToPng());
    content.Headers.ContentType = new MediaTypeHeaderValue("image/png");
    using var response = await http.PostAsync($"agent/screen?machineId={Uri.EscapeDataString(config.MachineId)}", content);
    if (!response.IsSuccessStatusCode)
    {
        var error = await response.Content.ReadAsStringAsync();
        throw new InvalidOperationException($"screen {(int)response.StatusCode}: {error}");
    }
}

static async Task FlushAsync(HttpClient http, AgentState state)
{
    if (state.Outbox.Count == 0) return;
    var payload = JsonSerializer.Serialize(new
    {
        events = state.Outbox.Select(item => new
        {
            eventId = item.EventId,
            programId = item.ProgramId,
            type = item.Type,
            at = item.At,
            count = item.Count,
            detail = item.Detail,
        }),
    });
    using var content = new StringContent(payload, Encoding.UTF8, "application/json");
    using var response = await http.PostAsync("agent/events", content);
    var body = await response.Content.ReadAsStringAsync();
    if (!response.IsSuccessStatusCode) throw new InvalidOperationException($"events {(int)response.StatusCode}: {body}");
    state.ClearOutbox();
}

static string SafeFileName(string number, string fileName)
{
    var clean = string.Join("_", fileName.Split(Path.GetInvalidFileNameChars(), StringSplitOptions.RemoveEmptyEntries)).Trim();
    if (!clean.EndsWith(".lxds", StringComparison.OrdinalIgnoreCase)) clean += ".lxds";
    return $"{number}_{clean}";
}

static bool HashEquals(string path, string sha256) =>
    string.Equals(FileHashAsync(path).GetAwaiter().GetResult(), sha256, StringComparison.OrdinalIgnoreCase);

static async Task<string> FileHashAsync(string path)
{
    await using var stream = File.OpenRead(path);
    var hash = await SHA256.HashDataAsync(stream);
    return Convert.ToHexString(hash).ToLowerInvariant();
}

static class Json
{
    public static readonly JsonSerializerOptions Opts = new() { PropertyNameCaseInsensitive = true, WriteIndented = true };

    public static T Load<T>(string path, T fallback) =>
        File.Exists(path) ? JsonSerializer.Deserialize<T>(File.ReadAllText(path), Opts) ?? fallback : fallback;

    public static void Save<T>(string path, T value) => File.WriteAllText(path, JsonSerializer.Serialize(value, Opts));
}

sealed class AgentState
{
    readonly string dir;
    readonly HashSet<string> sent;

    public AgentState(string dir)
    {
        this.dir = dir;
        Outbox = Json.Load(Path("outbox.json"), new List<OutEvent>());
        Known = Json.Load(Path("known.json"), new Dictionary<string, string>());
        sent = new HashSet<string>(Json.Load(Path("sent.json"), new List<string>()), StringComparer.OrdinalIgnoreCase);
        var active = Json.Load(Path("active.json"), new ActiveState(null, null));
        Active = active.ProgramId;
        FinishMarks = active.FinishMarks;
    }

    public List<OutEvent> Outbox { get; }
    public Dictionary<string, string> Known { get; }
    public string? Active { get; private set; }
    public int? FinishMarks { get; private set; }

    string Path(string name) => System.IO.Path.Combine(dir, name);

    public void SaveKnown() => Json.Save(Path("known.json"), Known);

    public void SetActive(string? programId)
    {
        Active = programId;
        Json.Save(Path("active.json"), new ActiveState(Active, FinishMarks));
    }

    public void SetFinishMarks(int marks)
    {
        if (FinishMarks == marks) return;
        FinishMarks = marks;
        Json.Save(Path("active.json"), new ActiveState(Active, FinishMarks));
    }

    public void Enqueue(string programId, string type, string? key = null, int? count = null, string? detail = null, int? sheet = null)
    {
        if (!sent.Add(key ?? programId + ":" + type)) return;
        Json.Save(Path("sent.json"), sent.ToList());
        Outbox.Add(new OutEvent(Guid.NewGuid().ToString("N"), programId, type, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), count, detail, sheet));
        Json.Save(Path("outbox.json"), Outbox);
    }

    public void ClearOutbox()
    {
        Outbox.Clear();
        Json.Save(Path("outbox.json"), Outbox);
    }
}

sealed record CypCutWindow(nint Handle, nint Parent, string Class, string Text, bool Visible);
sealed record CypCutSnapshot(bool Running, string Title, List<CypCutWindow> Windows);

static class CypCutWatch
{
    public static CypCutSnapshot Read()
    {
        if (!OperatingSystem.IsWindows()) return new CypCutSnapshot(false, "", []);
        var processes = Process.GetProcessesByName("CypCut");
        if (processes.Length == 0) return new CypCutSnapshot(false, "", []);
        var ids = processes.Select(p => (uint)p.Id).ToHashSet();
        var windows = new List<CypCutWindow>();
        Native.EnumWindows((top, _) =>
        {
            Native.GetWindowThreadProcessId(top, out var pid);
            if (!ids.Contains(pid)) return true;
            windows.Add(Describe(top, 0));
            Native.EnumChildWindows(top, (child, _) =>
            {
                windows.Add(Describe(child, Native.GetParent(child)));
                return true;
            }, 0);
            return true;
        }, 0);
        var title = processes.Select(p => p.MainWindowTitle).FirstOrDefault(t => !string.IsNullOrWhiteSpace(t))
            ?? windows.Where(w => w.Parent == 0 && w.Visible && w.Text.Length > 0).Select(w => w.Text).FirstOrDefault()
            ?? "";
        return new CypCutSnapshot(true, title, windows);
    }

    public static void OpenThroughDialog(CypCutSnapshot snapshot, string path)
    {
        var main = snapshot.Windows.FirstOrDefault(w => w.Class == "TfrmCypCut")
            ?? throw new InvalidOperationException("Окно CypCut не найдено");
        if (Native.IsIconic(main.Handle)) Native.ShowWindow(main.Handle, 9);
        BringToFront(main.Handle);
        Thread.Sleep(300);
        Native.keybd_event(0x11, 0, 0, 0);
        Native.keybd_event(0x4F, 0, 0, 0);
        Native.keybd_event(0x4F, 0, 2, 0);
        Native.keybd_event(0x11, 0, 2, 0);

        var deadline = DateTime.Now.AddSeconds(90);
        while (DateTime.Now < deadline)
        {
            Thread.Sleep(500);
            var dialog = FindFileDialog();
            if (dialog is null) continue;
            var edit = FindFileNameEdit(dialog.Value);
            if (edit == 0) continue;
            Native.SendMessageText(edit, Native.WM_SETTEXT, 0, path);
            Thread.Sleep(200);
            var ok = Native.GetDlgItem(dialog.Value, 1);
            if (ok == 0) throw new InvalidOperationException("В окне «Открыть» нет кнопки OK");
            Native.PostMessage(ok, Native.BM_CLICK, 0, 0);
            Console.WriteLine($"Файл выбран в окне «Открыть»: {path}");
            return;
        }
        throw new InvalidOperationException("CypCut не показал окно «Открыть» за 90 с (возможно, ждёт ответа оператора)");
    }

    static void BringToFront(nint window)
    {
        if (Native.GetForegroundWindow() == window) return;
        var foreground = Native.GetForegroundWindow();
        var theirs = Native.GetWindowThreadProcessId(foreground, out _);
        var mine = Native.GetCurrentThreadId();
        var attached = theirs != 0 && theirs != mine && Native.AttachThreadInput(mine, theirs, true);
        Native.BringWindowToTop(window);
        Native.SetForegroundWindow(window);
        if (attached) Native.AttachThreadInput(mine, theirs, false);
        if (Native.GetForegroundWindow() == window) return;

        Native.keybd_event(0x12, 0, 0, 0);
        Native.keybd_event(0x12, 0, 2, 0);
        Native.SetForegroundWindow(window);
        Thread.Sleep(200);
        Native.keybd_event(0x1B, 0, 0, 0);
        Native.keybd_event(0x1B, 0, 2, 0);
    }

    static nint? FindFileDialog()
    {
        var ids = Process.GetProcessesByName("CypCut").Select(p => (uint)p.Id).ToHashSet();
        nint? found = null;
        Native.EnumWindows((hwnd, _) =>
        {
            Native.GetWindowThreadProcessId(hwnd, out var pid);
            if (!ids.Contains(pid) || !Native.IsWindowVisible(hwnd)) return true;
            var cls = new StringBuilder(64);
            Native.GetClassName(hwnd, cls, cls.Capacity);
            if (cls.ToString() != "#32770" || FindFileNameEdit(hwnd) == 0) return true;
            found = hwnd;
            return false;
        }, 0);
        return found;
    }

    static nint FindFileNameEdit(nint dialog)
    {
        nint result = 0;
        Native.EnumChildWindows(dialog, (child, _) =>
        {
            var cls = new StringBuilder(64);
            Native.GetClassName(child, cls, cls.Capacity);
            if (cls.ToString() != "Edit") return true;
            var parent = new StringBuilder(64);
            Native.GetClassName(Native.GetParent(child), parent, parent.Capacity);
            if (parent.ToString() is not ("ComboBox" or "ComboBoxEx32")) return true;
            result = child;
            return false;
        }, 0);
        return result;
    }

    public static WindowImage? Capture(CypCutSnapshot snapshot)
    {
        var main = snapshot.Windows.FirstOrDefault(w => w.Class == "TfrmCypCut");
        return main is null ? null : CaptureWindow(main.Handle);
    }

    const uint DoneColor = 0xC0C0C0;
    static readonly Dictionary<int, bool> doneMemory = [];
    static string memoryTitle = "";

    public static NestState? Nest(CypCutSnapshot snapshot)
    {
        if (!snapshot.Running) return null;
        if (memoryTitle != snapshot.Title)
        {
            doneMemory.Clear();
            memoryTitle = snapshot.Title;
        }
        var list = snapshot.Windows.FirstOrDefault(w => w.Visible && w.Class == "TFsCheckListBox"
            && Ask(w.Handle, Native.LB_GETCOUNT) > 1 && ItemText(w.Handle, 1).StartsWith("Nest result", StringComparison.OrdinalIgnoreCase));
        if (list is null || !Native.GetWindowRect(list.Handle, out var origin)) return null;
        var items = ListItems(list.Handle, origin, CaptureWindow(list.Handle));
        int? current = null;
        var sheet = 0;
        foreach (var item in items)
        {
            if (!item.Text.StartsWith("Nest result", StringComparison.OrdinalIgnoreCase)) continue;
            sheet++;
            if (item.Selected) current = sheet;
            else if (item.Color != 0) doneMemory[sheet] = item.Color == DoneColor;
        }
        var done = doneMemory.Where(p => p.Value && p.Key <= sheet).Select(p => p.Key).Order().ToArray();
        return new NestState(current, done, sheet);
    }

    static string ItemText(nint handle, int index)
    {
        var length = (int)Ask(handle, Native.LB_GETTEXTLEN, index);
        if (length is <= 0 or >= 2000) return "";
        var buffer = new StringBuilder(length + 1);
        return Native.SendMessageTimeoutText(handle, Native.LB_GETTEXT, index, buffer, Native.SMTO_ABORTIFHUNG, 200, out _) == 0 ? "" : buffer.ToString();
    }

    public static WindowImage? CaptureWindow(nint handle)
    {
        if (!Native.GetWindowRect(handle, out var rect)) return null;
        var width = rect.Right - rect.Left;
        var height = rect.Bottom - rect.Top;
        if (width <= 0 || height <= 0) return null;
        var screen = Native.GetDC(0);
        var dc = Native.CreateCompatibleDC(screen);
        var bitmap = Native.CreateCompatibleBitmap(screen, width, height);
        var old = Native.SelectObject(dc, bitmap);
        Native.PrintWindow(handle, dc, 2);
        var header = new byte[40];
        BitConverter.GetBytes(40).CopyTo(header, 0);
        BitConverter.GetBytes(width).CopyTo(header, 4);
        BitConverter.GetBytes(-height).CopyTo(header, 8);
        BitConverter.GetBytes((short)1).CopyTo(header, 12);
        BitConverter.GetBytes((short)32).CopyTo(header, 14);
        var pixels = new byte[width * height * 4];
        Native.SelectObject(dc, old);
        Native.GetDIBits(dc, bitmap, 0, (uint)height, pixels, header, 0);
        Native.DeleteObject(bitmap);
        Native.DeleteDC(dc);
        Native.ReleaseDC(0, screen);
        return new WindowImage(width, height, pixels);
    }

    static readonly System.Text.RegularExpressions.Regex Stamp = new(@"^\(\d{1,2}\.\d{1,2} \d{1,2}:\d{2}:\d{2}\)");

    public static List<string> LogLines(CypCutSnapshot snapshot)
    {
        var best = snapshot.Windows
            .Where(w => w.Class == "TRichEdit")
            .Select(w => w.Text.Split('\n').Select(l => l.Trim()).Where(l => l.Length > 0).ToList())
            .OrderByDescending(lines => lines.Count(l => Stamp.IsMatch(l)))
            .FirstOrDefault();
        return best ?? [];
    }

    public static string[] PanelValues(CypCutSnapshot snapshot)
    {
        var values = new List<string>();
        foreach (var w in snapshot.Windows.Where(w => w.Visible && w.Text.Length is > 0 and < 60))
        {
            if (w.Class == "TRzCalcEdit") values.Add(w.Text);
            else if (w.Class == "TRzMenuButton" && w.Text.StartsWith("X:")) values.Add(w.Text);
            else if (w.Class == "TPanel" && w.Text.StartsWith("Ячейка", StringComparison.OrdinalIgnoreCase)) values.Add(w.Text);
        }
        foreach (var name in new[] { "Старт", "Пауза", "Стоп", "Start", "Pause", "Stop" })
        {
            var button = snapshot.Windows.FirstOrDefault(w => w.Class == "TRzBitBtn" && w.Text.TrimEnd('*') == name);
            if (button is not null) values.Add($"{button.Text}: {(Native.IsWindowEnabled(button.Handle) ? "доступна" : "недоступна")}");
        }
        return values.ToArray();
    }

    public static void DismissSecondInstance(CypCutSnapshot snapshot)
    {
        foreach (var label in snapshot.Windows.Where(w => w.Text.Contains("Another instance of CypCut", StringComparison.OrdinalIgnoreCase)))
        {
            var ok = snapshot.Windows.FirstOrDefault(w => w.Parent == label.Parent && w.Class == "Button");
            if (ok is null) continue;
            Native.PostMessage(ok.Handle, Native.BM_CLICK, 0, 0);
            Console.WriteLine("Закрыл предупреждение о второй копии CypCut");
        }
    }

    static CypCutWindow Describe(nint handle, nint parent)
    {
        var cls = new StringBuilder(256);
        Native.GetClassName(handle, cls, cls.Capacity);
        return new CypCutWindow(handle, parent, cls.ToString(), TextOf(handle), Native.IsWindowVisible(handle));
    }

    static string TextOf(nint handle)
    {
        if (Native.SendMessageTimeout(handle, Native.WM_GETTEXTLENGTH, 0, 0, Native.SMTO_ABORTIFHUNG, 200, out var length) == 0) return "";
        var size = (int)Math.Min(length.ToInt64(), 200_000);
        if (size <= 0) return "";
        var buffer = new StringBuilder(size + 1);
        return Native.SendMessageTimeoutText(handle, Native.WM_GETTEXT, size + 1, buffer, Native.SMTO_ABORTIFHUNG, 500, out _) == 0
            ? ""
            : buffer.ToString();
    }

    public sealed record ListItem(int Index, string Text, bool Selected, Native.Rect Box, uint Color);

    static nint Ask(nint handle, uint msg, nint wParam = 0) =>
        Native.SendMessageTimeout(handle, msg, wParam, 0, Native.SMTO_ABORTIFHUNG, 200, out var result) == 0 ? -1 : result;

    public static List<ListItem> ListItems(nint handle, Native.Rect origin, WindowImage? image)
    {
        var items = new List<ListItem>();
        var count = (int)Ask(handle, Native.LB_GETCOUNT);
        for (var i = 0; i < Math.Min(count, 500); i++)
        {
            var text = ItemText(handle, i);
            var box = default(Native.Rect);
            Native.SendMessageTimeoutRect(handle, Native.LB_GETITEMRECT, i, out box, Native.SMTO_ABORTIFHUNG, 200, out _);
            var screen = new Native.Point { X = box.Left, Y = box.Top };
            Native.ClientToScreen(handle, ref screen);
            var rel = new Native.Rect
            {
                Left = screen.X - origin.Left,
                Top = screen.Y - origin.Top,
                Right = screen.X - origin.Left + box.Right - box.Left,
                Bottom = screen.Y - origin.Top + box.Bottom - box.Top,
            };
            items.Add(new ListItem(i, text, Ask(handle, Native.LB_GETSEL, i) > 0, rel, image?.DominantColor(rel) ?? 0));
        }
        return items;
    }

    public static void Dump(CypCutSnapshot snapshot, string path, WindowImage? image = null)
    {
        var lines = new List<string> { $"{DateTime.Now:O} running={snapshot.Running} title={snapshot.Title} windows={snapshot.Windows.Count}" };
        var main = snapshot.Windows.FirstOrDefault(w => w.Class == "TfrmCypCut");
        var origin = main is not null && Native.GetWindowRect(main.Handle, out var mr) ? mr : default;
        foreach (var w in snapshot.Windows.Where(w => w.Visible || w.Text.Length > 0))
        {
            var text = w.Text.Length > 400 ? w.Text[..200] + " … " + w.Text[^200..] : w.Text;
            var box = Native.GetWindowRect(w.Handle, out var r)
                ? $"{r.Left - origin.Left},{r.Top - origin.Top} {r.Right - r.Left}x{r.Bottom - r.Top}"
                : "?";
            var enabled = Native.IsWindowEnabled(w.Handle) ? "" : " disabled";
            lines.Add($"{w.Handle:X} parent={w.Parent:X} visible={w.Visible}{enabled} at={box} class={w.Class} len={w.Text.Length} text={text.Replace("\r", "\\r").Replace("\n", "\\n")}");
            if (!w.Class.Contains("ListBox", StringComparison.OrdinalIgnoreCase)) continue;
            lines.Add($"  list count={Ask(w.Handle, Native.LB_GETCOUNT)} cur={Ask(w.Handle, Native.LB_GETCURSEL)} top={Ask(w.Handle, Native.LB_GETTOPINDEX)}");
            foreach (var item in ListItems(w.Handle, origin, image))
            {
                var b = item.Box;
                lines.Add($"  item {item.Index} sel={item.Selected} at={b.Left},{b.Top} {b.Right - b.Left}x{b.Bottom - b.Top} color={item.Color:X6} text={item.Text}");
            }
        }
        var nest = Nest(snapshot);
        if (nest is not null) lines.Add($"nest current={nest.Current} done={string.Join(",", nest.Done)} total={nest.Total}");
        File.WriteAllLines(path, lines);
    }
}

sealed record WindowImage(int Width, int Height, byte[] Bgra)
{
    public void SaveBmp(string path)
    {
        using var file = File.Create(path);
        using var writer = new BinaryWriter(file);
        writer.Write((byte)'B');
        writer.Write((byte)'M');
        writer.Write(14 + 40 + Bgra.Length);
        writer.Write(0);
        writer.Write(14 + 40);
        writer.Write(40);
        writer.Write(Width);
        writer.Write(-Height);
        writer.Write((short)1);
        writer.Write((short)32);
        writer.Write(new byte[24]);
        writer.Write(Bgra);
    }

    public uint DominantColor(Native.Rect box)
    {
        var counts = new Dictionary<uint, int>();
        for (var y = Math.Max(0, box.Top); y < Math.Min(Height, box.Bottom); y++)
        {
            for (var x = Math.Max(0, box.Left); x < Math.Min(Width, box.Right); x++)
            {
                var at = (y * Width + x) * 4;
                var rgb = (uint)(Bgra[at + 2] << 16 | Bgra[at + 1] << 8 | Bgra[at]);
                counts[rgb] = counts.GetValueOrDefault(rgb) + 1;
            }
        }
        return counts.Count == 0 ? 0 : counts.MaxBy(p => p.Value).Key;
    }

    public byte[] ToPng()
    {
        var raw = new byte[Height * (Width * 3 + 1)];
        for (var y = 0; y < Height; y++)
        {
            var row = y * (Width * 3 + 1);
            for (var x = 0; x < Width; x++)
            {
                var src = (y * Width + x) * 4;
                var dst = row + 1 + x * 3;
                raw[dst] = Bgra[src + 2];
                raw[dst + 1] = Bgra[src + 1];
                raw[dst + 2] = Bgra[src];
            }
        }
        using var compressed = new MemoryStream();
        using (var z = new System.IO.Compression.ZLibStream(compressed, System.IO.Compression.CompressionLevel.Fastest, leaveOpen: true))
        {
            z.Write(raw);
        }
        using var png = new MemoryStream();
        png.Write([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
        var ihdr = new byte[13];
        WriteBe(ihdr, 0, Width);
        WriteBe(ihdr, 4, Height);
        ihdr[8] = 8;
        ihdr[9] = 2;
        Chunk(png, "IHDR", ihdr);
        Chunk(png, "IDAT", compressed.ToArray());
        Chunk(png, "IEND", []);
        return png.ToArray();
    }

    static void WriteBe(byte[] buffer, int at, int value)
    {
        buffer[at] = (byte)(value >> 24);
        buffer[at + 1] = (byte)(value >> 16);
        buffer[at + 2] = (byte)(value >> 8);
        buffer[at + 3] = (byte)value;
    }

    static void Chunk(Stream output, string type, byte[] data)
    {
        var head = new byte[8];
        WriteBe(head, 0, data.Length);
        Encoding.ASCII.GetBytes(type).CopyTo(head, 4);
        output.Write(head);
        output.Write(data);
        var crc = Crc32(head.AsSpan(4), data);
        var tail = new byte[4];
        WriteBe(tail, 0, (int)crc);
        output.Write(tail);
    }

    static readonly uint[] CrcTable = Enumerable.Range(0, 256).Select(n =>
    {
        var c = (uint)n;
        for (var k = 0; k < 8; k++) c = (c & 1) != 0 ? 0xEDB88320 ^ (c >> 1) : c >> 1;
        return c;
    }).ToArray();

    static uint Crc32(ReadOnlySpan<byte> type, byte[] data)
    {
        var c = 0xFFFFFFFFu;
        foreach (var b in type) c = CrcTable[(c ^ b) & 0xFF] ^ (c >> 8);
        foreach (var b in data) c = CrcTable[(c ^ b) & 0xFF] ^ (c >> 8);
        return c ^ 0xFFFFFFFFu;
    }
}

static class Diagnostics
{
    public static bool Run(AgentConfig config, CypCutSnapshot snapshot)
    {
        var path = Path.Combine(config.JobsDir, "diag.txt");
        if (!File.Exists(path)) return false;
        var commands = File.ReadAllLines(path);
        File.Delete(path);
        var main = snapshot.Windows.FirstOrDefault(w => w.Class == "TfrmCypCut");
        if (main is null || !Native.GetWindowRect(main.Handle, out var origin)) return false;
        foreach (var command in commands)
        {
            var parts = command.Split(' ', StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length != 3 || parts[0] != "click") continue;
            var point = new Native.Point { X = origin.Left + int.Parse(parts[1]), Y = origin.Top + int.Parse(parts[2]) };
            var target = Native.WindowFromPoint(point);
            if (target == 0) continue;
            var local = point;
            Native.ScreenToClient(target, ref local);
            var lParam = (nint)((local.Y << 16) | (local.X & 0xFFFF));
            Native.PostMessage(target, Native.WM_LBUTTONDOWN, 1, lParam);
            Native.PostMessage(target, Native.WM_LBUTTONUP, 0, lParam);
            Console.WriteLine($"diag: клик {parts[1]},{parts[2]} → окно {target:X} ({local.X},{local.Y})");
            Thread.Sleep(1500);
        }
        return true;
    }
}

static class Native
{
    public const uint WM_GETTEXT = 0x000D;
    public const uint WM_GETTEXTLENGTH = 0x000E;
    public const uint SMTO_ABORTIFHUNG = 0x0002;
    public const uint WM_SETTEXT = 0x000C;
    public const uint BM_CLICK = 0x00F5;
    public const uint WM_LBUTTONDOWN = 0x0201;
    public const uint WM_LBUTTONUP = 0x0202;

    [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }
    [DllImport("user32.dll")] public static extern nint WindowFromPoint(Point point);
    [DllImport("user32.dll")] public static extern bool ScreenToClient(nint hwnd, ref Point point);
    [DllImport("user32.dll")] public static extern bool ClientToScreen(nint hwnd, ref Point point);
    [DllImport("user32.dll")] public static extern bool IsWindowEnabled(nint hwnd);

    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(nint hwnd);
    [DllImport("user32.dll")] public static extern nint GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(nint hwnd);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint attach, uint attachTo, bool on);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern bool IsIconic(nint hwnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(nint hwnd, int command);
    [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, nuint extra);
    [DllImport("user32.dll")] public static extern nint GetDlgItem(nint dialog, int id);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "SendMessageW")]
    public static extern nint SendMessageText(nint hwnd, uint msg, nint wParam, string lParam);

    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] public static extern bool GetWindowRect(nint hwnd, out Rect rect);
    [DllImport("user32.dll")] public static extern bool PrintWindow(nint hwnd, nint dc, uint flags);
    [DllImport("user32.dll")] public static extern nint GetDC(nint hwnd);
    [DllImport("user32.dll")] public static extern int ReleaseDC(nint hwnd, nint dc);
    [DllImport("gdi32.dll")] public static extern nint CreateCompatibleDC(nint dc);
    [DllImport("gdi32.dll")] public static extern nint CreateCompatibleBitmap(nint dc, int width, int height);
    [DllImport("gdi32.dll")] public static extern nint SelectObject(nint dc, nint obj);
    [DllImport("gdi32.dll")] public static extern bool DeleteObject(nint obj);
    [DllImport("gdi32.dll")] public static extern bool DeleteDC(nint dc);
    [DllImport("gdi32.dll")] public static extern int GetDIBits(nint dc, nint bitmap, uint start, uint lines, byte[] bits, byte[] info, uint usage);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool PostMessage(nint hwnd, uint msg, nint wParam, nint lParam);

    public delegate bool EnumProc(nint hwnd, nint lParam);

    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc proc, nint lParam);
    [DllImport("user32.dll")] public static extern bool EnumChildWindows(nint parent, EnumProc proc, nint lParam);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(nint hwnd, out uint pid);
    [DllImport("user32.dll")] public static extern nint GetParent(nint hwnd);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(nint hwnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(nint hwnd, StringBuilder name, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern nint SendMessageTimeout(nint hwnd, uint msg, nint wParam, nint lParam, uint flags, uint timeout, out nint result);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "SendMessageTimeoutW")]
    public static extern nint SendMessageTimeoutText(nint hwnd, uint msg, nint wParam, StringBuilder lParam, uint flags, uint timeout, out nint result);
    [DllImport("user32.dll", EntryPoint = "SendMessageTimeoutW")]
    public static extern nint SendMessageTimeoutRect(nint hwnd, uint msg, nint wParam, out Rect lParam, uint flags, uint timeout, out nint result);

    public const uint LB_GETSEL = 0x0187;
    public const uint LB_GETCURSEL = 0x0188;
    public const uint LB_GETTEXT = 0x0189;
    public const uint LB_GETTEXTLEN = 0x018A;
    public const uint LB_GETCOUNT = 0x018B;
    public const uint LB_GETTOPINDEX = 0x018E;
    public const uint LB_GETITEMRECT = 0x0198;
}

sealed record AgentConfig(
    string BaseUrl,
    string Token,
    string JobsDir,
    int PollSeconds,
    string MachineId,
    string CypCutPath = @"C:\Program Files (x86)\Friendess\CypCut\CypCut.exe",
    bool AutoOpen = true,
    int WindowDumpSeconds = 30,
    string[]? FinishPatterns = null,
    int ScreenSeconds = 15)
{
    public string[] Patterns => FinishPatterns ?? ["Конец обработки", "Processing End", "加工结束"];

    public static AgentConfig Load(string[] args)
    {
        var path = args.FirstOrDefault(arg => arg.EndsWith(".json", StringComparison.OrdinalIgnoreCase))
            ?? Path.Combine(AppContext.BaseDirectory, "appsettings.json");
        var file = File.Exists(path)
            ? JsonSerializer.Deserialize<AgentConfig>(File.ReadAllText(path), Json.Opts) ?? throw new InvalidOperationException("Пустой appsettings.json")
            : new AgentConfig("", "", "C:\\Jobs", 5, "laser-stand");
        return file with
        {
            BaseUrl = Env("LASER_BASE_URL", file.BaseUrl),
            Token = Env("LASER_TOKEN", file.Token),
            JobsDir = Env("LASER_JOBS_DIR", file.JobsDir),
            MachineId = Env("LASER_MACHINE_ID", string.IsNullOrWhiteSpace(file.MachineId) ? Environment.MachineName : file.MachineId.Trim()),
        };
    }

    static string Env(string name, string fallback)
    {
        var value = Environment.GetEnvironmentVariable(name);
        return string.IsNullOrWhiteSpace(value) ? fallback : value;
    }
}

sealed class TeeWriter(TextWriter first, TextWriter second) : TextWriter
{
    public override Encoding Encoding => Encoding.UTF8;
    public override void Write(char value)
    {
        first.Write(value);
        second.Write(value);
    }
    public override void WriteLine(string? value)
    {
        var line = $"{DateTime.Now:yyyy-MM-dd HH:mm:ss} {value}";
        first.WriteLine(line);
        second.WriteLine(line);
    }
}

sealed record ActiveState(string? ProgramId, int? FinishMarks);
sealed record ProgramList(List<ProgramItem>? Programs = null);
sealed record ProgramItem(string ProgramId, string ProgramNumber, string Title, string Status, string FileName, string Sha256);
sealed record OutEvent(string EventId, string ProgramId, string Type, long At, int? Count = null, string? Detail = null, int? Sheet = null);
sealed record NestState(int? Current, int[] Done, int Total);
