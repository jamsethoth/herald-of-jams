using HeraldOfJams.Launcher.Runtime;
using Xunit;

namespace HeraldOfJams.Launcher.Tests;

public sealed class RotatingLogWriterTests
{
    [Fact]
    public async Task RedactsBothStreamsAndKeepsAtMostFiveBoundedFiles()
    {
        var directory = Path.Combine(Path.GetTempPath(), $"herald-logs-{Guid.NewGuid():N}");
        Directory.CreateDirectory(directory);
        try
        {
            {
                await using var writer = new RotatingLogWriter(directory, ["token-value", "hash-value", "secret-value"], maximumBytes: 80, maximumFiles: 5);
                for (var index = 0; index < 30; index++)
                {
                    await writer.WriteAsync("stdout", $"{index}: token-value hash-value");
                    await writer.WriteAsync("stderr", $"{index}: secret-value");
                }
                await writer.FlushAsync();
            }
            var files = Directory.GetFiles(directory);
            Assert.InRange(files.Length, 1, 5);
            var text = string.Concat(files.Select(File.ReadAllText));
            Assert.DoesNotContain("token-value", text);
            Assert.DoesNotContain("hash-value", text);
            Assert.DoesNotContain("secret-value", text);
            Assert.Contains("[REDACTED]", text);
        }
        finally { Directory.Delete(directory, recursive: true); }
    }
}
