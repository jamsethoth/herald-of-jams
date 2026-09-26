namespace HeraldOfJams.Launcher.Configuration;

public sealed record LauncherPaths(
    string DataDirectory,
    string ConfigurationFile,
    string DatabaseFile,
    string LogDirectory)
{
    public static LauncherPaths ForLocalApplicationData(string localApplicationData)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(localApplicationData);
        var root = Path.Combine(localApplicationData, "Herald of Jams");
        return new LauncherPaths(
            root,
            Path.Combine(root, "config.env"),
            Path.Combine(root, "herald-of-jams.sqlite"),
            Path.Combine(root, "logs"));
    }
}
