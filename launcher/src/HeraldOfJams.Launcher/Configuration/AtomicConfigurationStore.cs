using System.Text;

namespace HeraldOfJams.Launcher.Configuration;

public interface IConfigurationActivator
{
    void Replace(string candidatePath, string activePath);
}

internal sealed class FileConfigurationActivator : IConfigurationActivator
{
    public void Replace(string candidatePath, string activePath) => File.Move(candidatePath, activePath, overwrite: true);
}

public sealed class AtomicConfigurationStore
{
    private readonly string activePath;
    private readonly IConfigurationActivator activator;

    public AtomicConfigurationStore(string activePath, IConfigurationActivator? activator = null)
    {
        this.activePath = activePath;
        this.activator = activator ?? new FileConfigurationActivator();
    }

    public async Task<ConfigurationCandidate> StageAsync(string contents)
    {
        var directory = Path.GetDirectoryName(activePath) ?? throw new ArgumentException("Configuration path must have a directory.");
        Directory.CreateDirectory(directory);
        var candidatePath = Path.Combine(directory, $".{Path.GetFileName(activePath)}.{Guid.NewGuid():N}.candidate");
        await File.WriteAllTextAsync(candidatePath, contents, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
        return new ConfigurationCandidate(activePath, candidatePath, $"{activePath}.rollback", activator);
    }
}

public sealed class ConfigurationCandidate
{
    private readonly string activePath;
    private readonly string candidatePath;
    private readonly string rollbackPath;
    private readonly IConfigurationActivator activator;
    private bool activated;
    private bool finished;

    internal ConfigurationCandidate(string activePath, string candidatePath, string rollbackPath, IConfigurationActivator activator)
    {
        this.activePath = activePath;
        this.candidatePath = candidatePath;
        this.rollbackPath = rollbackPath;
        this.activator = activator;
    }

    public void Activate()
    {
        EnsureOpen();
        if (File.Exists(activePath)) File.Copy(activePath, rollbackPath, overwrite: true);
        else File.Delete(rollbackPath);
        try
        {
            activator.Replace(candidatePath, activePath);
            activated = true;
        }
        catch
        {
            File.Delete(candidatePath);
            File.Delete(rollbackPath);
            finished = true;
            throw;
        }
    }

    public void Commit()
    {
        EnsureOpen();
        File.Delete(candidatePath);
        File.Delete(rollbackPath);
        finished = true;
    }

    public void Rollback()
    {
        EnsureOpen();
        if (activated)
        {
            if (File.Exists(rollbackPath)) File.Move(rollbackPath, activePath, overwrite: true);
            else File.Delete(activePath);
        }
        File.Delete(candidatePath);
        File.Delete(rollbackPath);
        finished = true;
    }

    private void EnsureOpen()
    {
        if (finished) throw new InvalidOperationException("Configuration candidate is already complete.");
    }
}
