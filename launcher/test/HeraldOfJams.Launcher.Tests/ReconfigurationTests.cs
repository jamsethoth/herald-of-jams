using HeraldOfJams.Launcher.Configuration;
using HeraldOfJams.Launcher.Runtime;
using Xunit;

namespace HeraldOfJams.Launcher.Tests;

public sealed class ReconfigurationTests
{
    [Fact]
    public async Task FailedCandidateRollsBackAndRestartsPreviousConfiguration()
    {
        var directory = Path.Combine(Path.GetTempPath(), $"herald-reconfigure-{Guid.NewGuid():N}");
        Directory.CreateDirectory(directory);
        try
        {
            var path = Path.Combine(directory, "config.env");
            await File.WriteAllTextAsync(path, "old bytes");
            var lifecycle = new FakeLifecycle(false, true);
            var coordinator = new ReconfigurationCoordinator(new AtomicConfigurationStore(path), new FakeCredentials(), lifecycle);
            var result = await coordinator.ApplyAsync(new SetupInput("token", "123", "456", "password", 3000), CancellationToken.None);
            Assert.True(result.RolledBack);
            Assert.True(result.Recovered);
            Assert.Equal("old bytes", await File.ReadAllTextAsync(path));
            Assert.Equal(2, lifecycle.Starts);
            Assert.Equal(["config.env"], Directory.GetFiles(directory).Select(Path.GetFileName));
        }
        finally { Directory.Delete(directory, recursive: true); }
    }

    private sealed class FakeCredentials : ICredentialGenerator
    {
        public Task<GeneratedCredentials> GenerateAsync(string password, CancellationToken cancellationToken) => Task.FromResult(new GeneratedCredentials("hash", "session-secret-with-at-least-32-bytes"));
    }

    private sealed class FakeLifecycle(params bool[] starts) : IBotLifecycle
    {
        private readonly Queue<bool> results = new(starts);
        public int Starts { get; private set; }
        public Task StopAsync(CancellationToken token = default) => Task.CompletedTask;
        public Task<bool> StartAsync(CancellationToken token = default) { Starts++; return Task.FromResult(results.Dequeue()); }
    }
}
