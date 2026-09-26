using System.Net.Http.Json;
using System.Text.Json.Serialization;

namespace HeraldOfJams.Launcher.Runtime;

public interface IBotHealthProbe { Task<string?> ProbeAsync(int port, CancellationToken token); }

public sealed class BotHealthProbe(HttpClient client) : IBotHealthProbe
{
    public async Task<string?> ProbeAsync(int port, CancellationToken token)
    {
        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(token);
            timeout.CancelAfter(TimeSpan.FromMilliseconds(400));
            var result = await client.GetFromJsonAsync<HealthResponse>($"http://127.0.0.1:{port}/health", timeout.Token);
            return result is not null && result.Status is "starting" or "reconciling" or "ready" or "degraded" ? result.Status : null;
        }
        catch (HttpRequestException) { return null; }
        catch (OperationCanceledException) when (!token.IsCancellationRequested) { return null; }
    }

    private sealed record HealthResponse([property: JsonPropertyName("status")] string Status);
}
