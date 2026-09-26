using HeraldOfJams.Launcher.Runtime;
using HeraldOfJams.Launcher.UI;

namespace HeraldOfJams.Launcher;

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        if (args is ["--smoke-test", "--data-dir", var dataDirectory])
        {
            try
            {
                new PackageSmokeRunner(AppContext.BaseDirectory).RunAsync(Path.GetFullPath(dataDirectory), CancellationToken.None).GetAwaiter().GetResult();
                Console.WriteLine("Herald of Jams package smoke test passed");
                return 0;
            }
            catch (Exception error)
            {
                Console.Error.WriteLine($"Herald of Jams package smoke test failed: {error.GetType().Name}");
                return 1;
            }
        }
        ApplicationConfiguration.Initialize();
        TrayApplicationContext? context = null;
        using var ready = new ManualResetEventSlim();
        var coordinator = new SingleInstanceCoordinator("HeraldOfJams", () =>
        {
            ready.Wait(TimeSpan.FromSeconds(5));
            context?.OpenAdministration();
            return Task.CompletedTask;
        });
        if (!coordinator.TryBecomePrimary())
        {
            coordinator.SignalOpenAdministrationAsync().GetAwaiter().GetResult();
            coordinator.DisposeAsync().AsTask().GetAwaiter().GetResult();
            return 0;
        }
        context = new TrayApplicationContext(AppContext.BaseDirectory);
        ready.Set();
        Application.Run(context);
        coordinator.DisposeAsync().AsTask().GetAwaiter().GetResult();
        return 0;
    }
}
