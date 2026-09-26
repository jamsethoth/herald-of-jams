using System.Globalization;
using System.Text;

namespace HeraldOfJams.Launcher.Configuration;

public static class EnvFileSerializer
{
    public static string Serialize(ValidatedSetup setup, GeneratedCredentials credentials)
    {
        ArgumentNullException.ThrowIfNull(setup);
        ArgumentNullException.ThrowIfNull(credentials);
        Safe(setup.DiscordToken, "DiscordToken");
        Safe(setup.ApplicationId, "ApplicationId");
        Safe(setup.GuildId, "GuildId");
        Safe(credentials.PasswordHash, "PasswordHash");
        Safe(credentials.SessionSecret, "SessionSecret");
        if (setup.AdminPort is < 1 or > 65535) throw new ArgumentException("AdminPort is invalid.");

        var lines = new[]
        {
            "NODE_ENV=production",
            $"DISCORD_TOKEN={setup.DiscordToken}",
            $"DISCORD_APPLICATION_ID={setup.ApplicationId}",
            $"DISCORD_GUILD_ID={setup.GuildId}",
            "ADMIN_HOST=127.0.0.1",
            $"ADMIN_PORT={setup.AdminPort.ToString(CultureInfo.InvariantCulture)}",
            $"ADMIN_PASSWORD_HASH={credentials.PasswordHash}",
            $"SESSION_SECRET={credentials.SessionSecret}",
            "ADMIN_SECURE_COOKIE=false",
            "TRUST_PROXY=false",
        };
        return string.Join('\n', lines) + "\n";
    }

    private static void Safe(string value, string field)
    {
        if (string.IsNullOrEmpty(value) || value.IndexOfAny(['\r', '\n', '\0', '"']) >= 0)
        {
            throw new ArgumentException($"{field} cannot be serialized safely.", field);
        }
    }
}
