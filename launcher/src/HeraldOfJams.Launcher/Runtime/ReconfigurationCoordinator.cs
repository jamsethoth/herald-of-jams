using HeraldOfJams.Launcher.Configuration;

namespace HeraldOfJams.Launcher.Runtime;

public sealed record ReconfigurationResult(bool Success, bool RolledBack, bool Recovered, string? FailureClass = null, string? RollbackFailureClass = null);

public sealed class ReconfigurationCoordinator(AtomicConfigurationStore store, ICredentialGenerator credentials, IBotLifecycle lifecycle)
{
    public async Task<ReconfigurationResult> ApplyAsync(SetupInput input, CancellationToken token)
    {
        var issues = SetupValidator.Validate(input);
        if (issues.Count > 0) return new ReconfigurationResult(false, false, false, "Validation");
        ConfigurationCandidate? candidate = null;
        var activated = false;
        var shutdownBegan = false;
        try
        {
            var generated = await credentials.GenerateAsync(input.AdminPassword, token);
            var contents = EnvFileSerializer.Serialize(new ValidatedSetup(input.DiscordToken, input.ApplicationId, input.GuildId, input.AdminPort), generated);
            candidate = await store.StageAsync(contents);
            shutdownBegan = true;
            await lifecycle.StopAsync(token);
            candidate.Activate();
            activated = true;
            if (await lifecycle.StartAsync(token)) { candidate.Commit(); return new ReconfigurationResult(true, false, true); }
            return await RollBackAsync(candidate, "CandidateStartup");
        }
        catch (Exception error)
        {
            if (activated && candidate is not null)
            {
                var result = await RollBackAsync(candidate, error.GetType().Name);
                if (error is OperationCanceledException) throw;
                return result;
            }

            candidate?.Rollback();
            var recovered = false;
            string? recoveryFailureClass = null;
            if (shutdownBegan)
            {
                try { recovered = await lifecycle.StartAsync(CancellationToken.None); }
                catch (Exception recoveryError) { recoveryFailureClass = recoveryError.GetType().Name; }
            }
            if (error is OperationCanceledException) throw;
            return new ReconfigurationResult(false, false, recovered, error.GetType().Name, recoveryFailureClass);
        }
    }

    private async Task<ReconfigurationResult> RollBackAsync(ConfigurationCandidate candidate, string failureClass)
    {
        string? stopFailureClass = null;
        try { await lifecycle.StopAsync(CancellationToken.None); }
        catch (Exception error)
        {
            stopFailureClass = error.GetType().Name;
        }

        try { candidate.Rollback(); }
        catch (Exception error)
        {
            return new ReconfigurationResult(false, false, false, failureClass, error.GetType().Name);
        }

        if (stopFailureClass is not null)
            return new ReconfigurationResult(false, true, false, failureClass, stopFailureClass);

        try
        {
            var recovered = await lifecycle.StartAsync(CancellationToken.None);
            return new ReconfigurationResult(false, true, recovered, failureClass, recovered ? null : "RollbackStartup");
        }
        catch (Exception error)
        {
            return new ReconfigurationResult(false, true, false, failureClass, error.GetType().Name);
        }
    }
}
