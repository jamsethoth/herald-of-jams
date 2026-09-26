namespace HeraldOfJams.Launcher.Configuration;

public sealed record SetupInput(
    string DiscordToken,
    string ApplicationId,
    string GuildId,
    string AdminPassword,
    int AdminPort);

public sealed record ValidatedSetup(
    string DiscordToken,
    string ApplicationId,
    string GuildId,
    int AdminPort);

public sealed record GeneratedCredentials(string PasswordHash, string SessionSecret);

public sealed record ValidationIssue(string Field, string Message);
