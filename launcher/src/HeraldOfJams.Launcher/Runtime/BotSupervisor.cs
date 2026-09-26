namespace HeraldOfJams.Launcher.Runtime;

public interface IAsyncDelay { Task DelayAsync(TimeSpan delay, CancellationToken token); }
internal sealed class SystemAsyncDelay : IAsyncDelay { public Task DelayAsync(TimeSpan delay, CancellationToken token) => Task.Delay(delay, token); }
public interface ILauncherClock { DateTimeOffset UtcNow { get; } }
internal sealed class SystemLauncherClock : ILauncherClock { public DateTimeOffset UtcNow => DateTimeOffset.UtcNow; }

public sealed class BotSupervisor(IBotProcessFactory factory, IBotHealthProbe health, BotStartOptions options, IAsyncDelay? delay = null, ILauncherClock? clock = null) : IBotLifecycle, IAsyncDisposable
{
    private readonly SemaphoreSlim gate = new(1, 1);
    private CancellationTokenSource? monitorCancellation;
    private IBotProcess? process;
    private bool intentionalStop;
    private TaskCompletionSource<bool>? startupCompletion;
    private readonly IAsyncDelay delay = delay ?? new SystemAsyncDelay();
    private readonly ILauncherClock clock = clock ?? new SystemLauncherClock();

    public LauncherState CurrentState { get; private set; } = LauncherState.Stopped;
    public event EventHandler<LauncherState>? StateChanged;

    public async Task<bool> StartAsync(CancellationToken token = default)
    {
        Task<bool> startup;
        await gate.WaitAsync(token);
        try
        {
            if (process is not null) return CurrentState == LauncherState.Running;
            intentionalStop = false;
            SetState(LauncherState.Starting);
            process = factory.Start(options);
            startupCompletion = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            startup = startupCompletion.Task;
            monitorCancellation = new CancellationTokenSource();
            _ = MonitorAsync(process, monitorCancellation.Token);
        }
        finally { gate.Release(); }
        return await startup.WaitAsync(token);
    }

    public async Task RestartAsync(CancellationToken token = default) { await StopAsync(token); await StartAsync(token); }

    public async Task StopAsync(CancellationToken token = default)
    {
        await gate.WaitAsync(token);
        try
        {
            if (process is null) { SetState(LauncherState.Stopped); return; }
            intentionalStop = true;
            startupCompletion?.TrySetResult(false);
            monitorCancellation?.Cancel();
            SetState(LauncherState.Stopping);
            await process.WriteAsync("shutdown\n", token);
            if (!await process.WaitForExitAsync(TimeSpan.FromSeconds(15), token)) process.ForceTerminate();
            await process.DisposeAsync();
            process = null;
            SetState(LauncherState.Stopped);
        }
        finally { gate.Release(); }
    }

    private async Task MonitorAsync(IBotProcess observed, CancellationToken token)
    {
        var unavailableSince = clock.UtcNow;
        var healthySince = (DateTimeOffset?)null;
        var restartCount = 0;
        var restartDelays = new[] { TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(5), TimeSpan.FromSeconds(15) };
        try
        {
            while (!token.IsCancellationRequested)
            {
                if (observed.Completion.IsCompleted)
                {
                    var exit = await observed.Completion;
                    if (intentionalStop) return;
                    await observed.DisposeAsync();
                    if (exit.FailureKind is BotFailureKind.Configuration or BotFailureKind.AddressInUse)
                    {
                        if (ReferenceEquals(process, observed)) process = null;
                        startupCompletion?.TrySetResult(false);
                        SetState(LauncherState.AttentionRequired);
                        return;
                    }
                    if (restartCount >= restartDelays.Length)
                    {
                        if (ReferenceEquals(process, observed)) process = null;
                        startupCompletion?.TrySetResult(false);
                        SetState(LauncherState.AttentionRequired);
                        return;
                    }
                    await delay.DelayAsync(restartDelays[restartCount], token);
                    restartCount++;
                    observed = factory.Start(options);
                    process = observed;
                    unavailableSince = clock.UtcNow;
                    healthySince = null;
                    SetState(LauncherState.Starting);
                    continue;
                }
                var status = await health.ProbeAsync(options.AdminPort, token);
                if (status == "ready")
                {
                    startupCompletion?.TrySetResult(true);
                    SetState(LauncherState.Running);
                    healthySince ??= clock.UtcNow;
                    if (clock.UtcNow - healthySince >= TimeSpan.FromMinutes(5)) restartCount = 0;
                    unavailableSince = clock.UtcNow;
                }
                else if (status == "degraded") { startupCompletion?.TrySetResult(false); SetState(LauncherState.AttentionRequired); }
                else if (clock.UtcNow - unavailableSince >= TimeSpan.FromMinutes(5)) { startupCompletion?.TrySetResult(false); SetState(LauncherState.AttentionRequired); }
                await delay.DelayAsync(TimeSpan.FromMilliseconds(500), token);
            }
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { }
    }

    private void SetState(LauncherState state)
    {
        if (CurrentState == state) return;
        CurrentState = state;
        StateChanged?.Invoke(this, state);
    }

    public async ValueTask DisposeAsync() { await StopAsync(); gate.Dispose(); monitorCancellation?.Dispose(); }
}
