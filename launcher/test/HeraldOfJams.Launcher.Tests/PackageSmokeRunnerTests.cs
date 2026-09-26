using HeraldOfJams.Launcher.Runtime;
using Xunit;

namespace HeraldOfJams.Launcher.Tests;

public sealed class PackageSmokeRunnerTests
{
    [Fact]
    public async Task RejectsMissingFilesNonzeroExitAndPackageMutation()
    {
        using var package = new TemporaryPackage();
        File.Delete(Path.Combine(package.Path, "runtime", "node.exe"));
        await Assert.ThrowsAsync<InvalidDataException>(() => new PackageSmokeRunner(package.Path, new FakeRunner(0)).RunAsync(Path.Combine(package.Path, "data"), CancellationToken.None));
        File.WriteAllText(Path.Combine(package.Path, "runtime", "node.exe"), "node");
        await Assert.ThrowsAsync<InvalidOperationException>(() => new PackageSmokeRunner(package.Path, new FakeRunner(1)).RunAsync(Path.Combine(package.Path, "data"), CancellationToken.None));
        await Assert.ThrowsAsync<InvalidDataException>(() => new PackageSmokeRunner(package.Path, new FakeRunner(0, package.Path)).RunAsync(Path.Combine(package.Path, "data"), CancellationToken.None));
    }

    private sealed class FakeRunner(int exitCode, string? mutate = null) : IPackageNodeRunner
    {
        public Task<int> RunAsync(string packageDirectory, string dataDirectory, CancellationToken token)
        {
            if (mutate is not null) File.WriteAllText(Path.Combine(mutate, "app", "changed"), "x");
            return Task.FromResult(exitCode);
        }
    }

    private sealed class TemporaryPackage : IDisposable
    {
        public TemporaryPackage()
        {
            Path = System.IO.Path.Combine(System.IO.Path.GetTempPath(), $"herald-package-{Guid.NewGuid():N}");
            Directory.CreateDirectory(System.IO.Path.Combine(Path, "runtime"));
            Directory.CreateDirectory(System.IO.Path.Combine(Path, "app", "assets"));
            File.WriteAllText(System.IO.Path.Combine(Path, "runtime", "node.exe"), "node");
            File.WriteAllText(System.IO.Path.Combine(Path, "app", "main.js"), "main");
            File.WriteAllText(System.IO.Path.Combine(Path, "LICENSE"), "license");
            File.WriteAllText(System.IO.Path.Combine(Path, "VERSION"), "version");
        }
        public string Path { get; }
        public void Dispose() => Directory.Delete(Path, recursive: true);
    }
}
