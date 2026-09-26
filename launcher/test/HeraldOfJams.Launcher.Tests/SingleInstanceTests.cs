using HeraldOfJams.Launcher.Runtime;
using Xunit;

namespace HeraldOfJams.Launcher.Tests;

public sealed class SingleInstanceTests
{
    [Fact]
    public async Task SecondarySignalsExactlyOnePrimaryAndOwnershipRecovers()
    {
        var name = $"HeraldOfJams-Test-{Guid.NewGuid():N}";
        var signals = 0;
        await using (var primary = new SingleInstanceCoordinator(name, () => { Interlocked.Increment(ref signals); return Task.CompletedTask; }))
        await using (var secondary = new SingleInstanceCoordinator(name, () => Task.CompletedTask))
        {
            Assert.True(primary.TryBecomePrimary());
            Assert.False(secondary.TryBecomePrimary());
            await secondary.SignalOpenAdministrationAsync();
            for (var count = 0; count < 100 && signals == 0; count++) await Task.Delay(10);
            Assert.Equal(1, signals);
        }

        await using var recovered = new SingleInstanceCoordinator(name, () => Task.CompletedTask);
        Assert.True(recovered.TryBecomePrimary());
    }
}
