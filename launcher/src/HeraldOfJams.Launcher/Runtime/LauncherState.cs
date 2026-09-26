namespace HeraldOfJams.Launcher.Runtime;

public enum LauncherState { Stopped, Starting, Running, AttentionRequired, Stopping }
public enum BotFailureKind { None, Configuration, AddressInUse, Unexpected }
public sealed record BotExit(int ExitCode, BotFailureKind FailureKind);
public sealed record BotStartOptions(string PackageDirectory, string ConfigurationPath, int AdminPort);

public interface IBotLifecycle
{
    Task<bool> StartAsync(CancellationToken token = default);
    Task StopAsync(CancellationToken token = default);
}
