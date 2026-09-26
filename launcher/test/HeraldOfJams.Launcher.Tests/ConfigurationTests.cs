using System.Reflection;
using HeraldOfJams.Launcher.Configuration;
using Xunit;

namespace HeraldOfJams.Launcher.Tests;

public sealed class ConfigurationTests
{
    [Fact]
    public void LocalApplicationDataPathsAreStable()
    {
        var paths = LauncherPaths.ForLocalApplicationData(@"C:\Users\James\AppData\Local");
        var root = @"C:\Users\James\AppData\Local\Herald of Jams";
        Assert.Equal(root, paths.DataDirectory);
        Assert.Equal(Path.Combine(root, "config.env"), paths.ConfigurationFile);
        Assert.Equal(Path.Combine(root, "herald-of-jams.sqlite"), paths.DatabaseFile);
        Assert.Equal(Path.Combine(root, "logs"), paths.LogDirectory);
    }

    [Theory]
    [InlineData("", "123", "456", "password", 3000, "DiscordToken")]
    [InlineData("token", "app", "456", "password", 3000, "ApplicationId")]
    [InlineData("token", "123", "guild", "password", 3000, "GuildId")]
    [InlineData("token", "123", "456", "", 3000, "AdminPassword")]
    [InlineData("token", "123", "456", "password", 0, "AdminPort")]
    [InlineData("token", "123", "456", "password", 65536, "AdminPort")]
    public void SetupValidationNamesFieldsWithoutEchoingRejectedValues(string token, string applicationId, string guildId, string password, int port, string field)
    {
        var issues = SetupValidator.Validate(new SetupInput(token, applicationId, guildId, password, port));
        Assert.Contains(issues, issue => issue.Field == field);
        Assert.DoesNotContain(issues, issue => token.Length > 0 && issue.Message.Contains(token, StringComparison.Ordinal));
    }

    [Theory]
    [InlineData("line\rbreak")]
    [InlineData("line\nbreak")]
    [InlineData("nul\0break")]
    [InlineData("quoted\"value")]
    public void SetupValidationRejectsEnvFileControlCharacters(string unsafeValue)
    {
        var input = new SetupInput(unsafeValue, "123", "456", "password", 3000);
        Assert.Contains(SetupValidator.Validate(input), issue => issue.Field == "DiscordToken");
    }

    [Fact]
    public void SerializerRoundTripsDollarSignsAndBase64PaddingWithoutDatabaseOverride()
    {
        var setup = new ValidatedSetup("token", "123", "456", 4321);
        var credentials = new GeneratedCredentials("scrypt$16384$8$1$salt==$hash==", "c2Vzc2lvbg==");
        var text = EnvFileSerializer.Serialize(setup, credentials);
        using var directory = new TemporaryDirectory();
        var path = Path.Combine(directory.Path, "config.env");
        File.WriteAllText(path, text);
        var stored = EnvFileReader.Read(path);
        Assert.Equal("123", stored.ApplicationId);
        Assert.Equal("456", stored.GuildId);
        Assert.Equal(4321, stored.AdminPort);
        Assert.Contains("ADMIN_PASSWORD_HASH=scrypt$16384$8$1$salt==$hash==", text);
        Assert.Contains("SESSION_SECRET=c2Vzc2lvbg==", text);
        Assert.DoesNotContain("DATABASE_PATH", text);
    }

    [Fact]
    public void ReaderDoesNotExposeSecretsThroughPublicSetupProperties()
    {
        using var directory = new TemporaryDirectory();
        var path = Path.Combine(directory.Path, "config.env");
        File.WriteAllText(path, EnvFileSerializer.Serialize(new ValidatedSetup("private-token", "123", "456", 3000), new GeneratedCredentials("private-hash", "private-session-secret")));
        var stored = EnvFileReader.Read(path);
        var properties = typeof(StoredConfiguration).GetProperties(BindingFlags.Public | BindingFlags.Instance);
        var values = properties.Select(property => property.GetValue(stored)?.ToString()).ToArray();
        Assert.DoesNotContain(properties, property => property.Name.Contains("Token", StringComparison.OrdinalIgnoreCase) || property.Name.Contains("Hash", StringComparison.OrdinalIgnoreCase) || property.Name.Contains("Secret", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain("private-token", values);
        Assert.DoesNotContain("private-hash", values);
        Assert.DoesNotContain("private-session-secret", values);
    }

    [Fact]
    public async Task CandidateActivationCommitAndRollbackAreAtomic()
    {
        using var directory = new TemporaryDirectory();
        var active = Path.Combine(directory.Path, "config.env");
        await File.WriteAllTextAsync(active, "old bytes");
        var store = new AtomicConfigurationStore(active);
        var committed = await store.StageAsync("new bytes");
        Assert.Equal("old bytes", await File.ReadAllTextAsync(active));
        committed.Activate();
        Assert.Equal("new bytes", await File.ReadAllTextAsync(active));
        committed.Commit();
        Assert.Equal(["config.env"], Directory.GetFiles(directory.Path).Select(Path.GetFileName));
        var rolledBack = await store.StageAsync("candidate bytes");
        rolledBack.Activate();
        rolledBack.Rollback();
        Assert.Equal("new bytes", await File.ReadAllTextAsync(active));
        Assert.Equal(["config.env"], Directory.GetFiles(directory.Path).Select(Path.GetFileName));
    }

    [Fact]
    public async Task FailedReplacementLeavesActiveConfigurationByteIdentical()
    {
        using var directory = new TemporaryDirectory();
        var active = Path.Combine(directory.Path, "config.env");
        var original = new byte[] { 0, 1, 2, 3, 255 };
        await File.WriteAllBytesAsync(active, original);
        var candidate = await new AtomicConfigurationStore(active, new FailingActivator()).StageAsync("replacement");
        Assert.Throws<IOException>(() => candidate.Activate());
        Assert.Equal(original, await File.ReadAllBytesAsync(active));
        Assert.Equal(["config.env"], Directory.GetFiles(directory.Path).Select(Path.GetFileName));
    }

    private sealed class FailingActivator : IConfigurationActivator
    {
        public void Replace(string candidatePath, string activePath) => throw new IOException("simulated replacement failure");
    }

    private sealed class TemporaryDirectory : IDisposable
    {
        public TemporaryDirectory()
        {
            Path = System.IO.Path.Combine(System.IO.Path.GetTempPath(), $"herald-launcher-{Guid.NewGuid():N}");
            Directory.CreateDirectory(Path);
        }

        public string Path { get; }
        public void Dispose() => Directory.Delete(Path, recursive: true);
    }
}
