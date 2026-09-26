using HeraldOfJams.Launcher.Runtime;
using Xunit;

namespace HeraldOfJams.Launcher.Tests;

public sealed class BrowserLaunchTests
{
    [Theory]
    [InlineData(1, "http://127.0.0.1:1/admin")]
    [InlineData(65535, "http://127.0.0.1:65535/admin")]
    public void AdministrationUriIsFixedToLoopbackAndAdminPath(int port, string expected) =>
        Assert.Equal(expected, AdministrationLauncher.BuildUri(port).AbsoluteUri.TrimEnd('/'));

    [Theory]
    [InlineData(0)]
    [InlineData(65536)]
    public void AdministrationUriRejectsInvalidPorts(int port) =>
        Assert.Throws<ArgumentOutOfRangeException>(() => AdministrationLauncher.BuildUri(port));

    [Fact]
    public void AdministrationIsDisabledUntilRunning()
    {
        Assert.False(AdministrationLauncher.CanOpen(LauncherState.Starting));
        Assert.False(AdministrationLauncher.CanOpen(LauncherState.AttentionRequired));
        Assert.True(AdministrationLauncher.CanOpen(LauncherState.Running));
    }
}
