using HeraldOfJams.Launcher.Runtime;
using HeraldOfJams.Launcher.UI;

namespace HeraldOfJams.Launcher;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
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
            return;
        }
        context = new TrayApplicationContext(AppContext.BaseDirectory);
        ready.Set();
        Application.Run(context);
        coordinator.DisposeAsync().AsTask().GetAwaiter().GetResult();
    }
}
