using System.Diagnostics;

namespace HeraldOfJams.Launcher.Runtime;

public interface IBotProcess : IAsyncDisposable
{
    Task<BotExit> Completion { get; }
    Task WriteAsync(string value, CancellationToken token);
    Task<bool> WaitForExitAsync(TimeSpan timeout, CancellationToken token);
    void ForceTerminate();
}

public interface IBotProcessFactory { IBotProcess Start(BotStartOptions options); }

public sealed class BotProcessFactory(RotatingLogWriter logs) : IBotProcessFactory
{
    public IBotProcess Start(BotStartOptions options) => BotProcess.Start(options, logs);
}

public sealed class BotProcess : IBotProcess
{
    private readonly Process process;
    private readonly Task<BotExit> completion;

    private BotProcess(Process process, RotatingLogWriter logs)
    {
        this.process = process;
        completion = ObserveAsync(process, logs);
    }

    public Task<BotExit> Completion => completion;

    public static IBotProcess Start(BotStartOptions options, RotatingLogWriter logs)
    {
        var info = new ProcessStartInfo
        {
            FileName = Path.Combine(options.PackageDirectory, "runtime", "node.exe"),
            WorkingDirectory = Path.Combine(options.PackageDirectory, "app"),
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        info.ArgumentList.Add(Path.Combine(options.PackageDirectory, "app", "main.js"));
        info.ArgumentList.Add("--config");
        info.ArgumentList.Add(options.ConfigurationPath);
        info.ArgumentList.Add("--desktop");
        return new BotProcess(Process.Start(info) ?? throw new InvalidOperationException("Bot process could not start."), logs);
    }

    public async Task WriteAsync(string value, CancellationToken token)
    {
        await process.StandardInput.WriteAsync(value.AsMemory(), token);
        await process.StandardInput.FlushAsync(token);
    }

    public async Task<bool> WaitForExitAsync(TimeSpan timeout, CancellationToken token)
    {
        try { await process.WaitForExitAsync(token).WaitAsync(timeout, token); return true; }
        catch (TimeoutException) { return false; }
    }

    public void ForceTerminate() { if (!process.HasExited) process.Kill(entireProcessTree: true); }
    public ValueTask DisposeAsync() { process.Dispose(); return ValueTask.CompletedTask; }

    private static async Task<BotExit> ObserveAsync(Process process, RotatingLogWriter logs)
    {
        var stderr = new List<string>();
        var stdoutTask = PumpAsync(process.StandardOutput, "stdout", logs, null);
        var stderrTask = PumpAsync(process.StandardError, "stderr", logs, stderr);
        await process.WaitForExitAsync();
        await Task.WhenAll(stdoutTask, stderrTask);
        var safe = string.Join('\n', stderr);
        var kind = safe.Contains("Invalid configuration", StringComparison.Ordinal) ? BotFailureKind.Configuration
            : safe.Contains("EADDRINUSE", StringComparison.Ordinal) ? BotFailureKind.AddressInUse
            : process.ExitCode == 0 ? BotFailureKind.None : BotFailureKind.Unexpected;
        return new BotExit(process.ExitCode, kind);
    }

    private static async Task PumpAsync(StreamReader reader, string stream, RotatingLogWriter logs, List<string>? capture)
    {
        while (await reader.ReadLineAsync() is { } line)
        {
            capture?.Add(line);
            await logs.WriteAsync(stream, line);
        }
    }
}
