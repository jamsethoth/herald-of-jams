using System.Diagnostics;

namespace HeraldOfJams.Launcher.Runtime;

public static class AdministrationLauncher
{
    public static bool CanOpen(LauncherState state) => state == LauncherState.Running;

    public static Uri BuildUri(int port)
    {
        if (port is < 1 or > 65535) throw new ArgumentOutOfRangeException(nameof(port));
        return new Uri($"http://127.0.0.1:{port}/admin");
    }

    public static void Open(int port) => Process.Start(new ProcessStartInfo(BuildUri(port).AbsoluteUri) { UseShellExecute = true });
}
