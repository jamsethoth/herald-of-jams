using System.Diagnostics;
using HeraldOfJams.Launcher.Configuration;
using HeraldOfJams.Launcher.Runtime;

namespace HeraldOfJams.Launcher.UI;

public sealed class TrayApplicationContext : ApplicationContext
{
    private readonly string packageDirectory;
    private readonly LauncherPaths paths;
    private readonly SynchronizationContext ui = SynchronizationContext.Current ?? new WindowsFormsSynchronizationContext();
    private readonly NotifyIcon tray = new() { Icon = SystemIcons.Application, Text = "Herald of Jams — Starting", Visible = true };
    private readonly ToolStripMenuItem openAdministration = new("Open administration");
    private BotSupervisor? supervisor;
    private RotatingLogWriter? logs;
    private StoredConfiguration? stored;
    private bool initialized;

    public TrayApplicationContext(string packageDirectory)
    {
        this.packageDirectory = packageDirectory;
        paths = LauncherPaths.ForLocalApplicationData(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData));
        Directory.CreateDirectory(paths.DataDirectory);
        Directory.CreateDirectory(paths.LogDirectory);
        var menu = new ContextMenuStrip();
        menu.Items.Add(openAdministration);
        menu.Items.Add("Configure", null, async (_, _) => await ConfigureAsync());
        menu.Items.Add("Open data folder", null, (_, _) => OpenFolder(paths.DataDirectory));
        menu.Items.Add("Open logs", null, (_, _) => OpenFolder(paths.LogDirectory));
        menu.Items.Add("Restart bot", null, async (_, _) => { if (supervisor is not null) await supervisor.RestartAsync(); });
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Exit", null, async (_, _) => await ExitAsync());
        openAdministration.Click += (_, _) => OpenAdministration();
        tray.DoubleClick += (_, _) => OpenAdministration();
        tray.ContextMenuStrip = menu;
        Application.Idle += InitializeOnce;
    }

    private async void InitializeOnce(object? sender, EventArgs args)
    {
        if (initialized) return;
        initialized = true;
        Application.Idle -= InitializeOnce;
        try
        {
            if (File.Exists(paths.ConfigurationFile))
            {
                try { stored = EnvFileReader.Read(paths.ConfigurationFile); }
                catch (Exception) { stored = null; }
            }
            if (stored is null && !await ShowSetupAsync()) { await ExitAsync(); return; }
            await StartRuntimeAsync();
        }
        catch (Exception) { ApplyState(LauncherState.AttentionRequired); }
    }

    private async Task<bool> StartRuntimeAsync()
    {
        stored = EnvFileReader.Read(paths.ConfigurationFile);
        logs = new RotatingLogWriter(paths.LogDirectory, [stored.Preserved.DiscordToken, stored.Preserved.PasswordHash, stored.Preserved.SessionSecret]);
        supervisor = new BotSupervisor(new BotProcessFactory(logs), new BotHealthProbe(new HttpClient()), new BotStartOptions(packageDirectory, paths.ConfigurationFile, stored.AdminPort));
        supervisor.StateChanged += (_, state) => ui.Post(_ => ApplyState(state), null);
        var started = await supervisor.StartAsync();
        ApplyState(supervisor.CurrentState);
        return started;
    }

    private async Task<bool> ShowSetupAsync()
    {
        using var form = new SetupForm(stored);
        if (form.ShowDialog() != DialogResult.OK || form.Result is null) return false;
        var input = form.Result;
        var token = string.IsNullOrEmpty(input.DiscordToken) ? stored?.Preserved.DiscordToken : input.DiscordToken;
        if (token is null) return false;
        GeneratedCredentials generated;
        if (string.IsNullOrEmpty(input.AdminPassword))
        {
            if (stored is null) return false;
            generated = new GeneratedCredentials(stored.Preserved.PasswordHash, stored.Preserved.SessionSecret);
        }
        else generated = await new CredentialGenerator(packageDirectory).GenerateAsync(input.AdminPassword, CancellationToken.None);
        var contents = EnvFileSerializer.Serialize(new ValidatedSetup(token, input.ApplicationId, input.GuildId, input.AdminPort), generated);
        var candidate = await new AtomicConfigurationStore(paths.ConfigurationFile).StageAsync(contents);
        candidate.Activate();
        candidate.Commit();
        stored = EnvFileReader.Read(paths.ConfigurationFile);
        return true;
    }

    private async Task ConfigureAsync()
    {
        if (stored is null) return;
        using var form = new SetupForm(stored);
        if (form.ShowDialog() != DialogResult.OK || form.Result is null) return;
        var input = form.Result;
        var token = string.IsNullOrEmpty(input.DiscordToken) ? stored.Preserved.DiscordToken : input.DiscordToken;
        ICredentialGenerator generator;
        var password = input.AdminPassword;
        if (string.IsNullOrEmpty(password))
        {
            generator = new FixedCredentialGenerator(new GeneratedCredentials(stored.Preserved.PasswordHash, stored.Preserved.SessionSecret));
            password = "preserved-password";
        }
        else generator = new CredentialGenerator(packageDirectory);
        var normalized = input with { DiscordToken = token, AdminPassword = password };
        var result = await new ReconfigurationCoordinator(new AtomicConfigurationStore(paths.ConfigurationFile), generator, new TrayLifecycle(this)).ApplyAsync(normalized, CancellationToken.None);
        stored = EnvFileReader.Read(paths.ConfigurationFile);
        if (!result.Success)
            MessageBox.Show(result.Recovered ? "The new configuration failed. The previous configuration was restored." : "Configuration failed and requires attention.", "Herald of Jams", MessageBoxButtons.OK, MessageBoxIcon.Warning);
    }

    public void OpenAdministration()
    {
        ui.Post(_ =>
        {
            if (supervisor is not null && stored is not null && AdministrationLauncher.CanOpen(supervisor.CurrentState))
                AdministrationLauncher.Open(stored.AdminPort);
        }, null);
    }

    private void ApplyState(LauncherState state)
    {
        tray.Text = state switch
        {
            LauncherState.Running => "Herald of Jams — Running",
            LauncherState.AttentionRequired => "Herald of Jams — Attention required",
            LauncherState.Stopped => "Herald of Jams — Stopped",
            LauncherState.Stopping => "Herald of Jams — Stopping",
            _ => "Herald of Jams — Starting",
        };
        openAdministration.Enabled = AdministrationLauncher.CanOpen(state);
    }

    private async Task ExitAsync()
    {
        if (supervisor is not null) await supervisor.DisposeAsync();
        if (logs is not null) await logs.DisposeAsync();
        tray.Visible = false;
        tray.Dispose();
        ExitThread();
    }

    private async Task StopRuntimeAsync()
    {
        if (supervisor is not null) { await supervisor.DisposeAsync(); supervisor = null; }
        if (logs is not null) { await logs.DisposeAsync(); logs = null; }
    }

    private sealed class TrayLifecycle(TrayApplicationContext owner) : IBotLifecycle
    {
        public Task<bool> StartAsync(CancellationToken token = default) => owner.StartRuntimeAsync();
        public Task StopAsync(CancellationToken token = default) => owner.StopRuntimeAsync();
    }

    private sealed class FixedCredentialGenerator(GeneratedCredentials credentials) : ICredentialGenerator
    {
        public Task<GeneratedCredentials> GenerateAsync(string password, CancellationToken cancellationToken) => Task.FromResult(credentials);
    }

    private static void OpenFolder(string path)
    {
        var info = new ProcessStartInfo("explorer.exe") { UseShellExecute = true };
        info.ArgumentList.Add(path);
        Process.Start(info);
    }
}
