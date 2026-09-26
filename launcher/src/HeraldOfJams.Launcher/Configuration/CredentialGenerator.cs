using System.Diagnostics;
using System.Text;
using System.Text.Json;

namespace HeraldOfJams.Launcher.Configuration;

public interface ICredentialGenerator
{
    Task<GeneratedCredentials> GenerateAsync(string password, CancellationToken cancellationToken);
}

public sealed class CredentialGenerator(string packageDirectory) : ICredentialGenerator
{
    private const int MaximumOutputCharacters = 64 * 1024;

    public async Task<GeneratedCredentials> GenerateAsync(string password, CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrEmpty(password);
        var startInfo = new ProcessStartInfo
        {
            FileName = Path.Combine(packageDirectory, "runtime", "node.exe"),
            WorkingDirectory = Path.Combine(packageDirectory, "app"),
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        startInfo.ArgumentList.Add(Path.Combine(packageDirectory, "app", "runtime", "setup-credentials.js"));
        using var process = Process.Start(startInfo) ?? throw new InvalidOperationException("Credential helper could not start.");
        try
        {
            await process.StandardInput.WriteAsync(password.AsMemory(), cancellationToken);
            await process.StandardInput.FlushAsync(cancellationToken);
            process.StandardInput.Close();
            var stdoutTask = ReadBoundedAsync(process.StandardOutput, MaximumOutputCharacters, cancellationToken);
            var stderrTask = ReadBoundedAsync(process.StandardError, 4096, cancellationToken);
            await process.WaitForExitAsync(cancellationToken);
            var stdout = await stdoutTask;
            var stderr = await stderrTask;
            if (process.ExitCode != 0 || stderr.Length != 0) throw new InvalidOperationException("Credential helper failed.");
            return Parse(stdout);
        }
        catch (OperationCanceledException)
        {
            if (!process.HasExited) process.Kill(entireProcessTree: true);
            throw;
        }
    }

    private static GeneratedCredentials Parse(string output)
    {
        using var document = JsonDocument.Parse(output);
        var root = document.RootElement;
        if (root.ValueKind != JsonValueKind.Object || root.EnumerateObject().Count() != 2 ||
            !root.TryGetProperty("passwordHash", out var hash) || hash.ValueKind != JsonValueKind.String ||
            !root.TryGetProperty("sessionSecret", out var secret) || secret.ValueKind != JsonValueKind.String)
        {
            throw new InvalidDataException("Credential helper returned invalid output.");
        }
        return new GeneratedCredentials(hash.GetString()!, secret.GetString()!);
    }

    private static async Task<string> ReadBoundedAsync(StreamReader reader, int limit, CancellationToken cancellationToken)
    {
        var result = new StringBuilder();
        var buffer = new char[1024];
        while (true)
        {
            var read = await reader.ReadAsync(buffer.AsMemory(), cancellationToken);
            if (read == 0) return result.ToString();
            if (result.Length + read > limit) throw new InvalidDataException("Credential helper output exceeded its limit.");
            result.Append(buffer, 0, read);
        }
    }
}
