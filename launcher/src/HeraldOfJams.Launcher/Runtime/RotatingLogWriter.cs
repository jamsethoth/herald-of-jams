using System.Text;

namespace HeraldOfJams.Launcher.Runtime;

public sealed class RotatingLogWriter : IAsyncDisposable
{
    private readonly string directory;
    private readonly string[] secrets;
    private readonly long maximumBytes;
    private readonly int maximumFiles;
    private readonly SemaphoreSlim gate = new(1, 1);
    private StreamWriter writer;

    public RotatingLogWriter(string directory, IEnumerable<string> secrets, long maximumBytes = 5 * 1024 * 1024, int maximumFiles = 5)
    {
        this.directory = directory;
        this.secrets = secrets.Where(value => !string.IsNullOrEmpty(value)).Distinct(StringComparer.Ordinal).ToArray();
        this.maximumBytes = maximumBytes;
        this.maximumFiles = maximumFiles;
        Directory.CreateDirectory(directory);
        writer = Open();
    }

    public async Task WriteAsync(string stream, string message)
    {
        await gate.WaitAsync();
        try
        {
            var safe = secrets.Aggregate(message, (current, secret) => current.Replace(secret, "[REDACTED]", StringComparison.Ordinal));
            var line = $"{DateTimeOffset.UtcNow:O} [{stream}] {safe}{Environment.NewLine}";
            if (writer.BaseStream.Length + Encoding.UTF8.GetByteCount(line) > maximumBytes) Rotate();
            await writer.WriteAsync(line);
            await writer.FlushAsync();
        }
        finally { gate.Release(); }
    }

    public Task FlushAsync() => writer.FlushAsync();

    private StreamWriter Open() => new(new FileStream(Path.Combine(directory, "herald.log"), FileMode.Append, FileAccess.Write, FileShare.Read), new UTF8Encoding(false));
    private void Rotate()
    {
        writer.Dispose();
        File.Delete(Path.Combine(directory, $"herald.{maximumFiles - 1}.log"));
        for (var index = maximumFiles - 2; index >= 1; index--)
        {
            var source = Path.Combine(directory, $"herald.{index}.log");
            if (File.Exists(source)) File.Move(source, Path.Combine(directory, $"herald.{index + 1}.log"));
        }
        var active = Path.Combine(directory, "herald.log");
        if (File.Exists(active)) File.Move(active, Path.Combine(directory, "herald.1.log"), overwrite: true);
        writer = Open();
    }

    public async ValueTask DisposeAsync() { await gate.WaitAsync(); writer.Dispose(); gate.Release(); gate.Dispose(); }
}
