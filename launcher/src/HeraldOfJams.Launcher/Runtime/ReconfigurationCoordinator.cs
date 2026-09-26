using HeraldOfJams.Launcher.Configuration;

namespace HeraldOfJams.Launcher.Runtime;

public sealed record ReconfigurationResult(bool Success, bool RolledBack, bool Recovered, string? FailureClass = null, string? RollbackFailureClass = null);

public sealed class ReconfigurationCoordinator(AtomicConfigurationStore store, ICredentialGenerator credentials, IBotLifecycle lifecycle)
{
    public async Task<ReconfigurationResult> ApplyAsync(SetupInput input, CancellationToken token)
    {
        var issues = SetupValidator.Validate(input);
        if (issues.Count > 0) return new ReconfigurationResult(false, false, false, "Validation");
        try
        {
            var generated = await credentials.GenerateAsync(input.AdminPassword, token);
            var contents = EnvFileSerializer.Serialize(new ValidatedSetup(input.DiscordToken, input.ApplicationId, input.GuildId, input.AdminPort), generated);
            var candidate = await store.StageAsync(contents);
            await lifecycle.StopAsync(token);
            candidate.Activate();
            if (await lifecycle.StartAsync(token)) { candidate.Commit(); return new ReconfigurationResult(true, false, true); }
            await lifecycle.StopAsync(token);
            candidate.Rollback();
            var recovered = await lifecycle.StartAsync(token);
            return new ReconfigurationResult(false, true, recovered, "CandidateStartup", recovered ? null : "RollbackStartup");
        }
        catch (Exception error) when (error is not OperationCanceledException)
        {
            return new ReconfigurationResult(false, false, false, error.GetType().Name);
        }
    }
}
