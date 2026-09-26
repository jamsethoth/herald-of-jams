using HeraldOfJams.Launcher.Runtime;
using Xunit;

namespace HeraldOfJams.Launcher.Tests;

public sealed class BotSupervisorTests
{
    [Fact]
    public async Task ReadyChildTransitionsFromStartingToRunningAndStopsGracefully()
    {
        var process = new FakeBotProcess();
        var supervisor = new BotSupervisor(new FakeFactory(process), new FakeHealthProbe("ready"), new BotStartOptions("package", "config.env", 3000));
        await supervisor.StartAsync();
        await WaitUntilAsync(() => supervisor.CurrentState == LauncherState.Running);
        await supervisor.StopAsync();
        Assert.Equal("shutdown\n", process.StandardInput);
        Assert.False(process.WasForced);
        Assert.Equal(LauncherState.Stopped, supervisor.CurrentState);
    }

    [Fact]
    public async Task DeterministicStartupFailureRequiresAttentionWithoutRetry()
    {
        var process = new FakeBotProcess();
        var factory = new FakeFactory(process);
        var supervisor = new BotSupervisor(factory, new FakeHealthProbe(null), new BotStartOptions("package", "config.env", 3000));
        await supervisor.StartAsync();
        process.Exit(new BotExit(1, BotFailureKind.AddressInUse));
        await WaitUntilAsync(() => supervisor.CurrentState == LauncherState.AttentionRequired);
        Assert.Equal(1, factory.Starts);
    }

    [Fact]
    public async Task UnexpectedExitsRetryAfterOneFiveAndFifteenSecondsThenStop()
    {
        var processes = Enumerable.Range(0, 4).Select(_ => new FakeBotProcess()).ToArray();
        foreach (var process in processes) process.Exit(new BotExit(1, BotFailureKind.Unexpected));
        var factory = new QueueFactory(processes);
        var delay = new RecordingDelay();
        var supervisor = new BotSupervisor(factory, new FakeHealthProbe(null), new BotStartOptions("package", "config.env", 3000), delay);
        await supervisor.StartAsync();
        await WaitUntilAsync(() => supervisor.CurrentState == LauncherState.AttentionRequired);
        Assert.Equal(4, factory.Starts);
        Assert.Equal([TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(5), TimeSpan.FromSeconds(15)], delay.Delays.Where(value => value >= TimeSpan.FromSeconds(1)));
    }

    [Fact]
    public async Task FiveMinutesOfUnavailableHealthKeepsOneChildAndRequiresAttention()
    {
        var process = new FakeBotProcess();
        var factory = new FakeFactory(process);
        var time = new AdvancingTime();
        var supervisor = new BotSupervisor(factory, new FakeHealthProbe(null), new BotStartOptions("package", "config.env", 3000), time, time);
        await supervisor.StartAsync();
        await WaitUntilAsync(() => supervisor.CurrentState == LauncherState.AttentionRequired);
        Assert.Equal(1, factory.Starts);
        Assert.False(process.WasForced);
        await supervisor.StopAsync();
    }

    private static async Task WaitUntilAsync(Func<bool> predicate)
    {
        for (var count = 0; count < 100 && !predicate(); count++) await Task.Delay(10);
        Assert.True(predicate());
    }

    private sealed class FakeFactory(FakeBotProcess process) : IBotProcessFactory
    {
        public int Starts { get; private set; }
        public IBotProcess Start(BotStartOptions options) { Starts++; return process; }
    }

    private sealed class QueueFactory(IEnumerable<FakeBotProcess> processes) : IBotProcessFactory
    {
        private readonly Queue<FakeBotProcess> queue = new(processes);
        public int Starts { get; private set; }
        public IBotProcess Start(BotStartOptions options) { Starts++; return queue.Dequeue(); }
    }

    private sealed class RecordingDelay : IAsyncDelay
    {
        public List<TimeSpan> Delays { get; } = [];
        public Task DelayAsync(TimeSpan delay, CancellationToken token) { Delays.Add(delay); return Task.CompletedTask; }
    }

    private sealed class AdvancingTime : IAsyncDelay, ILauncherClock
    {
        public DateTimeOffset UtcNow { get; private set; } = DateTimeOffset.UnixEpoch;
        public Task DelayAsync(TimeSpan delay, CancellationToken token) { UtcNow += TimeSpan.FromMinutes(1); return Task.CompletedTask; }
    }

    private sealed class FakeHealthProbe(string? status) : IBotHealthProbe
    {
        public Task<string?> ProbeAsync(int port, CancellationToken token) => Task.FromResult(status);
    }

    private sealed class FakeBotProcess : IBotProcess
    {
        private readonly TaskCompletionSource<BotExit> completion = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public Task<BotExit> Completion => completion.Task;
        public string StandardInput { get; private set; } = "";
        public bool WasForced { get; private set; }
        public Task WriteAsync(string value, CancellationToken token) { StandardInput += value; completion.TrySetResult(new BotExit(0, BotFailureKind.None)); return Task.CompletedTask; }
        public async Task<bool> WaitForExitAsync(TimeSpan timeout, CancellationToken token) { await Completion.WaitAsync(timeout, token); return true; }
        public void ForceTerminate() => WasForced = true;
        public void Exit(BotExit exit) => completion.TrySetResult(exit);
        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }
}
