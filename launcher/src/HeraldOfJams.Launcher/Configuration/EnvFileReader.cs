using System.Globalization;

namespace HeraldOfJams.Launcher.Configuration;

internal sealed record PreservedConfiguration(string DiscordToken, string PasswordHash, string SessionSecret);

public sealed class StoredConfiguration
{
    internal StoredConfiguration(string applicationId, string guildId, int adminPort, PreservedConfiguration preserved)
    {
        ApplicationId = applicationId;
        GuildId = guildId;
        AdminPort = adminPort;
        Preserved = preserved;
    }

    public string ApplicationId { get; }
    public string GuildId { get; }
    public int AdminPort { get; }
    internal PreservedConfiguration Preserved { get; }
}

public static class EnvFileReader
{
    public static StoredConfiguration Read(string path)
    {
        var values = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var line in File.ReadLines(path))
        {
            if (string.IsNullOrWhiteSpace(line) || line.TrimStart().StartsWith('#')) continue;
            var separator = line.IndexOf('=');
            if (separator <= 0) throw new InvalidDataException("Configuration contains a malformed line.");
            var key = line[..separator];
            if (KnownKeys.Contains(key)) values[key] = line[(separator + 1)..];
        }

        var portText = Required(values, "ADMIN_PORT");
        if (!int.TryParse(portText, NumberStyles.None, CultureInfo.InvariantCulture, out var port) || port is < 1 or > 65535)
        {
            throw new InvalidDataException("Configuration field ADMIN_PORT is invalid.");
        }
        return new StoredConfiguration(
            Required(values, "DISCORD_APPLICATION_ID"),
            Required(values, "DISCORD_GUILD_ID"),
            port,
            new PreservedConfiguration(
                Required(values, "DISCORD_TOKEN"),
                Required(values, "ADMIN_PASSWORD_HASH"),
                Required(values, "SESSION_SECRET")));
    }

    private static readonly HashSet<string> KnownKeys =
    [
        "DISCORD_TOKEN", "DISCORD_APPLICATION_ID", "DISCORD_GUILD_ID", "ADMIN_PORT",
        "ADMIN_PASSWORD_HASH", "SESSION_SECRET",
    ];

    private static string Required(IReadOnlyDictionary<string, string> values, string key) =>
        values.TryGetValue(key, out var value) && value.Length > 0
            ? value
            : throw new InvalidDataException($"Configuration field {key} is required.");
}
