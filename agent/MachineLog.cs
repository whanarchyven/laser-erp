using System.Text.RegularExpressions;

enum LogKind { Other, Start, Estimate, Finish, Alarm, AlarmRemoved, Transition }

sealed record LogEntry(string Line, string Text, LogKind Kind, string? From = null, string? To = null);

// CypCut log lines look like "(10/15 12:21:17)Production ends! Spend time: 38.408s".
static class MachineLog
{
    static readonly Regex Stamped = new(@"^\((\d{1,2}[./-]\d{1,2} \d{1,2}:\d{2}:\d{2})\)\s*(.*)$");
    static readonly Regex Transition = new(@"^([A-Za-z][A-Za-z ]*?)\s*-->\s*([A-Za-z][A-Za-z ]*?)\s*$");

    public static bool IsStamped(string line) => Stamped.IsMatch(line);

    public static LogEntry Parse(string line, IEnumerable<string> finishPatterns)
    {
        var match = Stamped.Match(line);
        var text = match.Success ? match.Groups[2].Value.Trim() : line.Trim();
        if (text.StartsWith("Alarm Remove", StringComparison.OrdinalIgnoreCase))
            return new(line, text, LogKind.AlarmRemoved, To: AlarmText(text));
        if (text.StartsWith("Alarm", StringComparison.OrdinalIgnoreCase))
            return new(line, text, LogKind.Alarm, To: AlarmText(text));
        if (finishPatterns.Any(p => p.Length > 0 && text.Contains(p, StringComparison.OrdinalIgnoreCase)))
            return new(line, text, LogKind.Finish);
        if (text.StartsWith("Start Processing", StringComparison.OrdinalIgnoreCase))
            return new(line, text, LogKind.Start);
        if (text.Contains("Total time (estimated)", StringComparison.OrdinalIgnoreCase))
            return new(line, text, LogKind.Estimate);
        var transition = Transition.Match(text);
        if (transition.Success)
            return new(line, text, LogKind.Transition, transition.Groups[1].Value, transition.Groups[2].Value);
        return new(line, text, LogKind.Other);
    }

    static string AlarmText(string text)
    {
        var colon = text.IndexOfAny([':', '：']);
        return (colon >= 0 ? text[(colon + 1)..] : text).Trim();
    }

    public static string? State(IReadOnlyList<LogEntry> entries) =>
        entries.LastOrDefault(e => e.Kind == LogKind.Transition)?.To;

    public static List<string> ActiveAlarms(IReadOnlyList<LogEntry> entries)
    {
        var active = new List<string>();
        foreach (var entry in entries)
        {
            if (entry.Kind == LogKind.Alarm && !active.Contains(entry.To!)) active.Add(entry.To!);
            if (entry.Kind == LogKind.AlarmRemoved) active.Remove(entry.To!);
        }
        return active;
    }

    // Index of the first entry not yet processed. -1 means "first look": everything is history.
    public static int NewFrom(IReadOnlyList<LogEntry> entries, string? cursor)
    {
        if (cursor is null) return -1;
        for (var i = entries.Count - 1; i >= 0; i--)
            if (entries[i].Line == cursor) return i + 1;
        return 0;
    }

    // Stable key of a line: the same text can repeat within one second.
    public static string Key(IReadOnlyList<LogEntry> entries, int index)
    {
        var repeat = 0;
        for (var i = 0; i < index; i++) if (entries[i].Line == entries[index].Line) repeat++;
        return $"log:{entries[index].Line}#{repeat}";
    }

    // "Working --> Stop" with no finish since the last start: the sheet was not cut to the end.
    public static bool IsInterrupted(IReadOnlyList<LogEntry> entries, int index, out List<string> alarms)
    {
        alarms = [];
        var entry = entries[index];
        if (entry.Kind != LogKind.Transition || !Is(entry.From, "Working") || !Is(entry.To, "Stop")) return false;
        for (var i = index - 1; i >= 0; i--)
        {
            var e = entries[i];
            if (e.Kind == LogKind.Finish) return false;
            if (e.Kind == LogKind.Alarm) alarms.Insert(0, e.Text);
            if (e.Kind == LogKind.Start) return true;
        }
        return false;
    }

    static bool Is(string? value, string expected) => string.Equals(value, expected, StringComparison.OrdinalIgnoreCase);
}
