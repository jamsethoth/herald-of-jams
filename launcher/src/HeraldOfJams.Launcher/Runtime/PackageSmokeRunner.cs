using System.Diagnostics;
using System.Security.Cryptography;

namespace HeraldOfJams.Launcher.Runtime;

public interface IPackageNodeRunner { Task<int> RunAsync(string packageDirectory, string dataDirectory, CancellationToken token); }

internal sealed class PackageNodeRunner : IPackageNodeRunner
{
    public async Task<int> RunAsync(string packageDirectory, string dataDirectory, CancellationToken token)
    {
        var info = new ProcessStartInfo
        {
            FileName = Path.Combine(packageDirectory, "runtime", "node.exe"),
            WorkingDirectory = Path.Combine(packageDirectory, "app"),
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        info.ArgumentList.Add(Path.Combine(packageDirectory, "app", "main.js"));
        info.ArgumentList.Add("--smoke-test");
        info.ArgumentList.Add("--data-dir");
        info.ArgumentList.Add(dataDirectory);
        using var process = Process.Start(info) ?? throw new InvalidOperationException("Package smoke process could not start.");
        await process.WaitForExitAsync(token);
        return process.ExitCode;
    }
}

public sealed class PackageSmokeRunner(string packageDirectory, IPackageNodeRunner? nodeRunner = null)
{
    private readonly IPackageNodeRunner nodeRunner = nodeRunner ?? new PackageNodeRunner();

    public async Task RunAsync(string dataDirectory, CancellationToken token)
    {
        foreach (var relative in new[] { "runtime/node.exe", "app/main.js", "LICENSE", "VERSION" })
            if (!File.Exists(Path.Combine(packageDirectory, relative))) throw new InvalidDataException("Package is missing a required file.");
        var before = Manifest();
        if (Directory.Exists(dataDirectory) || File.Exists(dataDirectory))
            throw new IOException("Smoke data directory must not already exist.");
        Directory.CreateDirectory(dataDirectory);
        try
        {
            if (await nodeRunner.RunAsync(packageDirectory, dataDirectory, token) != 0) throw new InvalidOperationException("Packaged Node smoke test failed.");
            if (!before.SequenceEqual(Manifest())) throw new InvalidDataException("Package tree changed during smoke test.");
        }
        finally { if (Directory.Exists(dataDirectory)) Directory.Delete(dataDirectory, recursive: true); }
    }

    private string[] Manifest() => Directory.GetFiles(packageDirectory, "*", SearchOption.AllDirectories)
        .Where(path => !path.StartsWith(Path.Combine(packageDirectory, ".smoke-data"), StringComparison.OrdinalIgnoreCase))
        .Select(path => $"{Path.GetRelativePath(packageDirectory, path)}:{Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path)))}")
        .Order(StringComparer.Ordinal).ToArray();
}
